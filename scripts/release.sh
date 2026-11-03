#!/usr/bin/env bash
# scripts/release.sh — cut a release: bump both packages, write CHANGELOG.md,
# run the gates, commit and tag. Pushing is opt-in via --push.
#
# Usage:
#   scripts/release.sh patch|minor|major        # or an explicit X.Y.Z
#   scripts/release.sh patch --push             # commit + tag + push (triggers publish)
#
# Options:
#   --push              push the release commit and tag to origin (default: print only)
#   --skip-arch-gate    skip the amd64+arm64 build gate (NOT allowed for real releases)
#   --skip-tests        skip the backend jest suite
#   --skip-ci           skip the "CI green on HEAD" check
#   --no-fetch          do not fetch/require origin/main parity
#   --dry-run           run preflight only; show the version and commits, change nothing
#   -y, --yes           do not prompt for confirmation
#
# Rules enforced here (see AGENTS.md §10):
#   * one product version, backend == frontend == lockfiles
#   * tag is vX.Y.Z and lives on main
#   * CHANGELOG.md has a section for the version
#   * both linux/amd64 and linux/arm64 builds pass a smoke test before the tag moves

# shellcheck source=lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

BUMP=""
PUSH=0
SKIP_ARCH=0
SKIP_TESTS=0
SKIP_CI=0
DO_FETCH=1
DRY_RUN=0
ASSUME_YES=0

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --push)           PUSH=1; shift ;;
    --skip-arch-gate) SKIP_ARCH=1; shift ;;
    --skip-tests)     SKIP_TESTS=1; shift ;;
    --skip-ci)        SKIP_CI=1; shift ;;
    --no-fetch)       DO_FETCH=0; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    -h|--help)        usage 0 ;;
    -*)               die "unknown option: $1 (try --help)" ;;
    *)
      [ -z "$BUMP" ] || die "unexpected argument: $1"
      BUMP="$1"; shift ;;
  esac
done
[ -n "$BUMP" ] || usage 1

cd "$ROOT_DIR"

# ── Rollback guard: a failed gate must not leave a half-applied bump ─────────
ROLLBACK=0
CHANGELOG_WAS_TRACKED=0
if git ls-files --error-unmatch CHANGELOG.md >/dev/null 2>&1; then
  CHANGELOG_WAS_TRACKED=1
fi
cleanup() {
  if [ "$ROLLBACK" -eq 1 ]; then
    warn "rolling back the version bump (no commit was created)"
    git checkout -- . 2>/dev/null || true
    [ "$CHANGELOG_WAS_TRACKED" -eq 1 ] || rm -f CHANGELOG.md
  fi
}
trap cleanup EXIT

# ── 1. Preflight ────────────────────────────────────────────────────────────
step "Preflight"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "releases must be cut from main (currently on '$branch')"

dirty="$(git status --porcelain --untracked-files=no)"
if [ -n "$dirty" ]; then
  warn "working tree has uncommitted tracked changes:"
  printf '%s\n' "$dirty" >&2
  die "commit or stash them first"
fi

if [ "$DO_FETCH" -eq 1 ]; then
  info "fetching origin"
  git fetch --quiet origin main
  head_sha="$(git rev-parse HEAD)"
  origin_sha="$(git rev-parse origin/main)"
  [ "$head_sha" = "$origin_sha" ] \
    || die "HEAD (${head_sha:0:8}) is not origin/main (${origin_sha:0:8}); pull/push first"
  ok "HEAD matches origin/main (${head_sha:0:8})"
fi

backend_v="$(pkg_version backend)"
frontend_v="$(pkg_version frontend)"
[ "$backend_v" = "$frontend_v" ] \
  || die "backend ($backend_v) and frontend ($frontend_v) versions differ; align them first"
CURRENT="$backend_v"

case "$BUMP" in
  major) NEW="$(( ${CURRENT%%.*} + 1 )).0.0" ;;
  minor) IFS=. read -r MA MI PA <<< "$CURRENT"; NEW="$MA.$((MI + 1)).0" ;;
  patch) IFS=. read -r MA MI PA <<< "$CURRENT"; NEW="$MA.$MI.$((PA + 1))" ;;
  *)     NEW="$BUMP" ;;
esac

is_semver "$NEW" || die "'$BUMP' did not produce a valid semver version ('$NEW')"
semver_gt "$NEW" "$CURRENT" || die "new version $NEW must be greater than current $CURRENT"
TAG="v$NEW"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists"
fi
ok "version $CURRENT -> $NEW (tag $TAG)"

LAST_TAG="$(last_release_tag)"
RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
commit_count="$(git rev-list --count "$RANGE")"
COMMITS="$(git log --no-merges --pretty=format:'  - %h %s' "$RANGE")"

