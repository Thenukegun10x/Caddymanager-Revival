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
  DB_PATH="${SQLITE_DB_PATH:-/app/data/caddymanager.sqlite}"
  echo "[entrypoint] migrate DB (${DB_PATH})..."
  # Quick backup before migrate (if file exists and not :memory:)
  if [ -f "$DB_PATH" ] && [ "$DB_PATH" != ":memory:" ]; then
    TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
    BACKUP="${DB_PATH}.bak.${TS}"
    echo "[entrypoint] backup $DB_PATH -> $BACKUP"
    cp "$DB_PATH" "$BACKUP" 2>/dev/null && echo "[entrypoint] backup ok $(stat -c%s "$BACKUP" 2>/dev/null || wc -c < "$BACKUP") bytes" || echo "[entrypoint] backup failed (non-fatal)"
    # keep last 5 backups, prune older
    ls -t "${DB_PATH}".bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f || true
  else
    echo "[entrypoint] no DB file to backup (fresh :memory: or first boot)"
  fi
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
