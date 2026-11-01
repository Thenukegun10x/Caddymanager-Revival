# Security Sweep — Caddymanager-Revival

- **Date:** 2026-11-01
- **Commit:** `ebaddaf2` (`main`)
- **Scope:** backend (Express/Node 20), frontend (Vue 3/Vite), Docker/Compose, CI, dependencies
- **Method:** manual code review + `npm audit` + targeted runtime proofs (SSRF module, ReDoS timing, image inspection)

> Compared with upstream, this fork is materially better: SSRF validators are actually wired into services/controllers, SQL column whitelists exist, the container runs non-root with a healthcheck, JWT uses `algorithms:['HS256']` + `tokenVersion`, `v-html` is gone, and `/config` is same-origin validated.
>
> The remaining issues are concentrated in **deployment defaults, object-level authorization, API-key enforcement, and one password-hashing path**. Those are the ones that make or break "top tier".

---

## Severity summary

| Severity | Count | Headline |
|---|---|---|
| Critical | 7 | Forgeable JWTs by default; default admin; any user can push config to any Caddy server; API-key permissions ignored; Mongo password stored plaintext; SSRF filter bypass; global config object access |
| High | 8 | Plaintext API keys, vulnerable deps, dev deps in runtime, no password policy, ReDoS, error leakage, token returned in body, public Swagger |
| Medium | 12 | Cookie/CSRF hardening, rate-limit tuning, enumeration, logout revocation, CSP, audit integrity, port/URL parsing |
| Low | 8 | Info disclosure, header edge cases, config hygiene |

---

## Critical

### C1. Default Compose ships a known JWT secret — admin forgery out of the box

**Where**
- `docker-compose.build.yml:24` → `JWT_SECRET=your_jwt_secret_key_here`
- `docker-compose.yml:40` → `JWT_SECRET: "your_jwt_secret_key_here"`

**Why it matters**
`backend/app.js:15` and `middleware/authMiddleware.js:15` only check that `JWT_SECRET` is *non-empty*. The placeholder passes. Anyone who can reach the UI can sign an admin token:

```bash
node -e "console.log(require('jsonwebtoken').sign({id:'1',tokenVersion:0},'your_jwt_secret_key_here'))"
curl -s http://localhost/api/v1/auth/users -H "Authorization: Bearer <token>" | jq
```

This is a regression of PLAN.md C1 at the deployment layer: the app is hardened, the Compose file re-opens it.

**Fix**
- Remove `JWT_SECRET` from both Compose files; use `${JWT_SECRET:?JWT_SECRET must be set}` (fail closed).
- Add the same `:?` guard for `MONGODB_URI` password / Mongo root password.
- In `getJwtSecret()`, reject known placeholders and secrets shorter than 32 chars.

---

### C2. Default admin `admin:caddyrocks` with no forced rotation

**Where**
- `backend/services/sqliteService.js:146-160`
- `backend/services/mongoService.js:43+`
- Documented in `AGENTS.md:47`

**Why it matters**
Every fresh deployment is administered with public credentials. There is no `mustChangePassword` flag, no first-login gate, and no warning in the UI. Combined with C1 or simply an exposed port, this is full compromise.

**Fix**
- Generate a random password on first boot and print it once to logs (or require `ADMIN_PASSWORD`).
- Add `mustChangePassword` to the user model; block all routes except `/auth/change-password` until cleared.
- Refuse to boot in production if the admin password is still the known default.

---

### C3. Any authenticated user can push arbitrary config to **any** Caddy server

**Where**
- `backend/router/caddyRoutes.js:490` → `POST /configs/:configId/apply` (no `authorize`)
- `backend/controllers/caddyController.js:756-763` → no ownership check
- `backend/services/caddyService.js:468-494` → resolves `serverIds` from request body with no ownership/role check
- `backend/router/caddyRoutes.js:556-558, 612-615, 641` → config CRUD also unprotected

**Why it matters**
A `user` account (or a read-only API key, see C4) can:
1. create a config with attacker-controlled JSON,
2. call `apply` with `{"serverIds":["<victim server id>"]}`,
3. rewrite the reverse proxy: route traffic to attacker origins, steal TLS-terminated traffic, redirect auth flows, or break production.

This is the highest-impact finding in the app. Server routes have `checkServerOwnership`; config routes do not.

**Fix**
- Add a shared `assertServerAccess(req, serverId)` that enforces `createdBy === req.user.id || role === 'admin'`.
- Use it in `createConfig` (every id in `servers`), `applyConfig` (every id in `serverIds`), and when reading/deleting/updating a config (derive access from `config.servers`).
- Add `authorize('admin')` to destructive config operations, or scope configs per owner.
- Keep `protect` as-is; add negative tests for cross-user apply.

