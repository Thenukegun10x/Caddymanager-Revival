#!/usr/bin/env node
/**
 * Migration 20250901 — add caddy_servers.createdBy (nullable FK to users.id)
 * Idempotent, non-destructive. Backfills NULL -> admin (or first user) if present.
 * Run: node scripts/migrate-20250901-add-createdBy.js
 * Env: SQLITE_DB_PATH (defaults to ../../caddymanager.sqlite), DB_ENGINE=sqlite
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const sqlitePath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../../caddymanager.sqlite');
console.log(`[migrate] DB: ${sqlitePath}`);

let db;
try {
  db = new Database(sqlitePath);
} catch (e) {
  console.error(`[migrate] open failed: ${e.message}`);
  process.exit(1);
}

function hasColumn(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

function tableExists(table) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return !!row;
}

try {
  if (!tableExists('caddy_servers')) {
    console.log('[migrate] caddy_servers table missing — will be created by app boot, nothing to migrate');
    process.exit(0);
  }
  const before = db.prepare(`SELECT COUNT(*) as c FROM caddy_servers`).get().c;
  console.log(`[migrate] rows before: ${before}`);

  const needsMigrate = !hasColumn('caddy_servers', 'createdBy');
  if (needsMigrate) {
    // Backup before ALTER (quick dump)
    if (sqlitePath !== ':memory:' && fs.existsSync(sqlitePath)) {
      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      const backupPath = `${sqlitePath}.bak.${ts}`;
      try { db.prepare(`VACUUM INTO ?`).run(backupPath); console.log(`[migrate] backup (VACUUM) -> ${backupPath}`); }
      catch (_) { fs.copyFileSync(sqlitePath, backupPath); console.log(`[migrate] backup (copy) -> ${backupPath} (${fs.statSync(backupPath).size} bytes)`); }
    }
    console.log('[migrate] adding column caddy_servers.createdBy INTEGER');
    db.prepare(`ALTER TABLE caddy_servers ADD COLUMN createdBy INTEGER`).run();
    console.log('[migrate] column added');
  } else {
    console.log('[migrate] column already exists — skip ADD (no backup needed)');
  }

  // Verify no corruption: pragma integrity_check
  const integrity = db.prepare(`PRAGMA integrity_check`).get();
  console.log(`[migrate] integrity_check: ${integrity.integrity_check}`);
  if (integrity.integrity_check !== 'ok') {
    console.error('[migrate] integrity_check failed!');
    process.exit(1);
  }

  // Backfill NULL -> admin
  const nullCount = db.prepare(`SELECT COUNT(*) as c FROM caddy_servers WHERE createdBy IS NULL`).get().c;
  console.log(`[migrate] NULL createdBy rows: ${nullCount}`);
  if (nullCount > 0) {
    let admin = null;
    try { admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get(); } catch (_) {}
    if (!admin) {
      try { admin = db.prepare(`SELECT id FROM users ORDER BY id LIMIT 1`).get(); } catch (_) {}
    }
    if (admin) {
      const info = db.prepare(`UPDATE caddy_servers SET createdBy=? WHERE createdBy IS NULL`).run(admin.id);
      console.log(`[migrate] backfilled ${info.changes} rows -> user ${admin.id}`);
    } else {
      console.log('[migrate] no users found — leaving NULL (app allows NULL for backwards compat)');
    }
  }

  const after = db.prepare(`SELECT COUNT(*) as c FROM caddy_servers`).get().c;
  console.log(`[migrate] rows after: ${after}`);
  if (before !== after) {
    console.error('[migrate] row count changed — potential corruption!');
    process.exit(1);
  }

  // Spot-check a row
  const sample = db.prepare(`SELECT id, name, createdBy FROM caddy_servers LIMIT 3`).all();
  console.log(`[migrate] sample: ${JSON.stringify(sample)}`);

  // Idempotency: run ALTER again should be no-op
  if (hasColumn('caddy_servers', 'createdBy')) {
    console.log('[migrate] idempotency check: column exists, second run would skip');
  }

  console.log('[migrate] done — no corruption detected');
} catch (e) {
  console.error(`[migrate] failed: ${e.message}\n${e.stack}`);
  process.exit(1);
} finally {
  if (db) db.close();
}
