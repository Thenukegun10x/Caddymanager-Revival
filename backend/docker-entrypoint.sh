#!/bin/sh
set -e
# Docker entrypoint — auto-migrates SQLite (no user intervention)
# - Runs generateBuildInfo (idempotent)
# - Runs DB migration 20250901 (idempotent, backfills createdBy)
# - Then execs main CMD (npm start)

echo "[entrypoint] Caddymanager-Revival boot"

# 1. Build info (from build args)
if [ -f scripts/generateBuildInfo.js ]; then
  echo "[entrypoint] generateBuildInfo..."
  node scripts/generateBuildInfo.js || echo "[entrypoint] generateBuildInfo failed (non-fatal)"
fi

# 2. Auto-migrate (only for sqlite; mongodb is schemaless)
if [ "${DB_ENGINE:-sqlite}" = "sqlite" ]; then
  echo "[entrypoint] migrate DB (${SQLITE_DB_PATH:-/app/data/caddymanager.sqlite})..."
  # Run migration script; it is idempotent and handles missing table / already-migrated
  if [ -f scripts/migrate-20250901-add-createdBy.js ]; then
    node scripts/migrate-20250901-add-createdBy.js || echo "[entrypoint] migrate script failed (non-fatal, will also auto-migrate on connect)"
  fi
  echo "[entrypoint] DB ready"
else
  echo "[entrypoint] DB_ENGINE=${DB_ENGINE} — skip sqlite migrate"
fi

# 3. Exec main process (as node user)
echo "[entrypoint] starting: $@"
exec "$@"