---

### C4. API-key permissions are defined but never enforced

**Where**
- `backend/middleware/authMiddleware.js:164-181` defines `checkApiPermission`
- `git grep checkApiPermission` → **only the definition**, zero call sites
- `backend/router/caddyRoutes.js:9` applies only `protect`

**Why it matters**
A key created with `{read:true, write:false, delete:false}` can still `POST`/`PUT`/`DELETE` every Caddy resource. It also inherits the full role of its owner — an admin's "read-only" key can create users, revoke keys, and apply configs. Keys can also mint new keys, so a leaked read key can escalate itself.

**Fix**
- Apply `checkApiPermission('read'|'write'|'delete')` per route/method (`read` for GET, `write` for POST/PUT/PATCH, `delete` for DELETE).
- Never let an API key call `/auth/*` admin routes or `/api-keys` create/update/delete.
- Add tests for a read-only key hitting write/delete endpoints expecting `403`.

---

### C5. MongoDB password change stores the password in plaintext

**Where**
- `backend/controllers/authController.js:278-280` → `findByIdAndUpdate(..., { password: newPassword, tokenVersion })`
- `backend/models/user/userMongoModel.js:62-74` → hashing exists **only** in `pre('save')`
- `backend/repositories/userRepository.js:121-128` → Mongoose `findByIdAndUpdate` bypasses `save` hooks

**Why it matters**
With `DB_ENGINE=mongodb`, changing a password writes `newPassword` verbatim. Login then fails (`bcrypt.compare` against a non-hash), and the DB now contains plaintext credentials. This is the same class of bug as the branch `fix/63-...`.

**Fix**
- Hash in the repository/service before `findByIdAndUpdate`, or add a `pre('findOneAndUpdate')` hook that hashes when `password` is in the update.
- Prefer `user.password = newPassword; await user.save()` (load doc with `+password`).
- Add a regression test for both engines asserting the stored value starts with `$2` and `comparePassword` succeeds.

---

### C6. SSRF filter bypasses: DNS aliases, IPv6 unspecified, ULA range

**Where**
- `backend/utils/ssrf.js:7` (blocklist regex), `:36-40` (decision)
- Verified with `NODE_ENV=production`, `ALLOW_PRIVATE_IPS` unset:

```
ALLOW   http://localtest.me                 # resolves to 127.0.0.1
ALLOW   http://metadata.google.internal     # cloud metadata alias
ALLOW   http://[::]                         # IPv6 unspecified != literal "::1"
ALLOW   http://[fd12::1]                    # ULA fd00::/8; regex only matches "fd00:"
BLOCK   http://169.254.169.254
BLOCK   http://127.0.0.1
```

**Why it matters**
The check is string-prefix based and never resolves DNS. Any attacker-controlled hostname pointing at `127.0.0.1`, RFC1918, or metadata service passes. `[::]` and the full `fc00::/7` ULA range are missed. Authenticated users can trigger requests via `test-connection`, server creation, and `convert`.

**Fix**
- Resolve the hostname (`dns.lookup(..., {all:true})`) and validate **every** returned address with `net.isIP` + explicit CIDR checks (`ipaddr.js` or `node:net` + manual ranges).
- Use `ipaddr.js` for canonical parsing: reject `::`, `::1`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, `0.0.0.0/8`.
- Pin the resolved IP for the actual request (custom `lookup` in axios/http agent) to prevent DNS rebinding/TOCTOU.
- Keep `maxRedirects: 0` (already present).
- Because this product legitimately manages LAN Caddy servers, prefer an explicit **host allowlist** (`CADDY_ALLOWED_HOSTS`) plus admin-only server creation, rather than a blanket `ALLOW_PRIVATE_IPS=true` kill switch.

---

### C7. Caddy configs are a global object space — no ownership on read/update/delete

**Where**
- `backend/controllers/caddyController.js:638-653` (`getConfigById`), `:884-887` (`deleteConfig`), `:980-985` (`updateConfigContent`)
- `backend/services/caddyService.js:402-404, 791-812, 878-890`
- `backend/models/caddyConfig/caddyConfigMongoModel.js:8-52` has **no `createdBy`/owner field**

**Why it matters**
Any authenticated user can enumerate `GET /api/v1/caddy/configs`, read every stored JSON config (which can contain upstream credentials, TLS settings, internal hostnames), edit content, or delete it. Config listing is also returned in full to the dashboard.