if [ "$SKIP_CI" -eq 0 ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    slug="$(repo_slug)"
    ci_json="$(gh run list --repo "$slug" --workflow=ci.yml --commit "$(git rev-parse HEAD)" \
                 --limit 1 --json conclusion,status 2>/dev/null || echo '[]')"
    ci_state="$(jq -r '.[0].conclusion // "none"' <<< "$ci_json")"
    case "$ci_state" in
      success) ok "CI is green on HEAD ($slug)" ;;
      none)    die "no CI run found for HEAD on $slug; push and wait, or pass --skip-ci" ;;
      *)       die "CI on HEAD is '$ci_state'; fix it before releasing (or pass --skip-ci)" ;;
    esac
  else
    warn "gh CLI unavailable or not authenticated — skipping the CI-on-HEAD check"
  fi
else
  warn "CI-on-HEAD check skipped (--skip-ci)"
fi

step "Release plan"
printf '  %-16s %s\n' "version" "$CURRENT -> $NEW"
printf '  %-16s %s\n' "tag" "$TAG"
printf '  %-16s %s\n' "since" "${LAST_TAG:-<beginning>}"
printf '  %-16s %s commit(s)\n' "commits" "$commit_count"
if [ -n "$COMMITS" ]; then
  printf '%s\n' "$COMMITS"
fi
printf '  %-16s %s\n' "arch gate" "$([ "$SKIP_ARCH" -eq 1 ] && echo 'SKIPPED (not release-safe)' || echo "amd64 local + arm64 on $ARM_HOST")"
printf '  %-16s %s\n' "push" "$([ "$PUSH" -eq 1 ] && echo yes || echo 'no (print instructions)')"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n%sDry run — nothing changed.%s\n' "$C_DIM" "$C_OFF"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  [ -t 0 ] || die "not a TTY; re-run with --yes to confirm non-interactively"
  printf '\nContinue? [y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) die "aborted by user" ;; esac
fi

# ── 2. Bump both packages (package.json + lockfile) ─────────────────────────
step "Bumping packages to $NEW"
ROLLBACK=1
for app in "${APPS[@]}"; do
  ( cd "$ROOT_DIR/$app" && npm version "$NEW" --no-git-tag-version --allow-same-version >/dev/null )
  ok "$app -> $(pkg_version "$app")"
done

# ── 3. Changelog ────────────────────────────────────────────────────────────
step "Writing CHANGELOG.md"
prepend_changelog "$NEW" "$RANGE"
ok "added section for $NEW"

# ── 4. Gates ────────────────────────────────────────────────────────────────
step "Release verification"
verify_args=(--apps "backend,frontend")
[ "$SKIP_ARCH" -eq 1 ] || verify_args+=(--build)
"$ROOT_DIR/scripts/verify-release.sh" "${verify_args[@]}"

if [ "$SKIP_TESTS" -eq 0 ]; then
  step "Backend test suite"
  ( cd "$ROOT_DIR/backend" \
    && DB_ENGINE=sqlite NODE_ENV=test JWT_SECRET=release-gate-secret-at-least-32-chars \
       npm test -- --runInBand >/tmp/release-backend-tests.log 2>&1 ) \
    && ok "jest passed (see /tmp/release-backend-tests.log)" \
    || die "backend tests failed — see /tmp/release-backend-tests.log"
else
  warn "backend test suite skipped (--skip-tests)"
fi

if [ "$SKIP_ARCH" -eq 1 ]; then
  warn "ARM64 GATE SKIPPED — this tag must NOT be published. AGENTS.md §10 requires both arches."
fi

# ── 5. Commit + tag ─────────────────────────────────────────────────────────
step "Committing and tagging"
git add backend/package.json backend/package-lock.json \
        frontend/package.json frontend/package-lock.json CHANGELOG.md
git commit --quiet -m "chore(release): v$NEW"
git tag -a "$TAG" -m "v$NEW"
ROLLBACK=0
ok "commit $(git rev-parse --short HEAD), tag $TAG"

# ── 6. Push (opt-in) ────────────────────────────────────────────────────────
if [ "$PUSH" -eq 1 ]; then
  step "Pushing to origin"
  git push origin main
  git push origin "$TAG"
  ok "pushed main and $TAG — the publish workflow now builds amd64+arm64"
  printf '\nNext: watch the release\n  gh run watch --repo %s\n  scripts/verify-release.sh --tag %s --registry\n' \
    "$(repo_slug)" "$TAG"
else
  printf '\n%sRelease commit and tag are local only.%s Publish with:\n' "$C_YELLOW" "$C_OFF"
  printf '  git push origin main && git push origin %s\n' "$TAG"
  printf 'Then verify the published manifests:\n  scripts/verify-release.sh --tag %s --registry\n' "$TAG"
fi
