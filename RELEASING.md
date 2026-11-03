# Releasing Caddy Manager

The release process is deliberately boring and auditable. One product version,
one tag, two architectures, one `latest`.

```
feature branch ──► PR ──► CI green ──► merge to main
                                          │
                                          ├─► :edge + :sha-<commit>   (continuous, no latest)
                                          │
                                          ▼
                              scripts/release.sh patch
                    bump both packages + CHANGELOG + gates + commit + tag
                                          │
                                          ▼
                                     git push v0.1.1
                                          │
                                          ├─► preflight   (version == tag, tag on main, notes exist)
                                          ├─► build/push  amd64 + arm64 for backend & frontend
                                          ├─► verify      both arches in the manifest, latest == version
                                          └─► release     GitHub Release from the CHANGELOG section
```

## Cutting a release

```bash
git switch main && git pull --ff-only
scripts/release.sh patch --dry-run     # see the plan, change nothing
scripts/release.sh patch               # bump, changelog, gates, commit, tag
scripts/release.sh patch --push        # same, then push main + tag
```

`patch` / `minor` / `major` derive the next version from `package.json`. You can
also pass an explicit version (`scripts/release.sh 0.2.0`). The script:

1. requires a clean `main` that matches `origin/main`;
2. requires CI to be green on `HEAD` (`--skip-ci` exists but is not release-safe);
3. bumps `backend/package.json`, `frontend/package.json` and both lockfiles to the same version;
4. prepends a Keep-a-Changelog section built from conventional commits since the last tag;
5. builds `linux/amd64` locally and `linux/arm64` on `ssh ubuntuvm`, then smoke-tests both images;
6. runs the backend Jest suite;
7. commits `chore(release): vX.Y.Z` and creates the annotated tag `vX.Y.Z`.

If any gate fails, the bump is rolled back — you never end up with a half-released tree.

## Verifying a published release

```bash
scripts/verify-release.sh --tag v0.1.1 --registry
```

This is the same check CI runs after publishing:

- `backend` and `frontend` versions match their lockfiles and each other;
- the tag is semver, equals the package version, and its commit is on `main`;
- `CHANGELOG.md` has a non-empty section for the version;
- Docker Hub **and** GHCR manifests contain `linux/amd64` **and** `linux/arm64`;
- `:latest` resolves to the exact same manifest digest as `:X.Y.Z`.

## Image tags

| Trigger | Tags published |
|---------|----------------|
| push to `develop` | `:next`, `:sha-<commit>` |
| push to `main` | `:edge`, `:sha-<commit>` |
| tag `vX.Y.Z` | `:X.Y.Z`, `:X.Y`, `:latest`, `:stable`, `:sha-<commit>` |

`:latest` moves **only** on a release tag and always carries every architecture.
It is never a branch alias.

## Non-negotiables

- Never publish a release without the native `linux/arm64` build on `ubuntuvm`.
  QEMU cross-builds are fine for PR smoke tests, not for a release gate.
- Never move `:latest` with `docker pull && docker tag && docker push` — that
  flattens the multi-arch index to the local platform. Use
  `docker buildx imagetools create -t dst src`.
- Never tag a commit that is not on `main`, and never reuse a version.
- If a release is broken after publishing, cut the next patch version. Do not
  retag or overwrite an existing version.