**Fix**
- Add `createdBy` to the config schema (both engines) and backfill from the first associated server.
- Filter `getAllConfigs` by owner or admin.
- Reuse the same access helper as C3.
- Consider redacting known-sensitive fields in list responses.

---

## High

### H1. API keys are stored in plaintext and re-readable

`backend/models/apiKey/apiKeyMongoModel.js:12-16`, `backend/models/apiKey/apiKeySQLiteModel.js:22,53`. Keys are 32 random bytes (good entropy) but stored as-is. A DB backup, SQLite file, or read-only DB bug yields usable credentials. `getApiKey`/`getApiKeys` can also return them again.

**Fix:** store `sha256(key)` only, show the plaintext once on creation, look up by hash. Add a `keyPrefix` (first 8 chars) for identification in the UI.

### H2. Vulnerable dependencies

Backend `npm audit`: 1 critical, 5 high, 21 moderate.

| Package | Severity | Issue | Fix |
|---|---|---|---|
| `proxy-addr` | critical | IP spoofing via IPv4-mapped IPv6 | bump `express`/`proxy-addr` |
| `body-parser` | high | DoS via trailing bytes after compressed body | bump `express` |
| `brace-expansion` | high | quadratic CPU DoS | bump transitive |
| `fast-uri` | high | authority injection | bump |
| `follow-redirects` | high | credential stripping on array headers | bump `axios` |
| `zod` | high | memory exhaustion on oversized collections | `>=4.6.6` |

Frontend: 5 high (`vue`/`@vue/server-renderer` XSS advisory, `vite`, `source-map-js`, `follow-redirects`). Vue SSR advisory is lower risk for a client-only SPA, but the version should still move.

`backend/package.json` pins `axios ^1.6.2`, `express ^4.18.2`, `zod ^4.5.4`; `AGENTS.md` already asks for `axios ^1.15.3`, `express 4.22.1`.

**Fix:** `npm audit fix`, bump the direct pins, re-run tests. Make CI's `npm audit` blocking at `high` (currently warn-only in `.github/workflows/ci.yml:50`).

### H3. Dev dependencies are shipped in the production image

`backend/Dockerfile:21` runs `npm ci` (all deps); the runtime stage copies the whole `node_modules`. Verified in the built image:

```
jest, supertest, nodemon, mongodb-memory-server present
node_modules = 330 MB, image = 1.15 GB
```

This imports test-only CVEs and attack surface into production, and bloats the image.

**Fix:** add a production-deps stage (`npm ci --omit=dev`) or `npm prune --omit=dev` after the build stage; copy only that tree.

### H4. No effective password policy

- `backend/controllers/authController.js:255-280` accepts any `newPassword`.
- SQLite `users` schema has no length constraint (`services/sqliteService.js:29-38`); `userSQLiteModel.create` hashes whatever it gets.
- `backend/utils/validate.js` has no user/password schema at all.
- Only the Mongoose schema enforces `minlength: 8`, and C5 bypasses it on update.

**Fix:** shared Zod schema (`min 12`, max 128, reject common passwords, require 3 character classes), applied to create-user, change-password, and profile. Enforce the same in both engines.

### H5. Email validator is catastrophic-backtracking ReDoS (Mongo path)

`backend/models/user/userMongoModel.js:18-24`:

```js
/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/
```

Measured against a 30-char input of `a…a!`: **597 ms**. Growth is exponential (~10× per 4 chars), so a 40-char input is minutes of blocked event loop. Reachable by any authenticated user via `PUT /api/v1/auth/update-profile` (email) under `DB_ENGINE=mongodb`, and by admins via create-user. JSON limit is 200 KB.

**Fix:** use a non-backtracking validator (Zod `.email()`), cap length at 254, and normalize before validation.

### H6. Internal error messages leaked to clients

Dozens of `error: error.message` responses, plus the global handler (`backend/app.js:113-120`) which always returns `err.message` and only hides the stack. Examples: `controllers/caddyController.js:70-73`, `authController.js:122-127`, `apiKeyController.js:67-71`, `middleware/authMiddleware.js:134-147`. Leaks DB driver errors, file paths, upstream hostnames, and JWT failure reasons.

**Fix:** return a generic message + correlation ID; log the detail server-side. Keep verbose errors behind `NODE_ENV === 'development'`.

### H7. JWT is still returned in the JSON body

`backend/controllers/authController.js:110-121` returns `token` "for backwards compat", while the stated design is httpOnly cookie. The frontend puts it in a JS closure and the axios interceptor still reads a legacy `localStorage` token (`frontend/src/services/apiService.js:29-33`). Any XSS, verbose proxy log, or browser extension defeats the cookie mitigation.

