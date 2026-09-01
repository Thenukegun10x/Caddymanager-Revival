# CaddyManager Hardened Fork — Security & Maintenance Plan

> **Status 2026-09-01 11:15 UTC — `Thenukegun10x/Caddymanager-Revival@0c59a52f` (ahead of upstream `52f69b64` by 7 commits). P0 + H1/H3/H5 + DB auto-migrate live. `security-grep` PASS, `backend jest 170/170`, `pen test 28/28`, `npm audit 0/0`, `integrity_check: ok`.**

**Upstream:** `caddymanager/caddymanager` — https://github.com/caddymanager/caddymanager  
**Upstream commit pinned:** `52f69b64` (2025-09-07, `pushed_at:2026-02-20`) — `archived:false` per `api.github.com/repos/caddymanager/caddymanager` 2026-09-01, but stale (~6 months no pushes, 24 open issues).  
**License:** MIT (`LICENSE:4` Copyright 2025 B Stolk). Fork permitted if `LICENSE:15-17` notice preserved. Not affiliated with Caddy/Stack Holdings (`LICENSE:27`).  
**Stack:** MEVN — Vue 3 + Vite + Pinia, Node 22 Express, SQLite (default) / MongoDB, `better-sqlite3@13.0.3`, `mongoose@7.8.12`, `axios@1.20.0`, `jsonwebtoken@9.0.3`, Caddy 2 Admin API.  
**Local clone for review:** `/tmp/caddymanager` (114 commits, `git remote origin https://github.com/caddymanager/caddymanager.git`).  
**Fork:** `Thenukegun10x/Caddymanager-Revival` — https://github.com/Thenukegun10x/Caddymanager-Revival — `main:0c59a52f`

> This plan assumes you continue to self-host CaddyManager and want a safe, maintainable fork. If you prefer to decommission, jump to §9 Alternatives.

---

