#!/usr/bin/env bash
# scripts/verify-release.sh — release invariants + mandatory dual-arch gate.
#
# Usage:
#   scripts/verify-release.sh [--tag vX.Y.Z] [--build] [--registry] [--apps backend,frontend]
#
# Checks (always):
#   * backend and frontend versions match and match their lockfiles
#   * tag (when given) is semver, exists, equals the package version, and is on main
#   * CHANGELOG.md contains a section for the version
#
# --build     Builds linux/amd64 locally and linux/arm64 on $ARM_HOST (default
#             ubuntuvm), then smoke-tests both images. This is the gate that
#             must pass before a release tag is pushed.
# --registry  Verifies the published manifest lists contain linux/amd64 AND
#             linux/arm64, and that :latest points at the same digest as the
#             version tag (Docker Hub + GHCR).
#
# Exit code 0 = every requested gate passed. Any failure exits 1.

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TAG=""
DO_BUILD=0
DO_REGISTRY=0
APP_FILTER=""

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)       TAG="${2:?--tag needs a value}"; shift 2 ;;
    --tag=*)     TAG="${1#*=}"; shift ;;
    --build)     DO_BUILD=1; shift ;;
    --registry)  DO_REGISTRY=1; shift ;;
    --apps)      APP_FILTER="${2:?--apps needs a value}"; shift 2 ;;
    --apps=*)    APP_FILTER="${1#*=}"; shift ;;
    -h|--help)   usage 0 ;;
    *)           die "unknown argument: $1 (try --help)" ;;
  esac
done

cd "$ROOT_DIR"

selected_apps=("${APPS[@]}")
if [ -n "$APP_FILTER" ]; then
  IFS=',' read -r -a selected_apps <<< "$APP_FILTER"
  for app in "${selected_apps[@]}"; do
    case "$app" in backend|frontend) ;; *) die "--apps accepts only backend,frontend (got '$app')" ;; esac
  done
fi