**Fix:** stop returning the token in the body (or gate it behind `ALLOW_BEARER_TOKEN=true` for CLI users); delete the localStorage fallback and legacy key; keep cookie-only for the SPA.

### H8. Swagger UI/spec is public

`backend/app.js:91-96`: `/api-docs` and `/api/v1/docs/swagger.json` are unauthenticated and enumerate every route, parameter, and schema. Low direct impact, high value for attackers.

**Fix:** gate behind `protect, authorize('admin')` or disable in production.

---

## Medium

| # | Finding | Where | Fix |
|---|---|---|---|
| M1 | Cookie hardening conditional; no `__Host-`; `sameSite=lax` when not HTTPS; `express.urlencoded` enabled | `authController.js:86-94`, `app.js:84` | `Secure` + `SameSite=Strict` + `__Host-auth_token` in production; disable urlencoded |
| M2 | Login limit 50/15 min, IP-only, no per-account lockout | `app.js:56-63` | 5–10 attempts per IP+username, exponential backoff, alert on spray |
| M3 | Username enumeration by timing (no dummy bcrypt on user-not-found) | `authController.js:33-54` | always run a dummy `bcrypt.compare`, then return the same 401 |
| M4 | Logout clears cookie but does not revoke the JWT | `authController.js:131-140` | bump `tokenVersion` on logout-all / add `jti` denylist; shorten TTL to 15–60 min |
| M5 | CSP allows `unsafe-eval`; HSTS sent over plain HTTP | `frontend/Caddyfile:4-9` | remove `unsafe-eval` (Vite precompiles Vue); move HSTS to the TLS terminator |
| M6 | `trust proxy 1` + vulnerable `proxy-addr` | `app.js:22` | update `proxy-addr`; keep backend unpublished (already true) |
| M7 | Audit log query only scans the newest 1000 rows; no hash chain | `services/auditService.js:74-97` | push filters into SQL; add append-only hash chain + export |
| M8 | `CORS_ORIGIN=http://localhost:80` is the wrong origin form (browsers send `http://localhost`) | both Compose files | use `http://localhost`; derive from env |
| M9 | `ALLOW_PRIVATE_IPS=true` disables SSRF protection globally; not set by default, so LAN Caddy targets are blocked | `utils/ssrf.js:37` | replace with explicit host allowlist (see C6) |
| M10 | `apiUrl` may contain a port; base URL builder appends another (`host:8080:2019`) | `utils/ssrf.js:74-79` | reject explicit ports in `apiUrl` or normalize with `URL` |
| M11 | `server.name` flows into `Content-Disposition` and generated YAML unsanitized | `caddyController.js:552`, `caddyService.js:217+` | restrict to `[A-Za-z0-9._ -]`; strip CR/LF; quote filenames |
| M12 | No `Cache-Control: no-store` on auth responses | `authController.js:111` | set on login/me/change-password |

---

## Low / hygiene

- L1. `morgan('dev')` enabled for any non-production `NODE_ENV` (`app.js:86`).
- L2. MongoDB profile publishes `27017` with `someSecretPassword` (`docker-compose.yml:9-11`). Never publish DB ports; use secrets.
- L3. Mongo email regex accepts 2–3 char TLDs only (`.info`, `.cloud` rejected) — correctness, not security.
- L4. `backend/.dockerignore` includes `__tests__`, good; but `npm ci` still installs test deps (H3).
- L5. Frontend `dist/assets/templateService-*.js` is 1.75 MB (unminified productivity hit, not security).
- L6. `pinia-plugin-persistedstate` persists only `themeStore` — no token leak. Good.
- L7. No `security.txt` / structured disclosure SLA beyond `SECURITY.md`.
- L8. Audit retention config exists (`AUDIT_LOG_RETENTION_DAYS`) and `cleanupOldLogs` exists — verify it runs in the container (the entrypoint log showed a DB path mismatch, non-fatal).

---

## What is already good (keep it)

- `jwt.verify(..., { algorithms: ['HS256'] })`, no fallback secret, `tokenVersion` check, DB re-fetch of role/active state.
- SQL update whitelist (`utils/sql.js`) used by all SQLite models; parameterized statements throughout.
- SSRF validators are genuinely wired into `caddyService`, `convertService`, `caddyController`; `maxRedirects: 0`, 1 MB response cap, 10 s timeout.
- `assertSafeAdminApiPath` blocks scheme overrides, `..`, and non-path input.
- Backend runs as `USER node`, has a healthcheck, and a multi-stage build.
- CORS defaults to *deny* when `CORS_ORIGIN` is unset; credentials only with an allowlist.
- No `v-html`, no `innerHTML`, no `eval` in `frontend/src`.
- `/config` runtime config is same-origin validated and falls back safely.
- Frontend login no longer writes the JWT to localStorage (only the user object).
- CI actions are pinned to commit SHAs, with `contents: read` least privilege.