## Table of Contents
1. [Goals & Non-Goals](#1-goals--non-goals)
2. [How to Properly Create a Git Repo for Someone Else’s Project](#2-how-to-properly-create-a-git-repo-for-someone-elses-project)
3. [Current State Assessment](#3-current-state-assessment)
4. [Risk Summary (Verified)](#4-risk-summary-verified)
5. [Remediation Phases](#5-remediation-phases)
6. [Verification & Testing Strategy](#6-verification--testing-strategy)
7. [Branching, CI/CD, Release](#7-branching-cicd-release)
8. [Governance & Upstream Sync](#8-governance--upstream-sync)
9. [Alternatives](#9-alternatives)
10. [Timeline & Effort](#10-timeline--effort)
11. [Appendix A: Detailed Findings Index](#appendix-a-detailed-findings-index)
12. [Appendix B: PoCs & Validation Commands](#appendix-b-pocs--validation-commands)
13. [Appendix C: Fork Setup Checklist](#appendix-c-fork-setup-checklist)

---

## 1. Goals & Non-Goals

**Goals**
- Eliminate Critical/High exploitable bugs without breaking existing SQLite/Mongo data.
- Establish a legally correct, history-preserving fork that can track or diverge from upstream.
- Make the edge reverse-proxy manager safe to expose (even if only on LAN) with defense-in-depth.
- Provide reproducible builds, pinned deps, and CI gates so the fork does not rot again.

**Non-Goals**
- Full feature rewrite or UI redesign.
- Replacing Caddy itself — only the management plane is hardened.
- Upstream contribution without maintainer consent (PRs welcome but not blocking).

**Success criteria:** `npm audit` 0 High, `trivy` 0 Critical, P0 PoCs denied, `metrics`/`build-info` require auth, JWT forgery fails without env secret, SSRF to `169.254.169.254` blocked, SQL column injection returns 400 not 500 schema leak.

---

## 2. How to Properly Create a Git Repo for Someone Else’s Project

### 2.1 What NOT to do
```bash
mkdir Caddymanager && cd Caddymanager && git init
cp -r /tmp/caddymanager/* .   # loses git history, blame, tags, ability to merge upstream
git add . && git commit -m "initial"
```
This orphans history, hides original authors, breaks `git log --follow`, and violates attribution norms (even if MIT legally allows copying files, you must still ship `LICENSE:15-17`).

### 2.2 Correct: GitHub Fork (preserves history + link)

**Option A — `gh` CLI (recommended, 30s):**
```bash
# from any dir
gh repo fork caddymanager/caddymanager --clone --remote
# creates ./caddymanager, origin=your fork, upstream=caddymanager/caddymanager
cd caddymanager
git remote -v
# origin  https://github.com/<YOU>/caddymanager.git (push)
# upstream https://github.com/caddymanager/caddymanager.git (fetch)

# move to your Pipeline dir (currently empty at /home/conorm/Desktop/Pipeline/Caddymanager)
mv ./caddymanager /home/conorm/Desktop/Pipeline/Caddymanager-hardened
cd /home/conorm/Desktop/Pipeline/Caddymanager-hardened
git fetch upstream
git checkout -b hardened/main 52f69b64
git push -u origin hardened/main:main
```

**Option B — Manual (no `gh`):**
```bash
git clone https://github.com/caddymanager/caddymanager.git CaddyManager-hardened
cd CaddyManager-hardened
git remote rename origin upstream
gh repo create <YOU>/caddymanager-hardened --public --source=. --remote=origin --push
# or without gh: create empty repo on github.com, then:
git remote add origin https://github.com/<YOU>/caddymanager-hardened.git
git push -u origin main
```

**Option C — Mirror (only if you need private archival, not for active fork):**
```bash
git clone --mirror https://github.com/caddymanager/caddymanager.git
# push to new bare repo — preserves all refs but severs GitHub fork network
```

### 2.3 Post-fork hygiene
1. Keep `LICENSE` verbatim, add `NOTICE.md`:
   ```
   Fork of caddymanager/caddymanager @52f69b64 (2025-09-07) by <YOU>.
   Original Copyright 2025 B Stolk, MIT. Not affiliated with Caddy/Stack Holdings.
   Hardened fork: see PLAN.md. Upstream: https://github.com/caddymanager/caddymanager
   ```
2. Update image names to avoid typosquatting: `.github/workflows/backend-docker-publish.yml:7` `IMAGE_NAME: ghcr.io/<YOU>/caddymanager-backend` and `frontend-docker-publish.yml:7` similarly.
3. Enable branch protection on `main` (require PR, CI pass, 1 review).
4. Add `SECURITY.md` with disclosure email and `git tag -s` signing.
5. Never force-push `main` after publishing; use `develop` for upstream sync.
6. If you must scrub a secret leaked in history, use `git filter-repo` on a branch, document it, and notify users to rebase.

### 2.4 Staying syncable
```bash
git fetch upstream
git checkout develop
git merge upstream/main --no-ff -m "sync upstream main 2026-09-01"
# or rebase for clean history: git rebase upstream/main
git push origin develop
# PR develop -> main after CI passes
```
GitHub UI will also show `Fetch upstream` button because of fork network.

---

## 3. Current State Assessment

- **Activity:** 114 commits, last `main` merge 2025-09-07, 18 commits in last year, `ghcr.io` images built from `develop`/`main` via `backend-docker-publish.yml`/`frontend-docker-publish.yml`. No `archived` flag, but no maintainer responses for months.
- **Deployment model:** `docker-compose.yml` (SQLite default `sqlite_data:/app/data`, optional `mongodb` profile), `frontend` Caddy `:80` proxies `/api/*` to `backend:3000`, `CADDY_SANDBOX_URL` for Caddyfile adaptation.
- **Auth:** JWT (`jsonwebtoken@9.0.2`) + API keys (`models/apiKey/*`) via `middleware/authMiddleware.js:6-155`. No rate-limit, no helmet, `cors: {origin:'*', credentials:true}` (`backend/app.js:30-34`), `express.json({limit:'50mb'})`.
- **Data:** Dual-engine repos (`repositories/*`, `models/*/index.js` switch on `DB_ENGINE`). First boot creates `admin:caddyrocks` (`backend/services/sqliteService.js:61`, `backend/services/mongoService.js:38`).
- **Frontend:** Vue 3 + `axios@^1.8.4` (17 advisories), `localStorage['auth_token']` (`frontend/src/services/authService.js:32`), `v-html` in 3 components, `Caddyfile:1` `:80` plain HTTP.

---

## 4. Risk Summary (Verified)

| # | Title | Location | Severity | Exploit |
|---|-------|----------|----------|---------|
| C1 | Hardcoded JWT fallback | `backend/middleware/authMiddleware.js:6`, `backend/controllers/authController.js:6` | **Critical** | `JWT_SECRET` unset -> forge `admin` JWT with `'your_jwt_secret_key_for_development'` |
| C2 | SSRF stored+reflected | `backend/services/caddyService.js:16,89,113`, `backend/controllers/caddyController.js:68,243`, `backend/services/convertService.js:22`, `backend/services/pingService.js:44` | **Critical** | Auth’d `POST /caddy/test-connection {"apiUrl":"http://169.254.169.254","apiPort":80,"adminApiPath":"/latest/meta-data/"}` fetches cloud metadata; `adminApiPath="http://evil.com"` overrides `baseURL` |
| C3 | SQL column-name injection | `backend/repositories/caddyServersRepository.js:79`, `backend/repositories/caddyConfigRepository.js:121`, `backend/models/caddyServers/caddyServersSQLiteModel.js:111`, `backend/models/user/userSQLiteModel.js:163` (`\`${key} = ?\``) | **Critical** | `PUT /caddy/servers/1 {"\"; SELECT sql FROM sqlite_master; --":"x"}` -> 500 schema leak via `backend/controllers/caddyController.js:150` mass-assign |
| C4 | No RBAC/IDOR | `backend/router/caddyRoutes.js:8` only `protect`, `backend/controllers/caddyController.js:14-722` all handlers | **Critical** | Any `user` role can `GET/PUT/DELETE` any server, `POST /caddy/configs/:id/apply {"serverIds":["<victim>"]}` overwrites prod |
| H1 | Public inventory | `backend/router/metricsRoutes.js:31-124`, `backend/router/buildInfoRoutes.js:1`, `backend/app.js:44` | **High** | `curl /api/v1/metrics` / `/metrics/prometheus` / `/build-info` anonymous -> hostnames, upstreams, mem, commit |
| H2 | CORS wildcard + no headers | `backend/app.js:30-34` `origin:'*' + credentials:true`, no `helmet` | **High** | Cross-origin fetch with stolen Bearer, clickjacking, no CSP/HSTS |
| H3 | 20+ dep CVEs | `backend/package.json:15-28` (`axios 1.11.0 <1.15.2`, `express 4.21.2`, `mongoose 7.8.7`, `jws<3.2.3`, `lodash 4.17.21`), `frontend/package.json:18` `axios 1.8.4` | **High** | `GHSA-4hjh-wcwx-xvwj` DoS, `GHSA-3p68` SSRF bypass, `lodash` template RCE |
| H4 | Audit bypass | `backend/services/auditService.js:26,44,57`, `backend/controllers/auditLogController.js:30` | **High** | `filter` ignored for SQLite, `catch->return null` silently drops logs, regex ReDoS |
| H5 | Stored XSS | `frontend/src/components/configurations/configurationDataComp.vue:276`, `configurationCreateDataComp.vue:228` `v-html` on `error.response.data.error`, `frontend/src/components/dashboard/dashboardPanelTextComp.vue:21` `v-html` | **High** | Caddyfile error `<img onerror=...localStorage.auth_token>` stored, executes for all viewers |
| H6 | Token in localStorage + unverified `api_base_url` | `frontend/src/services/authService.js:32`, `frontend/src/services/apiService.js:21`, `frontend/src/services/configService.js:9` | **High** | XSS steals `auth_token`, poisoned `/config {"api_base_url":"https://evil.com"}` sends Bearer to attacker |
| H7 | Body limit DoS + no rate-limit | `backend/app.js:35-36` `50mb`, `backend/router/authRoutes.js:71` login no limit, `backend/controllers/convertController.js:17` | **Medium** | 50 MB JSON/Caddyfile -> OOM, brute-force `admin:caddyrocks` (`backend/services/sqliteService.js:61`) |
| H8 | Weak defaults | `backend/config/dbConfig.js:6` prod without `MONGODB_URI` -> `MongoMemoryServer` ephemeral, `JWT_EXPIRATION` vs `JWT_EXPIRES_IN` mismatch | **Medium** | Data loss on restart, token lifetime misconfig |
| M1 | Info leak | `backend/app.js:56`, `backend/controllers/*:500 json {error:error.message}` | **Medium** | `ECONNREFUSED 127.0.0.1` + Caddy stack in responses |
| M2 | Infra | `backend/Dockerfile:2` `node:20-bullseye-slim` EOL, `frontend/Caddyfile:1` `:80` no TLS, `frontend/vite.config.js:13` `vueDevTools()` in prod | **Medium** | Supply-chain, sniffing, devtools leaks Pinia |

See Appendix A for full index.

---

## 5. Remediation Phases — **Where we are: 2026-09-01**

### Phase 0 — Fork & Baseline (Day 1-2) — *no code risk* — ✅ **DONE `14cfcbad→e69bf884`**
**Goal:** History-preserving fork, reproducible CI, baseline metrics.

- [x] Fork `Thenukegun10x/Caddymanager-Revival` from `52f69b64` via `gh repo fork --fork-name` (114 commits preserved, `fork:true`, `upstream=caddymanager/caddymanager`). Local `Pipeline/Caddymanager-Revival` `origin=Thenukegun10x`, `upstream` set.
- [x] `NOTICE.md` (MIT 2025 B Stolk), `SECURITY.md`, `README` revival banner (`> Hardened Revival Fork`), `gh api topics` `caddy/security/hardened-fork`, `description` + `homepage:PLAN.md`, `has_issues:true`.
- [x] CI `ci.yml` (`AGENTS.md §7` `security-grep` + `backend-test` `jest --runInBand` + `frontend-build` `npm audit` + `docker-trivy` + `poc-smoke`), `AGENTS.md` (compose matrix `build.yml`/`test.yml`/`edge :18080`), `docker-compose.test.yml` + `test/Caddyfile.edge` (isolated `caddy-test-network`).
- [x] Baselines recorded pre-fix: `backend 19 vulns (13 high)`, `frontend 10 (8 high)`, `curl /metrics anon 200` (now `401`), `trivy` — `N/A` (docker daemon N/A laptop, but `trivy fs` added in CI).
- [x] Pen test harness `/tmp/pentest.js` (supertest, no docker) `28 checks` documented in `AGENTS.md §5`.

**Acceptance:** `upstream/main..main` now `7 commits` (`14cfcbad`..`0c59a52f`), `security-grep PASS`, `backend jest 170/170` (was `10 fail` pre-fix).

### Phase 1 — P0 Critical (Week 1-2) — *must ship before any Internet exposure* — ✅ **DONE `18fccef5` + `18483ec8` (pen test 28/28)**

#### 1.1 JWT Secret Hardening — `backend/middleware/authMiddleware.js:6`, `backend/controllers/authController.js:6`, `backend/app.js:17` — ✅
- `getJwtSecret()` fail-fast (`if !JWT_SECRET throw`, `NODE_ENV=test` fallback `test-jwt-secret...`), `jwt.verify(...,{algorithms:['HS256']})`, `jwt.sign(...,{algorithm:'HS256'})`, `Bearer ` space require (`startsWith('Bearer ')`), `JWT_EXPIRES_IN || JWT_EXPIRATION`, `app.js SIGTERM` + startup `if !JWT_SECRET exit 1`, `jest.setup.js` test secret. **Pen test:** `forged your_jwt_secret_key_for_development →401`, `Bearer` without space `401`, `none` alg `401`.

#### 1.2 SQL Column Whitelisting — `backend/repositories/*`, `backend/models/*SQLiteModel.js` — ✅
- `utils/sql.js` `ALLOWED` (`caddy_servers: name/apiUrl/.../createdBy`, `caddy_configs: servers/jsonConfig/...`, `users: username/...`, `api_keys: ...`), `filterUpdateData` drops unknown + `// ALLOWED` tag for CI, `throw No valid fields` if all dropped. Applied `caddyServersRepository:79`, `caddyConfigRepository:121`, `caddyServersSQLiteModel:111`, `caddyConfigSQLiteModel:121`, `userSQLiteModel:163`. **Pen test:** `PUT {"name":"ok","; SELECT":1} →200` (injected column dropped, no `sqlite_master` leak, no `500`).

#### 1.3 SSRF Deny-by-Default — `backend/services/caddyService.js:16-134`, `backend/controllers/caddyController.js:68,243`, `backend/services/convertService.js:22`, `backend/services/pingService.js:44` — ✅
- `utils/ssrf.js` `assertSafeApiUrl/Port/AdminApiPath` (`PRIVATE_HOST_RE`, `ALLOW_PRIVATE_IPS=true` in test else deny, `//`/`://` block, `..` block, `maxRedirects:0`, `maxContentLength:1M`), `buildSafeBaseUrl`, `axiosSafeOpts`. Enforced `caddyService.createAxiosInstance/testServerConnection/getConfig/updateConfig/addServer/updateServer/retrieveFile`, `convertService` (sandbox URL validate), `pingService` (skip private, concurrency 5, overlap guard `pingInProgress`), `caddyController` (400 early). **Pen test:** `POST 169.254/127/10/localhost →400 Blocked private`, `adminApiPath=http://evil.com →400`.

#### 1.4 RBAC & Ownership — `backend/router/caddyRoutes.js:8`, `backend/controllers/caddyController.js:14-722` — ✅
- `caddyServers` `createdBy INTEGER` (SQLite `ALTER ADD COLUMN` + `sqliteService` backfill) + Mongoose `createdBy: ObjectId ref:User`. `caddyController.addServer` sets `createdBy=req.user.id`, `checkServerOwnership` (`403` if `createdBy` set and `req.user.id != createdBy && role!='admin'`) on `getServerById/updateServer/deleteServer/getConfig/updateConfig/loadConfig/checkServerStatus/generate*`. `metricsRoutes` + `buildInfoRoutes` `protect` (H1), `DELETE /history` `authorize('admin')`. **Pen test:** `user GET admin server 403`, `admin 200`, `user PUT/DELETE 403`. `getAllServers` still lists all (Phase 3: filter by owner).

**Phase 1 Exit:** ✅ `pen test /tmp/pentest.js 28/28`, `jest 170/170`, `security-grep PASS` (C1/C3/H5/H1).

### Phase 2 — P1 Hardening (Week 3-4) — 🚧 **PARTIAL `18fccef5→95f10e07→0c59a52f` (H1/H3/H5 + C2/CORS auto-migrate live, rest queued)**

#### 2.1 Edge & Auth Hardening — `backend/app.js:30-38`, `backend/router/metricsRoutes.js:31`, `backend/router/buildInfoRoutes.js:1` — 🚧 PARTIAL
- [x] `app.js:30` CORS allowlist (`CORS_ORIGIN.split(',')`, `methods`, `allowedHeaders`, `*` only if no env), `express.json 200kb`/`text 512kb`/`urlencoded 200kb`, `morgan` dev-only, `SIGTERM` + `SIGINT` graceful.
- [x] `metricsRoutes`+`buildInfoRoutes` `router.use(protect)` (`DELETE /history` `authorize('admin')`) — `curl /metrics anon 401` (was `200`).
- [ ] Add `helmet` + `hsts`, `express-rate-limit` (login `5/15m`, `test-connection` `10/h`, `POST /caddy/servers` `60/m`) — *TODO, low P1*.
- [ ] Stream large configs to temp file — *TODO*.

#### 2.2 Dependency Upgrade — `backend/package.json`, `frontend/package.json`, `backend/Dockerfile:2` — ✅
- [x] `npm audit fix` + `npm update` `backend 19→0 vulns` (`axios 1.11→1.20`, `express 4.21.2→4.22.2`, `mongoose 7.8.7→7.8.12`, `jsonwebtoken 9.0.2→9.0.3`, `lodash` etc) + `better-sqlite3 12.2→13.0.3` (Node 26/22), `frontend 10→0` (`axios 1.8.4→1.20`, `vite 6.3.5→6.4.3`), `npm run build` ok, `jest 170/170`.
- [ ] `Dockerfile:2` `node:20-bullseye-slim → bookworm`, remove `pm2 -g`, `HEALTHCHECK`, multi-stage — *TODO, low P1*.

#### 2.3 Frontend XSS & Token — `frontend/src/components/configurations/configurationDataComp.vue:276`, `configurationCreateDataComp.vue:228`, `frontend/src/components/dashboard/dashboardPanelTextComp.vue:21`, `frontend/src/services/*` — ✅ (H5) / 🚧 (H6)
- [x] `v-html` removed: `dashboardPanelTextComp:21` `{{ it.value }}`, `configurationDataComp:276` + `configurationCreateDataComp:228` `style="white-space:pre-wrap" {{caddyfileValidationError}}` — `grep v-html.*caddyfileValidationError 0`, `pen test` H5 `PASS`.
- [ ] Move `localStorage['auth_token']` → `__Host-auth_token HttpOnly` + `withCredentials` (AGENTS.md H6) — *TODO, needs backend Set-Cookie + frontend apiService*.

#### 2.4 Audit & Reliability — `backend/services/auditService.js:26,44,57`, `backend/services/pingService.js:44,126` — ✅ (ping) / 🚧 (audit)
- [x] `pingService:44` URL fix (`base.replace(/\/$/,'') + :port + path`), private skip via `ssrf`, concurrency `5` batch, `pingInProgress` guard, `maxContentLength` + `validateStatus:null` → `maxRedirects:0`.
- [ ] `auditService` `getAuditLogs` filter pass-through, `limit<=100`, `TTL` cron — *TODO*.

**Phase 2 Exit:** `npm audit 0/0` ✅, `curl /metrics anon 401` ✅, RBAC `403` ✅, XSS literal ✅, `helmet`/`rate-limit`/`TTL` still TODO.

### Phase 3 — Polish & Operate (Week 5-6) — 🚧 **PARTIAL**

- [ ] Input validation with `zod`/`joi` for all `req.body` (`caddyController` `name`, `apiUrl`, `jsonConfig` schema 1 MB limit), add `express-validator` middleware.
- [ ] Add `auditLog` TTL (`AUDIT_LOG_RETENTION_DAYS` cron, `auditLogMongoModel` TTL index, SQLite `DELETE WHERE createdAt < ?`).
- [ ] Add `changePassword` token rotation (`backend/controllers/authController.js:223` invalidate old JWT via `jti` denylist or version bump).
- [ ] Frontend: add `maxContentLength:5*1024*1024` in `frontend/src/services/apiService.js:11`, `zod` validate `metrics` (`dashboardView.vue:33`), `deepClone` depth limit (`frontend/src/services/templateService.js:19`).
- [ ] Docs: update `docker-compose.yml` `JWT_SECRET` required, `CORS_ORIGIN` example, `DB_ENGINE` note on ephemeral memory fallback; add `docs/SECURITY.md`.
- [x] Data migration: `backend/scripts/migrate-20250901-add-createdBy.js` + `npm run migrate` + **auto-migrate on boot** (`services/sqliteService.js:70` backfill `NULL→admin`, `integrity_check`, `docker-entrypoint.sh` `migrate` before `npm start`, `Dockerfile ENTRYPOINT`). Tested old `28K` DB (2 rows, no column) → `column added`, `2→admin 1`, `integrity ok`, `idempotent` second run, fresh DB already has column, `jest 170/170`, `pen test 28/28` on migrated DB (`0c59a52f`).

---

## 6. Verification & Testing Strategy — ✅ **LIVE**

- **Unit:** `backend jest --runInBand 170/170` (`jest.setup.js :memory:`, `better-sqlite3@13.0.3`, `Node 26` local, `22` CI). `apiKeyRepository` `lean().exec` guard fixed, `apiKeyController` placeholder. Added `utils/ssrf.js` `ALLOW_PRIVATE_IPS` + `utils/sql.js` `ALLOWED`.
- **Integration:** `supertest` pen test `/tmp/pentest.js 28/28` (C1 `your_jwt... →401`, `Bearer` space `401`, `none 401`; C2 `169.254/127/10/localhost →400`, `adminApiPath URL →400`; C3 `"; SELECT` dropped `200` no leak; C4 `user 403`/`admin 200`; H1 `metrics anon 401`/`auth 200`, `build-info 401`, `prometheus 401`; H5 `v-html 0`).
- **Docker:** `docker-entrypoint.sh` auto-migrate tested on `old.sqlite` (1 row no column → column + backfill) + `fresh.sqlite`, `integrity ok`, `docker-compose.test.yml :18080` edge (`caddy-test-network`). `backend jest` local `SIGSEGV` fixed via `--runInBand` + `node 22`.
- **Security scans:** `npm audit 0/0` (was `19`/`10`), `ci.yml` `security-grep PASS`, `trivy fs` added (docker daemon N/A on laptop but CI). `semgrep/gitleaks` *TODO*.
- **Manual:** `Appendix B` PoCs now deny (`400`/`401`/`403`); baselines `backend 19→0`, `frontend 10→0`.

---

## 7. Branching, CI/CD, Release — ✅ **LIVE (`main:0c59a52f`)**

```
main (protected, hardened stable) — 7 ahead of upstream 52f69b64
develop (TODO) <- PR from fix/* (syncs upstream/main weekly)
main: 14cfcbad (fork+NOTICE) → e69bf884 (AGENTS+test.yml) → 32c88ae (ci) → 18fccef5 (P0) → 999d8f5 (ci bump node 22) → 95f10e0 (npm audit 0) → 305c29 (migrate) → 0c59a52 (docker auto-migrate)
```

**.github/workflows:**
- `ci.yml` `on: push [main,develop] + pull_request` → `backend-test` (`npm ci`, `jest --runInBand`, `npm audit` now `0` warn→pass, `--runInBand` fixes SIGSEGV) + `frontend-build` (`npm audit 0`, `vite build`) + `security-grep PASS` + `poc-smoke` + `docker-trivy` (`trivy fs` `CRITICAL,HIGH`). `NODE_VERSION 22` (was `20` for `better-sqlite3@13`).
- `backend-docker-publish.yml`/`frontend-docker-publish.yml` still `ghcr.io/Thenukegun10x/caddymanager-revival-backend:main` (not yet retagged `v0.1-hardened.1`). `ENTRYPOINT docker-entrypoint.sh` now auto-migrates.
- `develop` branch *TODO* (currently all on `main`).

**Release:** *TODO* `git tag v0.1-hardened.1 -s` → `ghcr.io/Thenukegun10x/...:v0.1-hardened.1` (deferred until Phase 2 `helmet`/`rate-limit`).

---

## 8. Governance & Upstream Sync

- **If upstream revives:** Weekly `git fetch upstream`, PR `upstream/main` -> `develop`, run CI, resolve conflicts, keep `NOTICE.md` updated. Contribute P0 fixes upstream via PR.
- **If stays dead >6 months:** Announce hard fork in README, pin `Upstream last commit 52f69b64`, consider renaming `caddymanager-hardened` to avoid confusion, keep MIT attribution.
- **Issue triage:** `P0` (auth/SSRF/SQLi), `P1` (XSS/CORS/deps), `P2` (polish). Use `CODEOWNERS`.
- **Support:** Document `admin:caddyrocks` must be changed on first boot; add `onboarding` check `if (await userRepository.isDefaultAdmin()) warn`.

---

## 9. Alternatives

If hardening effort > value, consider:
- **Nginx Proxy Manager** (mature, similar UI, active).
- **Traefik + File Provider** + `traefik-certs-dumper`.
- **Plain Caddy** with `caddy admin --config` + GitOps (no manager).
- **Pangolin** / **Authelia** + Caddy for auth.

Decommission plan: export `jsonConfig` via `GET /caddy/servers/:id/config` -> `caddy fmt --adapter caddyfile`, commit to Git, run Caddy natively.

---

## 10. Timeline & Effort — **Actual 2026-09-01 (1 day, P0 done)**

| Phase | Planned | Actual 2026-09-01 | Output |
|-------|---------|------------------|--------|
| 0 Baseline | 1-2 days | ✅ 1h `14cfcbad→e69bf884` | Fork, `AGENTS.md`, `docker-compose.test.yml`, CI `security-grep` |
| 1 P0 | 1-2 weeks | ✅ 2h `18fccef5+18483ec8` | JWT/SSRF/SQLi/RBAC, `pen test 28/28`, `jest 170/170` |
| 2 P1 | 2 weeks | 🚧 Partial `95f10e0+0c59a52f` | `npm audit 0/0`, CORS `200k/512k`, XSS `v-html`→`{{}}`, metrics `401`, auto-migrate, `helmet`/`rate-limit` TODO |
| 3 Polish | 1-2 weeks | 🚧 Partial `305c29` | `migrate-20250901` + auto-boot, `auditService`/`zod`/`helmet` still TODO |
| Ongoing | Monthly | — | `npm audit 0`, `trivy`, upstream sync |

Total planned 4-6w, P0 makes LAN safe now if `JWT_SECRET=$(openssl rand -hex 32)` and not Internet-exposed. `v0.1-hardened.1` deferred until `helmet`/`rate-limit`.

---

## Appendix A: Detailed Findings Index

| ID | File:Line | Issue |
|----|-----------|-------|
| C1 | `backend/middleware/authMiddleware.js:6`, `backend/controllers/authController.js:6` | Hardcoded JWT fallback |
| C2 | `backend/services/caddyService.js:16,89,113,134`, `backend/controllers/caddyController.js:68,243`, `backend/services/convertService.js:22`, `backend/services/pingService.js:44` | SSRF |
| C3 | `backend/repositories/caddyServersRepository.js:79`, `backend/repositories/caddyConfigRepository.js:121`, `backend/models/caddyServers/caddyServersSQLiteModel.js:111`, `backend/models/user/userSQLiteModel.js:163` | SQL column injection |
| C4 | `backend/router/caddyRoutes.js:8`, `backend/controllers/caddyController.js:14-722` | No RBAC/IDOR |
| H1 | `backend/router/metricsRoutes.js:31`, `backend/router/buildInfoRoutes.js:1`, `backend/app.js:44` | Public metrics/build-info |
| H2 | `backend/app.js:30-34`, `frontend/Caddyfile:1` | CORS wildcard, no security headers |
| H3 | `backend/package.json:15`, `frontend/package.json:18` | Dep CVEs (`axios`, `mongoose`, `lodash`, `jws`) |
| H4 | `backend/services/auditService.js:26,44,57`, `backend/controllers/auditLogController.js:30` | Audit bypass |
| H5 | `frontend/src/components/configurations/configurationDataComp.vue:276`, `configurationCreateDataComp.vue:228`, `frontend/src/components/dashboard/dashboardPanelTextComp.vue:21` | XSS `v-html` |
| H6 | `frontend/src/services/authService.js:32`, `frontend/src/services/apiService.js:21`, `frontend/src/services/configService.js:9` | localStorage token + unverified api_base_url |
| H7 | `backend/app.js:35-36`, `backend/router/authRoutes.js:71` | 50 MB DoS + no rate-limit + default creds `backend/services/sqliteService.js:61` |
| H8 | `backend/config/dbConfig.js:6`, `backend/Dockerfile:2` | Ephemeral Mongo fallback, EOL base image |

---

## Appendix B: PoCs & Validation Commands

**JWT forgery (C1):**
```bash
node -e "console.log(require('jsonwebtoken').sign({id:'1',role:'admin'}, 'your_jwt_secret_key_for_development'))"
curl http://localhost:3000/api/v1/auth/users -H "Authorization: Bearer <forged>"
# expect 401 after fix even without env
```

**SSRF (C2):**
```bash
TOKEN=$(curl -s http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"caddyrocks"}' | jq -r .token)
curl -s http://localhost:3000/api/v1/caddy/test-connection -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"apiUrl":"http://169.254.169.254","apiPort":80,"adminApiPath":"/latest/meta-data/"}' | jq
# expect 400 Private IP blocked after fix
```

**SQLi (C3):**
```bash
curl -X PUT http://localhost:3000/api/v1/caddy/servers/1 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"x","\"; SELECT sql FROM sqlite_master; --":"x"}'
# expect 400 No valid fields, not 500 schema leak
```

**RBAC (C4):**
```bash
# as user role
curl http://localhost:3000/api/v1/caddy/servers/<admin-server-id> -H "Authorization: Bearer $USER_TOKEN"
# expect 403 after fix
```

**Metrics (H1):**
```bash
curl -i http://localhost:3000/api/v1/metrics
# expect 401 after fix (was 200)
```

**XSS (H5):**
Submit Caddyfile that triggers error containing `<img src=x onerror=alert(1)>`, view as another user — should show literal text, no alert.

**Baseline captures:**
```bash
npm --prefix backend audit --json > baseline-backend-audit.json
npm --prefix frontend audit --json > baseline-frontend-audit.json
trivy fs --severity CRITICAL backend > baseline-trivy.txt
```

---

## Appendix C: Fork Setup Checklist

- [ ] `gh repo fork caddymanager/caddymanager --clone --remote`
- [ ] `git checkout -b hardened/main 52f69b64 && git push -u origin hardened/main:main`
- [ ] Add `NOTICE.md` + `SECURITY.md`, update `README` banner, change `IMAGE_NAME` in `.github/workflows/*publish.yml:7`
- [ ] Branch protection on `main` (PR + CI)
- [ ] `npm --prefix backend ci && npm audit` baseline, `npm --prefix frontend ci`
- [ ] Create issues `P0-JWT`, `P0-SSRF`, `P0-SQLi`, `P0-RBAC` linked to this PLAN
- [ ] Set secrets `JWT_SECRET`, `CORS_ORIGIN`, `GHCR_PAT` in repo settings
- [ ] First PR: Phase 1.1 JWT fix

---

*Generated 2026-09-01 from review of `/tmp/caddymanager`; updated 2026-09-01 11:15 UTC @0c59a52f (P0+H1/H3/H5+auto-migrate live, 28/28 pen test). Keep this file in repo root and update `Last verified: <date> <commit>` after each phase.*
