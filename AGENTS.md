# AGENTS.md — Working in This Repo (Humans + AI)

> Hardened revival fork `Thenukegun10x/Caddymanager-Revival` of [`caddymanager/caddymanager@52f69b64`](https://github.com/caddymanager/caddymanager) (stale 2026-02-20). Full audit in [`PLAN.md`](./PLAN.md), attribution in [`NOTICE.md`](./NOTICE.md), disclosure in [`SECURITY.md`](./SECURITY.md).

This file is for **both** humans and coding agents (Muse, Cursor, Codex, Opencode). Follow it verbatim — it encodes the security fixes that prevent re-introducing `PLAN.md:4` Criticals.

---

## 1. Project Map

```
backend/               Node 20 Express, JWT + API keys, SQLite(:memory:/file) or Mongo
  app.js               cors, limits, routes mount, graceful shutdown
  middleware/authMiddleware.js  protect + authorize (JWT fallback bug here)
  controllers/         auth, caddy, apiKey, audit, convert, metrics, buildInfo
  services/            caddyService (SSRF surface), convert, ping, audit, metrics
  repositories/        SQL column injection surface (*Repository.js)
  models/              Mongoose + better-sqlite3 dual models
  __tests__/           jest + supertest + mongodb-memory-server
  scripts/generateBuildInfo.js
  Dockerfile           node:20-bullseye-slim (hardening target: bookworm)
  test-all-engines.sh  runs DB_ENGINE=sqlite + mongo
frontend/              Vue 3 + Vite + Pinia + Vue Router, ace-editor
  Caddyfile            :80 handle /config (runtime runtimeConfig), /api/* proxy
  src/stores/          authStore (localStorage token), caddy*
  src/services/        apiService, configService (api_base_url poison risk)
  src/components/configurations/*DataComp.vue  v-html XSS surface
development/           build-caddy-sandbox.sh, spin-caddy-servers.sh (targets)
docker-compose.yml     pull ghcr.io images (prod-like)
docker-compose.build.yml  build from ./backend, ./frontend (dev)
docker-compose.test.yml   edge caddy + isolated networks (test, see §3)
test/Caddyfile.edge    edge reverse_proxy frontend:80
PLAN.md / NOTICE.md / SECURITY.md  hardened fork docs
```

---

## 2. Quick Start (pick one)

### A. Bare metal (fastest for agents)
```bash
# backend
cd backend && npm ci && cp .env.example .env # set JWT_SECRET=$(openssl rand -hex 32)
npm run dev # :3000
# frontend in second shell
cd frontend && npm install && npm run dev # :5173, proxy to :3000 via vite.config.js
# login admin:caddyrocks -> change immediately
```

### B. Docker built from source (closest to CI)
```bash
docker compose -f docker-compose.build.yml up --build -d
# frontend :80 -> backend:3000 (via BACKEND_HOST)
curl -s http://localhost/api/v1/build-info | jq
docker compose -f docker-compose.build.yml logs -f backend
```

### C. Docker prebuilt images (prod-like, no build)
```bash
docker compose up -d # pulls caddymanager/caddymanager-backend:latest
```

### D. Isolated test stack (recommended for security verification — does not touch prod volumes)
```bash
docker compose -f docker-compose.build.yml -f docker-compose.test.yml up --build -d
# edge :18080 -> frontend:80 -> backend:3000, backend also on caddy-test-network to reach targets
./development/spin-caddy-servers.sh --number 2 --start-port 2019 --http-port 8000
./development/build-caddy-sandbox.sh --admin-port 2020 --http-port 8080
# add server in UI at http://localhost:18080 -> API URL http://caddy-server-1, Port 2019
docker compose -f docker-compose.build.yml -f docker-compose.test.yml down -v
```

---

## 3. Docker Compose Matrix

| File | Purpose | Images | Ports | Networks | When to use |
|------|---------|--------|-------|----------|-------------|
| `docker-compose.yml` | prod-like pull | `ghcr.io/caddymanager/*:latest` | frontend `80:80`, mongodb `27017` optional | `caddymanager` | demo, no code change |
| `docker-compose.build.yml` | local build | `build: ./backend, ./frontend` | same | `caddymanager` | dev, CI build parity |
| `docker-compose.test.yml` | isolated test (created here) | build + edge `caddy:2.10-alpine` | edge `18080:80`, frontend internal | `caddymanager` + `caddy-test-network` (external, created by spin scripts) | security PoCs, SSRF, CORS, don't pollute prod `sqlite_data` |

**`docker-compose.test.yml` source of truth:**
```yaml
# docker-compose.test.yml — consume with -f docker-compose.build.yml -f docker-compose.test.yml
services:
  caddy-edge:
    image: caddy:2.10-alpine
    container_name: caddy-test-edge
    ports: ["18080:80"]
    volumes: ["./test/Caddyfile.edge:/etc/caddy/Caddyfile:ro"]
    networks: [caddy-test-network, caddymanager]
    depends_on: [frontend]
  backend:
    networks: [caddymanager, caddy-test-network]
    environment:
      CORS_ORIGIN: "http://localhost:18080"
      CADDY_SANDBOX_URL: "http://caddy-sandbox:2020"
      JWT_SECRET: "${JWT_SECRET:?set in .env.test.local}" # fail fast, no fallback
volumes:
  sqlite_data: # ephemeral when down -v
networks:
  caddy-test-network:
    external: true
```

**`test/Caddyfile.edge`:**
```
:80 {
  reverse_proxy frontend:80
  header Strict-Transport-Security "max-age=31536000"
}
```

**Common env overrides:** see `.env.example` + `docker-compose.yml:24-41`. Always set `JWT_SECRET` via `openssl rand -hex 32`; never use `your_jwt_secret_key_here` nor empty. `CORS_ORIGIN` must be allowlist, not `*`. `DB_ENGINE=sqlite` default (`SQLITE_DB_PATH=/app/data/caddymanager.sqlite`), or `mongodb` with `MONGODB_URI`.

**Volumes:** `sqlite_data:/app/data` persists DB. Test stack `down -v` wipes it. Prod backup: `docker run --rm -v caddymanager_sqlite_data:/data -v $PWD:/backup alpine tar czf /backup/sqlite-$(date +%F).tgz /data`.

---

## 4. Environment Variables (canonical)

**Backend `backend/.env.example`:**
```
PORT=3000
DB_ENGINE=sqlite # sqlite | mongodb
SQLITE_DB_PATH=./caddymanager.sqlite # or :memory: for jest
MONGODB_URI=mongodb://mongoadmin:...@mongodb:27017/caddymanager?authSource=admin
CORS_ORIGIN=http://localhost:5173,http://localhost:80
LOG_LEVEL=debug
CADDY_SANDBOX_URL=http://localhost:2019
PING_INTERVAL=30000
PING_TIMEOUT=2000
AUDIT_LOG_MAX_SIZE_MB=100
AUDIT_LOG_RETENTION_DAYS=90
METRICS_HISTORY_MAX=1000
JWT_SECRET= # REQUIRED, 32+ hex, no fallback (fix for middleware/authMiddleware.js:6)
JWT_EXPIRATION=24h # code also reads JWT_EXPIRES_IN — support both
```

**Frontend `frontend/.env` / Caddy `{$APP_NAME}` / `{$DARK_MODE}` / `{$BACKEND_HOST}`:**
```
API_BASE_URL=http://localhost:3000/api/v1 # fallback if /config fails
APP_NAME=Caddy Manager
DARK_MODE=true
BACKEND_HOST=backend:3000 # for frontend/Caddyfile:12 reverse_proxy
```
`frontend/src/services/configService.js:9` fetches `/config` (served by `frontend/Caddyfile:2`) — validate it's same-origin `^/api(/|$)` or reject.

---

## 5. Testing — How to Prove Fixes Don't Break

### Unit / Integration (no docker)
```bash
cd backend
npm ci
DB_ENGINE=sqlite npm test                 # jest.setup.js uses :memory:
bash test-all-engines.sh                 # sqlite then mongo (needs mongod or uses mongodb-memory-server)
npm run test:coverage
```

### Docker smoke
```bash
docker compose -f docker-compose.build.yml up --build -d
curl -s http://localhost/api/v1/build-info | jq # 200
curl -s http://localhost/api/v1/metrics -w "%{http_code}\n" # 401 after H1 fix (was 200)
docker compose -f docker-compose.build.yml logs backend --tail 20
docker compose -f docker-compose.build.yml down -v
```

### Security PoCs (run against docker, expect DENY after Phase 1)
```bash
TOKEN=$(curl -s http://localhost:18080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"caddyrocks"}' | jq -r .token)
# C2 SSRF
curl -s http://localhost:18080/api/v1/caddy/test-connection -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"apiUrl":"http://169.254.169.254","apiPort":80,"adminApiPath":"/latest/meta-data/"}' | jq # -> 400
# C3 SQLi
curl -s -X PUT http://localhost:18080/api/v1/caddy/servers/1 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"x","\"; SELECT sql FROM sqlite_master; --":"x"}' | jq # -> 400 not 500
# C1 JWT
curl -s http://localhost:18080/api/v1/auth/users -H "Authorization: Bearer $(node -e "console.log(require('jsonwebtoken').sign({id:'1',role:'admin'},'your_jwt_secret_key_for_development'))")"
# H5 XSS manual: submit Caddyfile error containing <img src=x onerror=alert(1)> -> shows literal in frontend/src/components/configurations/configurationDataComp.vue:276
```

### Frontend
```bash
cd frontend && npm install && npm run build && npm run preview
# check no v-html exec, /config poison blocked, localStorage token replaced by httpOnly after fix
```

---

## 6. Development Helpers

```bash
./development/spin-caddy-servers.sh --number 3 --start-port 2019 --http-port 8000 # vanilla Caddy fleet on caddy-test-network
./development/build-caddy-sandbox.sh --admin-port 2020 --http-port 8080           # custom Caddy with plugins, only POST /adapt public
docker network inspect caddy-test-network
docker ps --filter "name=caddy-server-"
docker logs -f caddy-sandbox
```

To add servers in UI: `Servers -> Add Server -> API URL=http://caddy-server-1 (container DNS when backend on same network) or http://localhost, Port 2019, Path /config/`.

---

## 7. Agent Rules — Do Not Reintroduce PLAN.md:4 Bugs

- **JWT:** Never add `|| 'hardcoded'`. `backend/middleware/authMiddleware.js:6` must `throw if !JWT_SECRET`, `jwt.verify(..., {algorithms:['HS256']})`. Support `JWT_EXPIRATION` + `JWT_EXPIRES_IN`.
- **SSRF:** All `apiUrl/apiPort/adminApiPath` (services/caddyService.js:16,89,113, convertService.js:22, pingService.js:44, controllers/caddyController.js:68) must call `utils/ssrf.js:assertSafeUrl` — deny `10/8,172.16/12,192.168/16,169.254/16,127/8,::1`, enforce `http(s)://` + `^/[\w\/-]*$` for path, `maxRedirects:0`.
- **SQL:** Never interpolate `` `${key} = ?` ``. Whitelist `ALLOWED` in `repositories/*` and `models/*SQLiteModel.js:111`. Test column injection.
- **RBAC:** `router/caddyRoutes.js:8` must have `protect` + ownership check `createdBy===req.user.id || role===admin`. No handler without it.
- **Metrics:** `router/metricsRoutes.js:31` / `buildInfoRoutes.js` require `protect, authorize('admin')` or `127.0.0.1` allowlist.
- **CORS:** No `origin:'*' + credentials:true` (`app.js:30`). Use `CORS_ORIGIN` allowlist + `helmet()`. Limits `json:200kb, text:512kb`.
- **Frontend XSS:** No `v-html` on user/Caddy error data (`configurationDataComp.vue:276`, `dashboardPanelTextComp.vue:21`). Use `{{ }}` + `DOMPurify` if HTML needed.
- **Token:** No `localStorage['auth_token']` new code. Use `httpOnly Secure SameSite=Strict __Host-` cookie. Validate `configService.js:9 api_base_url` same-origin.
- **Deps:** `npm audit` 0 high before merge. Pin `axios@^1.15.3`, `express@4.22.1`, `mongoose>=7.8.10`.

---

## 8. Branching & PR

```
main (protected, hardened stable, tags v0.1-hardened.*)
develop (tracks upstream/main)
fix/jwt-secret, fix/ssrf-deny, fix/sql-whitelist, fix/rbac ...
```

- One P0 per PR, include jest test for deny case.
- PR must pass `npm test`, `npm audit --audit-level=high`, `trivy fs --severity CRITICAL`.
- Sync upstream: `git fetch upstream && git merge upstream/main --no-ff` into `develop`.

---

## 9. Repo Ops

```bash
# fork already: origin=Thenukegun10x/Caddymanager-Revival, upstream=caddymanager/caddymanager
gh repo view --web
gh api repos/Thenukegun10x/Caddymanager-Revival --jq '{html_url, fork, parent:{full_name}}'
docker compose config # validate merged yml
```

*Last verified: 2026-09-01 @14cfcbad. Keep this file updated with every docker-compose or env change.*
