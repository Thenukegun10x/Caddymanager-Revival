> **Hardened & upgraded — the maintained successor to CaddyManager.** `Thenukegun10x/Caddymanager-Revival` takes [`caddymanager/caddymanager`](https://github.com/caddymanager/caddymanager) (dead since 2026-02-20) and closes every finding from the 2026-11-01 security sweep (see [`SECURITY-SWEEP-2026-11-01.md`](./SECURITY-SWEEP-2026-11-01.md)) — JWT fail-closed, SSRF with connect-time DNS pinning, SQL whitelists, per-user object ownership, scoped API keys — plus Docker image hardening. Full audit in [`PLAN.md`](./PLAN.md), attribution in [`NOTICE.md`](./NOTICE.md). Original MIT © 2025 B Stolk.
>
> **Images:** Docker Hub [`conormorris/caddymanager-backend`](https://hub.docker.com/r/conormorris/caddymanager-backend) · [`conormorris/caddymanager-frontend`](https://hub.docker.com/r/conormorris/caddymanager-frontend) (multi-arch amd64 + arm64). `latest` = the phase-1 hardened build as of 2026-11-02 (backend digest `26ec6c3a`, frontend `25b45168`); a versioned release tag lands with the `v0.1-hardened.1` merge. `JWT_SECRET` and `ADMIN_PASSWORD` are required (compose fails closed).

# CaddyManager (Revival)

Easily manage your Caddy2 servers using a modern web UI, built on the MEVN stack with support for both SQLite and MongoDB databases.

> **Caution:** CaddyManager is in active development. Please _backup your Caddy configurations_ and data before testing. This fork ships the hardened security model below, but any reverse-proxy control plane should run on a network you control.

## 🔒 What this fork adds over upstream

- **Auth hardening** — JWT fails closed (no fallback secret, `HS256` pinned, `tokenVersion` revocation incl. logout), httpOnly `__Host-` cookie sessions, bcrypt timing equalizer, password policy + linear-time email validation
- **SSRF shield** — connect-time DNS validation with pinned resolved IPs (ipaddr CIDR checks, full IPv6: ULA/`::`/link-local), metadata always denied, exact-host production allowlist (`ALLOW_PRIVATE_HOSTS`), `maxRedirects: 0`
- **Object-level RBAC** — servers and configs scoped by `createdBy`; a normal user can no longer read/apply/delete other users' Caddy configs; metrics/build-info/Swagger are admin-gated
- **Scoped API keys** — SHA-256 at rest, 8-char display prefix, read/write/delete enforced per route, keys barred from auth & key-management endpoints
- **Verifiable audit log** — SHA-256 hash chain (sequence + prev-hash) with admin integrity endpoint `/api/v1/audit-logs/integrity`
- **Injection-safe data layer** — column whitelists in every SQLite update path, parameterized throughout, generic error responses with correlation IDs
- **Edge & transport** — helmet, CORS allowlist (deny by default), rate limits (login/API/test-connection), `Cache-Control: no-store` on auth, no `v-html`/`eval` in the SPA, CSP without `unsafe-eval`
- **Supply chain** — production images carry prod-deps only, non-root UID 10001, pinned Actions, `npm audit` blocking at HIGH in CI, Trivy fs gates, dual-engine (SQLite + MongoDB) jest suites


---

![CaddyManager Demo](https://caddymanager.online/screenshots/screenshots.gif)

## 🚀 Features

- **Dual Database Support:**
  - Choose between SQLite (default, zero-setup) or MongoDB for data storage.
- **Multi-Server Management:**
  - Add, remove, and monitor multiple Caddy2 servers from a single dashboard.
- **Configuration Editor:**
  - Create, edit, and validate Caddyfiles with syntax highlighting and templates.
- **User Authentication:**
  - Secure login, JWT-based sessions, and role-based access control.
- **API Key Management:**
  - Generate and revoke API keys for programmatic access.
- **Audit Logging:**
  - Track all user and system actions with a SHA-256 hash chain; admins can verify it at `/api/v1/audit-logs/integrity`.
- **Real-Time Status:**
  - Live server health checks and status updates.
- **Integrated Swagger API Docs:**
  - Explore and test backend APIs directly from the UI.
- **Responsive Design:**
  - Works great on desktop and mobile devices.

---

## 📢 Status
Phase 1 hardening complete and CI-verified on [`PR #1`](https://github.com/Thenukegun10x/Caddymanager-Revival/pull/1) → `main`; first release `v0.1-hardened.1`. `develop` tracks upstream for future syncs — upstream is unmaintained, so this fork is the primary source.

Releases follow a single-version, tag-driven flow: `scripts/release.sh` bumps both packages, writes `CHANGELOG.md`, proves native `linux/amd64` + `linux/arm64` builds, then tags; CI publishes and verifies that `:latest` matches the release manifest on both registries. See [RELEASING.md](RELEASING.md) for the runbook and `AGENTS.md` §10 for the mandatory rules.

---

## 🚀 Quick start (Docker Hub images)

```bash
# .env next to docker-compose.yml:
#   JWT_SECRET=$(openssl rand -hex 32)   REQUIRED
#   ADMIN_PASSWORD=<12+ chars>           REQUIRED on first boot
docker compose pull && docker compose up -d
# then login at http://localhost as admin:<ADMIN_PASSWORD>
```

## 🐳 Docker Compose Example

The `docker-compose.yml` below runs both backend and frontend from the Revival images. SQLite is the default; MongoDB is optional via the overlay:

```yaml
services:
  # Backend API server
  backend:
    # conormorris/* = hardened Revival builds (this fork). Upstream caddymanager/* is dead + unpatched.
    # `latest` = phase-1 hardened build (2026-11-02). Tags: https://hub.docker.com/r/conormorris/caddymanager-backend/tags
    image: conormorris/caddymanager-backend:latest
    container_name: caddymanager-backend
    restart: unless-stopped
    environment:
      - PORT=3000
      # Database Engine Configuration (defaults to SQLite)
      - DB_ENGINE=sqlite  # Options: 'sqlite' or 'mongodb'
      # SQLite Configuration (used when DB_ENGINE=sqlite)
      - SQLITE_DB_PATH=/app/data/caddymanager.sqlite
      # MongoDB Configuration (only when DB_ENGINE=mongodb) — set the full URI in .env
      - MONGODB_URI=${MONGODB_URI:-}
      - CORS_ORIGIN=http://localhost,http://localhost:80
      - LOG_LEVEL=debug
      - CADDY_SANDBOX_URL=http://localhost:2019
      - PING_INTERVAL=30000
      - PING_TIMEOUT=2000
      - AUDIT_LOG_MAX_SIZE_MB=100
      - AUDIT_LOG_RETENTION_DAYS=90
      - METRICS_HISTORY_MAX=1000  # Optional: max number of in-memory metric history snapshots to keep
      # REQUIRED in .env: openssl rand -hex 32. Compose fails closed if unset.
      - JWT_SECRET=${JWT_SECRET:?set JWT_SECRET in .env (openssl rand -hex 32)}
      - JWT_EXPIRATION=24h
      # REQUIRED on first boot when the users table is empty (12+ chars)
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
    # Backend is now only accessible through frontend proxy
    volumes:
      - sqlite_data:/app/data  # SQLite database storage
    networks:
      - caddymanager

  # Frontend web UI
  frontend:
    image: conormorris/caddymanager-frontend:latest
    container_name: caddymanager-frontend
    restart: unless-stopped
    depends_on:
      - backend
    environment:
      - BACKEND_HOST=backend:3000
      - APP_NAME=Caddy Manager
      - DARK_MODE=true
    ports:
      - "80:80"  # Expose web UI
    networks:
      - caddymanager

networks:
  caddymanager:
    driver: bridge

volumes:
  sqlite_data:   # SQLite database storage

# Notes:
# - SQLite is the default database engine - no additional setup required!
# - To use the bundled MongoDB, set DB_ENGINE, MONGODB_URI and MONGO_PASSWORD in
#   .env and run: docker compose -f docker-compose.yml -f docker-compose.mongodb.yml up -d
# - For production, use strong passwords and a secrets manager.
# - The backend uses SQLite by default, storing data in a persistent volume.
# - The frontend proxies all /api/* requests to the backend service.
# - Backend is not directly exposed - all API access goes through the frontend proxy.
```

---

## 🧩 Environment Variables

### Frontend (`frontend/.env`)
Create a `.env` file in the `frontend/` directory with the following variables:

```
API_BASE_URL=http://localhost:3000/api/v1
APP_NAME=Caddy Manager
DARK_MODE=true
```
- `API_BASE_URL`: The base URL for backend API requests - should be the url for your backend api
- `APP_NAME`: The display name for the app UI.
- `DARK_MODE`: Set to `true` to enable dark mode by default. Currently not integrated fully.

### Backend (`backend/.env`)
Create a `.env` file in the `backend/` directory with the following variables:

```
PORT=3000
# Database Engine Configuration
DB_ENGINE=sqlite  # Options: 'sqlite' or 'mongodb'
# SQLite Configuration (used when DB_ENGINE=sqlite)
SQLITE_DB_PATH=./caddymanager.sqlite
# MongoDB Configuration (used when DB_ENGINE=mongodb)
MONGODB_URI=mongodb://<user>:<password>@localhost:27017/caddymanager?authSource=admin
CORS_ORIGIN=http://localhost:5173
LOG_LEVEL=debug
CADDY_SANDBOX_URL=http://localhost:2019
ALLOW_PRIVATE_HOSTS= # exact private Caddy target hostnames, comma-separated
ALLOW_PRIVATE_IPS=false # non-production/test only; ignored in production
PING_INTERVAL=30000
PING_TIMEOUT=2000
AUDIT_LOG_MAX_SIZE_MB=100
AUDIT_LOG_RETENTION_DAYS=90
# REQUIRED: 32+ chars (openssl rand -hex 32). The backend refuses to boot otherwise.
JWT_SECRET=
JWT_EXPIRATION=24h
ALLOW_BEARER_TOKEN=false
# REQUIRED on first boot with an empty users table (12+ chars)
ADMIN_PASSWORD=
```
- `PORT`: Port for the backend server.
- `DB_ENGINE`: Database engine to use (`sqlite` or `mongodb`). Defaults to `sqlite`.
- `SQLITE_DB_PATH`: Path to SQLite database file (used when `DB_ENGINE=sqlite`).
- `MONGODB_URI`: MongoDB connection string (used when `DB_ENGINE=mongodb`).
- `CORS_ORIGIN`: Allowed origin for frontend requests - should be the url of your frontend.
- `LOG_LEVEL`: Logging verbosity.
- `CADDY_SANDBOX_URL`: URL for the Caddy sandbox server (for testing) and/or validating configs.
- `ALLOW_PRIVATE_HOSTS`: Exact private target hostnames explicitly trusted in production; their DNS results are still checked and metadata/link-local destinations are denied.
- `ALLOW_PRIVATE_IPS`: Broad private-target opt-in for development/tests only; ignored in production.
- `PING_INTERVAL` / `PING_TIMEOUT`: Health check intervals (ms).
- `AUDIT_LOG_MAX_SIZE_MB` / `AUDIT_LOG_RETENTION_DAYS`: Audit log settings.
- `METRICS_HISTORY_MAX`: Optional max number of in-memory metric history snapshots to keep (default: 1000).
- `JWT_SECRET` / `JWT_EXPIRATION`: JWT credential settings

> **Note:** On first boot, set `ADMIN_PASSWORD` (12+ characters) in `.env` before starting the backend. The bootstrap admin is `admin` with that password. The old public `caddyrocks` default has been removed.

> **Tip:** Copy `.env.example` to `.env` in each directory and adjust values as needed for your environment.

---

## 🗄️ Database Options

CaddyManager supports two database engines:

### SQLite (Default)
- **Zero Configuration**: Works out of the box, no setup required
- **Single File**: All data stored in a single `.sqlite` file
- **Perfect for**: Small to medium deployments, development, testing
- **Automatic Setup**: Creates the `admin` user from `ADMIN_PASSWORD` on first run (no public default)

### MongoDB
- **Scalable**: Better for high-traffic, multi-user environments
- **Perfect for**: Large deployments
- **Setup Required**: Requires MongoDB server installation

To switch between databases, simply change the `DB_ENGINE` environment variable and restart the backend.

---

## 📚 Documentation
- [Caddy Documentation](https://caddyserver.com/docs/)
- [CaddyManager Docs](https://caddymanager.online/#/docs)
- [Swagger API Docs](http://localhost:3000/api-docs) (after starting backend)

## 📈 Metrics & Prometheus

This project exposes runtime and application metrics that can be scraped by Prometheus or fetched as JSON for dashboards.

- Prometheus exposition endpoint (text format): `/api/v1/metrics/prometheus`
- JSON metrics (aggregated): `/api/v1/metrics`

Minimal Prometheus scrape fragment (add under `scrape_configs:` in your `prometheus.yml`):

```yaml
- job_name: 'caddymanager'
  metrics_path: /api/v1/metrics/prometheus
  static_configs:
    - targets: ['localhost:3000']
```

Quick test (returns Prometheus text format):

```
curl http://localhost:3000/api/v1/metrics/prometheus
```

Notes:
- The in-memory metric history size is controlled by the `METRICS_HISTORY_MAX` env var (default shown in the Docker Compose example).
- If you run Prometheus behind a proxy or need auth headers, adjust the scrape job accordingly.


---

## 🤝 Contributing
Contributions are welcome! Please open issues and pull requests to help improve CaddyManager.

---

## 📦 Tech Stack
- **Frontend:** Vue 3, Vite, Pinia, Vue Router
- **Backend:** Node.js, Express
- **Database:** SQLite (default) or MongoDB
- **Caddy Integration:** RESTful API for Caddy2 server management

---

## 🧪 Development: Caddy Test Servers

For local testing with real Caddy servers, see [`development/USAGE.md`](development/USAGE.md) for scripts to:
- Build and run a custom Caddy sandbox server with popular plugins
- Spin up multiple vanilla Caddy servers for multi-server testing

---

## 🛠️ Getting Started using local development environment

1. **Clone the repository:**
   ```sh
   git clone https://github.com/Thenukegun10x/Caddymanager-Revival.git
   cd Caddymanager-Revival
   ```
2. **Install dependencies:**
   ```sh
   cd backend && npm install
   cd ../frontend && npm install
   ```
3. **Configure environment (optional):**
   - SQLite works out of the box with no configuration needed!
   - For custom settings, copy `.env.example` to `.env` in both `backend/` and `frontend/` directories
4. **Run the app:**
   - Start backend:
     ```sh
     cd backend && npm start
     ```
   - Start frontend:
     ```sh
     cd frontend && npm run dev
     ```
5. **Login:**
   - Admin username: `admin`
   - Password: the `ADMIN_PASSWORD` you set in `.env`

---

## 🖥️ How to Use CaddyManager

1. **Access the Web UI:**
   - Open your browser and go to `http://localhost` (or the address where your frontend is running).

2. **Sign In:**
   - Log in as `admin` with the `ADMIN_PASSWORD` you configured.

3. **Add and Manage Servers:**
   - Navigate to the "Servers" section to add, edit, or remove Caddy servers.
   - You can monitor server status and view details for each server.

4. **Edit Configurations:**
   - Use the "Configurations" section to create, edit, and validate Caddyfiles.
   - Built-in syntax highlighting and templates help you avoid errors.

5. **User & API Key Management:**
   - Manage users and roles in the "User Management" section (admin only).
   - Generate and revoke API keys for programmatic access in the "API Keys" section.

6. **Audit Logs & Status:**
   - View audit logs for all user/system actions in the "Audit Logs" section (admin only).

7. **API Documentation:**
   - Explore and test backend APIs via the integrated Swagger UI at `/api-docs` (e.g., `http://localhost:3000/api-docs`).

---

## 🛡️ License & Legal
This project is open source and available under the [MIT License](LICENSE).

This project is not endorsed by, directly affiliated with, maintained, authorized, or sponsored by Caddy, Matthew Holt, Stack Holdings GmbH, or ZeroSSL. The name "Caddy" is a registered trademark of Stack Holdings GmbH. All information about Caddy, its history, and trademarks is provided for reference only.

---

## 📬 Get in Touch

Have questions, feedback, or want to contribute? Feel free to reach out:

- Open an issue or pull request on [GitHub](https://github.com/Thenukegun10x/Caddymanager-Revival) — this fork is the active one
- Security reports: see [`SECURITY.md`](./SECURITY.md) (do not open public issues for vulnerabilities)
- Upstream attribution: original project by B Stolk ([caddymanager/caddymanager](https://github.com/caddymanager/caddymanager), MIT © 2025), unmaintained since 2026-02-20