FAILURES=0
fail() { printf '%s  FAIL%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { ok "$*"; }

# ── 1. Version invariants ────────────────────────────────────────────────────
step "Version invariants"

VERSIONS=()
for app in "${APPS[@]}"; do
  v="$(pkg_version "$app")"
  lv="$(lock_version "$app")"
  VERSIONS+=("$v")
  is_semver "$v" || fail "$app/package.json version '$v' is not semver"
  [ "$v" = "$lv" ] && pass "$app version $v (lockfile in sync)" \
    || fail "$app lockfile version '$lv' != package.json '$v'"
done
[ "${VERSIONS[0]}" = "${VERSIONS[1]}" ] \
  && pass "backend and frontend share version ${VERSIONS[0]}" \
  || fail "backend (${VERSIONS[0]}) and frontend (${VERSIONS[1]}) versions differ — one product version required"
VERSION="${VERSIONS[0]}"

if changelog_extract "$VERSION" | grep -q '[^[:space:]]'; then
  pass "CHANGELOG.md has notes for $VERSION"
else
  fail "CHANGELOG.md has no non-empty section for $VERSION"
fi

# ── 2. Tag invariants ────────────────────────────────────────────────────────
if [ -n "$TAG" ]; then
  step "Tag invariants ($TAG)"
  if ! is_semver "${TAG#v}"; then
    fail "tag '$TAG' is not vMAJOR.MINOR.PATCH"
  elif [ "v$VERSION" != "$TAG" ]; then
    fail "tag '$TAG' != v$VERSION from package.json — bump before tagging"
  else
    pass "tag matches package version v$VERSION"
  fi

  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    pass "tag $TAG exists locally"
    tag_commit="$(git rev-list -n1 "$TAG")"
    base_ref="origin/main"
    git rev-parse -q --verify "$base_ref" >/dev/null || base_ref="main"
    if git merge-base --is-ancestor "$tag_commit" "$base_ref"; then
      pass "tag commit ${tag_commit:0:8} is on $base_ref"
    else
      fail "tag commit ${tag_commit:0:8} is NOT an ancestor of $base_ref"
    fi
  else
    fail "tag $TAG does not exist locally"
  fi

  if changelog_extract "$VERSION" | grep -q '[^[:space:]]'; then
    pass "CHANGELOG.md has a section for $VERSION"
  else
    fail "CHANGELOG.md has no non-empty section for $VERSION"
  fi
fi

# ── 3. Dual-arch build gate ──────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  step "Dual-arch build gate (amd64 local + arm64 on $ARM_HOST)"
  local_arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  [ "$local_arch" = "amd64" ] || fail "local daemon is '$local_arch', expected amd64"

  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$ARM_HOST" true 2>/dev/null; then
    remote_arch="$(ssh -o BatchMode=yes "$ARM_HOST" 'docker version --format "{{.Server.Arch}}"' 2>/dev/null || true)"
    [ "$remote_arch" = "arm64" ] && pass "$ARM_HOST reachable, docker reports arm64" \
      || fail "$ARM_HOST docker reports '$remote_arch', expected arm64"
  else
    fail "cannot reach $ARM_HOST over SSH (BatchMode) — arm64 gate cannot run"
  fi

  git_sha="$(git rev-parse HEAD)"
  git_branch="$(git rev-parse --abbrev-ref HEAD)"
  build_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  for app in "${selected_apps[@]}"; do
    for spec in "amd64|" "arm64|$ARM_HOST"; do
      platform="${spec%%|*}"
      host="${spec#*|}"
      image="caddymanager-release-verify-$app:$platform"
      label="$platform${host:+ via $host}"

      info "building $app for linux/$platform${host:+ on $host}"
      if dk "$host" build --platform "linux/$platform" \
          --build-arg "BUILD_NUMBER=verify" \
          --build-arg "GIT_COMMIT=$git_sha" \
          --build-arg "GIT_BRANCH=$git_branch" \
          --build-arg "BUILD_DATE=$build_date" \
          -t "$image" "$ROOT_DIR/$app" >"/tmp/verify-$app-$platform.log" 2>&1; then
        pass "$app linux/$platform built ($label)"
      else
        fail "$app linux/$platform build failed ($label) — see /tmp/verify-$app-$platform.log"
        continue
      fi

      actual="$(image_platform "$host" "$image" 2>/dev/null || echo unknown)"
      [ "$actual" = "linux/$platform" ] && pass "$app image platform $actual" \
        || fail "$app image platform '$actual' != linux/$platform"

      if [ "$app" = "backend" ]; then
        if out="$(dk "$host" run --rm --entrypoint node "$image" -e "
              const b = require('./build-info.json');
              if (b.version !== '$VERSION') { console.error('version ' + b.version); process.exit(1); }
              const D = require('better-sqlite3');
              const db = new D(':memory:');
              if (db.prepare('select 1 as v').get().v !== 1) process.exit(1);
              db.close();
              console.log(b.version);
            " 2>&1)"; then
          pass "$app runs on $platform (version $out, sqlite ok)"
        else
          fail "$app smoke test failed on $platform: $out"
        fi
      else
        if dk "$host" run --rm --entrypoint caddy "$image" validate \
             --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
          pass "$app config validates on $platform"
        else
          fail "$app config validation failed on $platform"
        fi
      fi
    done
  done
fi

# ── 4. Registry manifest gate ────────────────────────────────────────────────
if [ "$DO_REGISTRY" -eq 1 ]; then
  step "Registry manifest gate ($VERSION)"
  slug="$(repo_slug | tr '[:upper:]' '[:lower:]')"
  declare -A IMAGES=(
    [backend]="conormorris/caddymanager-backend ghcr.io/$slug-backend"
    [frontend]="conormorris/caddymanager-frontend ghcr.io/$slug-frontend"
  )

  for app in "${selected_apps[@]}"; do
    for repo in ${IMAGES[$app]}; do
      ref="$repo:$VERSION"
      arches="$(docker manifest inspect "$ref" 2>/dev/null \
        | jq -r 'if .manifests then .manifests[].platform.architecture else .architecture end' \
        | sort -u | tr '\n' ' ' || true)"
      if [ -z "$arches" ]; then
        fail "$ref not found or unreadable"
        continue
      fi
      case " $arches " in *" amd64 "*) pass "$ref has amd64" ;; *) fail "$ref missing amd64 (got: $arches)" ;; esac
      case " $arches " in *" arm64 "*) pass "$ref has arm64" ;; *) fail "$ref missing arm64 (got: $arches)" ;; esac

      if latest_arches="$(docker manifest inspect "$repo:latest" 2>/dev/null | jq -r '.manifests[].platform.architecture' | sort -u | tr '\n' ' ')"; then
        case " $latest_arches " in *" amd64 "*) ;; *) fail "$repo:latest missing amd64 (got: $latest_arches)" ;; esac
        case " $latest_arches " in *" arm64 "*) ;; *) fail "$repo:latest missing arm64 (got: $latest_arches)" ;; esac
        v_digest="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null | sha256sum | cut -d' ' -f1)"
        l_digest="$(docker buildx imagetools inspect --raw "$repo:latest" 2>/dev/null | sha256sum | cut -d' ' -f1)"
        if [ -n "$v_digest" ] && [ "$v_digest" = "$l_digest" ]; then
          pass "$repo:latest == $VERSION (${v_digest:0:12})"
        else
          fail "$repo:latest does not point at $VERSION (latest ${l_digest:0:12} != ${v_digest:0:12})"
        fi
      else
        fail "$repo:latest is missing — every published release must retag latest"
      fi
    done
  done
fi

# ── Summary ──────────────────────────────────────────────────────────────────
if [ "$FAILURES" -ne 0 ]; then
  printf '\n%s%d release check(s) failed%s\n' "$C_RED" "$FAILURES" "$C_OFF" >&2
  exit 1
fi
printf '\n%sAll release checks passed%s (version %s%s)\n' "$C_GREEN" "$C_OFF" "$VERSION" "${TAG:+, tag $TAG}"