---

## Recommended fix order (Phase 1, ~1–2 days)

1. **C1 + C2** — Compose fails closed, random/required admin password, force rotation. (Deploy-blocking.)
2. **C3 + C7** — one `assertServerAccess` helper applied to server *and* config routes; ownership column for configs.
3. **C4** — enforce API-key permissions on every route; block key self-escalation.
4. **C5** — hash on update; regression test for SQLite + Mongo.
5. **C6** — DNS-resolution + CIDR validation, pinned IP; add `localtest.me`, `[::]`, `fd12::1` tests.
6. **H2 + H3** — dependency bumps and production-only `node_modules`; make `npm audit` blocking.

Phase 2: H4–H8, then M1–M12. Add regression tests for each deny case; keep one finding per PR per `AGENTS.md §8`.

---

## Verification commands

```bash
# C1 — forged admin token against the default stack
node -e "console.log(require('jsonwebtoken').sign({id:'1',tokenVersion:0},'your_jwt_secret_key_here'))"
curl -s http://localhost/api/v1/auth/users -H "Authorization: Bearer <token>"

# C3 — cross-user config apply (as a non-admin)
curl -s -X POST http://localhost/api/v1/caddy/configs \
  -H "Authorization: Bearer $USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"pwn","jsonConfig":{"apps":{}},"servers":[]}'
curl -s -X POST http://localhost/api/v1/caddy/configs/<configId>/apply \
  -H "Authorization: Bearer $USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"serverIds":["<adminServerId>"]}'

# C4 — read-only key performing a delete
curl -s -X DELETE http://localhost/api/v1/caddy/servers/1 -H "X-API-Key: <readOnlyKey>" -w '%{http_code}\n'

# C6 — SSRF aliases (expect 400 after fix)
curl -s -X POST http://localhost/api/v1/caddy/test-connection \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"apiUrl":"http://localtest.me","apiPort":2019,"adminApiPath":"/config/"}' -w '%{http_code}\n'

# H5 — ReDoS (expect fast 400 after fix)
python -c "print('a'*40+'!')"  # submit as email to PUT /api/v1/auth/update-profile
```

---

## Remediation follow-up — 2026-11-01

The initial findings above are retained as the baseline. The following deferred items were implemented on `fix/security-phase1` after the initial sweep:

| Finding | Follow-up |
|---|---|
| M4 — logout did not revoke copied tokens | Authenticated logout now increments `tokenVersion` in the active DB, clears current/legacy cookies, and rejects API-key logout. |
| M5 — CSP allowed `unsafe-eval` | Removed `vue3-json-editor` (which required eval), retained Ace as the JSON editor, and removed `unsafe-eval`. HSTS was removed from HTTP-only frontend/test Caddy listeners; configure it at the actual TLS terminator. |
| M7 — audit history could be modified without detection | New audit writes receive a sequence, previous hash, and SHA-256 entry hash in SQLite and MongoDB. Admins can verify via `GET /api/v1/audit-logs/integrity`; a damaged entry or broken link is reported. Legacy/expired history is reported as unanchored. |
| M9 — broad private-IP opt-in | Production private Caddy targets now require an exact `ALLOW_PRIVATE_HOSTS` entry. DNS answers are still checked; loopback, link-local, metadata, CGNAT, and non-RFC1918/ULA blocked ranges remain denied. `ALLOW_PRIVATE_IPS` is ignored in production. |
| MongoDB full-suite fixture parity | Mongo tests now use ObjectId-compatible user/server/config IDs; repository tests no longer force SQLite during Mongo runs. Full suite: 267 passed, 3 skipped. |

**Verification after follow-up:** SQLite Jest 271/271; MongoDB Jest 268 passed, 3 skipped; frontend `npm audit --audit-level=high` reported 0 vulnerabilities; frontend and test-edge Caddyfiles validated; merged test Compose config validated.

**Audit-chain limitation:** the chain detects accidental or partial database edits, but a database administrator capable of rewriting every row can recompute the chain. External signing/anchoring remains a separate hardening option. Retention policies can also remove old links; the verifier distinguishes a valid retained segment from a chain anchored at genesis.
