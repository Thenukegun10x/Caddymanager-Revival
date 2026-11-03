#!/usr/bin/env bash
# scripts/lib/common.sh — shared helpers for the release tooling.
# Sourced by scripts/release.sh and scripts/verify-release.sh. No side effects.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPS=(backend frontend)
# Native arm64 host used for the mandatory linux/arm64 build gate.
ARM_HOST="${ARM_HOST:-ubuntuvm}"

if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_OFF=""
fi

info()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
step()  { printf '\n%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok()    { printf '%s  OK%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn()  { printf '%s  !!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
detail(){ printf '%s     %s%s\n' "$C_DIM" "$*" "$C_OFF"; }
die()   { printf '%s  FAIL%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# pkg_version <app> — version field from <app>/package.json
pkg_version() {
  node -p "require('${ROOT_DIR}/$1/package.json').version"
}

# lock_version <app> — version recorded in the lockfile root entry
lock_version() {
  node -e "
    const l = require('${ROOT_DIR}/$1/package-lock.json');
    const v = (l.packages && l.packages[''] && l.packages[''].version) || l.version;
    process.stdout.write(String(v || ''));
  "
}

# repo_slug — owner/name derived from the origin remote (gh defaults to the
# upstream fork parent otherwise, which is exactly the wrong repo).
repo_slug() {
  local url
  url="$(git -C "$ROOT_DIR" remote get-url origin)"
  printf '%s' "$url" | sed -E 's#(git@|https://)github\.com[:/]##; s#\.git$##'
}

# last_release_tag — most recent v-prefixed tag, empty when there is none
last_release_tag() {
  git -C "$ROOT_DIR" describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true
}

is_semver() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]
}

# semver_gt A B — true when A is strictly greater than B
semver_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# changelog_section <version> [range] — emits a Keep-a-Changelog section built
# from conventional commits. Prints to stdout; does not touch the file.
changelog_section() {
  local version="$1" range="${2:-}" tmp
  if [ -z "$range" ]; then
    local base; base="$(last_release_tag)"
    range="${base:+$base..}HEAD"
  fi
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  local subject
  while IFS= read -r subject || [ -n "$subject" ]; do
    [ -n "$subject" ] || continue
    case "$subject" in
      Merge\ *) continue ;;
    esac

    local kind="other" body="$subject"
    if [[ "$subject" =~ ^([a-zA-Z]+)(\([^\)]*\))?!:\ (.*)$ ]]; then
      kind="breaking"; body="${BASH_REMATCH[3]}"
    elif [[ "$subject" =~ ^([a-zA-Z]+)(\([^\)]*\))?:\ (.*)$ ]]; then
      body="${BASH_REMATCH[3]}"
      case "${BASH_REMATCH[1],,}" in
        feat)                 kind="added" ;;
        fix)                  kind="fixed" ;;
        perf|refactor|style)  kind="changed" ;;
        security|sec)         kind="security" ;;
        *)                    kind="other" ;;
      esac
    fi
    printf -- '- %s\n' "$body" >> "$tmp/$kind"
  done < <(git -C "$ROOT_DIR" log --no-merges --pretty=format:'%s' "$range")

  printf '## [%s] - %s\n' "$version" "$(date -u +%Y-%m-%d)"
  local key heading
  for key in breaking added changed fixed security other; do
    [ -s "$tmp/$key" ] || continue
    case "$key" in
      breaking) heading="### Breaking Changes" ;;
      added)    heading="### Added" ;;
      changed)  heading="### Changed" ;;
      fixed)    heading="### Fixed" ;;
      security) heading="### Security" ;;
      other)    heading="### Other" ;;
    esac
    printf '\n%s\n' "$heading"
    cat "$tmp/$key"
  done
  printf '\n'
}

# prepend_changelog <version> [range] — writes the new section under the header.
prepend_changelog() {
  local version="$1" range="${2:-}" file="$ROOT_DIR/CHANGELOG.md" section header
  section="$(changelog_section "$version" "$range")"
  header='# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut with `scripts/release.sh`; see [RELEASING.md](RELEASING.md).
'
  if [ -f "$file" ]; then
    # Drop the old preamble (everything before the first "## ["), keep history.
    local history
    history="$(awk '/^## \[/{found=1} found' "$file")"
    { printf '%s\n' "$header"; printf '%s\n\n' "$section"; printf '%s\n' "$history"; } > "$file.tmp"
    mv "$file.tmp" "$file"
  else
    { printf '%s\n' "$header"; printf '%s\n' "$section"; } > "$file"
  fi
}

# changelog_extract <version> — prints the section body for a released version.
changelog_extract() {
  local version="$1" file="$ROOT_DIR/CHANGELOG.md"
  [ -f "$file" ] || return 1
  awk -v ver="$version" '
    /^## \[/ {
      if (found) exit
      if (index($0, "## [" ver "]") == 1) { found=1; next }
    }
    found { print }
  ' "$file" | sed -e '/./,$!d'
}

# dk <host|""> <docker args...> — run docker locally, or against a remote
# daemon over SSH (the build context is streamed by the docker CLI).
dk() {
  local host="$1"; shift
  if [ -n "$host" ]; then
    docker -H "ssh://$host" "$@"
  else
    docker "$@"
  fi
}

# image_platform <host|""> <image> — reports os/arch the daemon sees
image_platform() {
  dk "$1" image inspect --format '{{.Os}}/{{.Architecture}}' "$2"
}
