# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut with `scripts/release.sh`; see [RELEASING.md](RELEASING.md).

## [0.1.1] - 2026-11-03

### Added
- add opt-in agent surface
- tag-driven release flow with dual-arch gate

### Fixed
- stop doubling the image name when templating tags

### Other
- point Last verified at current main (6484ba32)
- record the v0.1-hardened.1 release state in AGENTS.md

## [0.1.0] - 2026-11-02

First hardened release of the Revival fork. Built from `3354a206`, published as
`v0.1-hardened.1`, and mirrored to Docker Hub and GHCR for `linux/amd64` and
`linux/arm64`.

### Security

- CRITICAL: refuse to boot with a missing, short, or placeholder `JWT_SECRET`.
- CRITICAL: bootstrap the first admin from `ADMIN_PASSWORD`; the `caddyrocks` default is gone.
- CRITICAL: replace the SSRF prefix regex with CIDR checks plus connect-time DNS validation.
- CRITICAL: hash passwords on every Mongo update path.
- CRITICAL: enforce API-key permissions on every route; store only `sha256(key)` with a `keyPrefix`.
- CRITICAL: derive configuration access from server ownership and filter bulk status by owner.
- HIGH: gate metrics/build-info behind admin auth; correlation IDs instead of stack traces.
- HIGH: require a 12+ character password policy and a linear-time email validator.
- HIGH: drop the JWT from the login response body and the `localStorage` fallback; use `httpOnly` cookies.
- HIGH: ship only production dependencies in the runtime image.
- MEDIUM: remove eval-based JSON editing and HTTP HSTS; tighten CSP.
- MEDIUM: revoke active JWTs on logout; add login throttling and `no-store` auth responses.
- MEDIUM: verify audit-log integrity with a hash chain.
- MEDIUM: restrict private Caddy targets to an exact hostname allowlist (`ALLOW_PRIVATE_HOSTS`).

### Added

- `docker-compose.mongodb.yml` overlay with loopback-only MongoDB.
- Verifiable hash-chained audit logs (`M7`).
- Security regression suites: SSRF, API-key storage/permissions, audit integrity, input validation, error handling.
- Consolidated release tooling (`scripts/release.sh`, `scripts/verify-release.sh`).

### Changed

- Backend and frontend images now build on Node 22 / Debian 13 (`trixie`) with a non-root runtime.
- CI gates: SQLite Jest, frontend build, `npm audit`, security grep, Trivy, and Compose validation.
- Documentation repositions the Revival fork as the maintained successor to upstream.

### Fixed

- Mongo engine test parity and database readiness before the server listens.
- Trivy SARIF upload categories and severity filtering.
- Background timers no longer keep Jest or CI alive.

[0.1.0]: https://github.com/Thenukegun10x/Caddymanager-Revival/releases/tag/v0.1-hardened.1
