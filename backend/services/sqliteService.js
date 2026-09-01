const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// SQLite DB file path from environment variables or use default
const sqlitePath = process.env.SQLITE_DB_PATH || path.join(__dirname, '../../caddymanager.sqlite');
let db;

const connectToSQLite = () => {
	try {
		db = new Database(sqlitePath);
		console.log(`Connected to SQLite at ${sqlitePath}`);
		// Bootstrap tables and admin user
		createTablesIfNeeded();
		createDefaultAdminIfNeeded();
	} catch (error) {
		console.error('Failed to connect to SQLite:', error.message);
		process.exit(1);
	}
};

// Create tables if they do not exist — ensure all app tables exist at boot
const createTablesIfNeeded = () => {
	// Users table
	db.prepare(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		email TEXT,
		password TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'user',
		isActive INTEGER NOT NULL DEFAULT 1,
		tokenVersion INTEGER NOT NULL DEFAULT 0,
		lastLogin TEXT,
		createdAt TEXT NOT NULL DEFAULT (datetime('now')),
		updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	try { db.prepare(`ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}

	// API Keys table
	db.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		userId INTEGER NOT NULL,
		permissions TEXT NOT NULL,
		lastUsed TEXT,
		expiresAt TEXT,
		createdAt TEXT NOT NULL,
		isActive INTEGER NOT NULL DEFAULT 1,
		FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
	)`).run();

	// Caddy Servers table (mirrors caddyServersSQLiteModel.ensureTable)
	db.prepare(`CREATE TABLE IF NOT EXISTS caddy_servers (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		apiUrl TEXT NOT NULL,
		apiPort INTEGER DEFAULT 2019,
		adminApiPath TEXT DEFAULT '/config/',
		active INTEGER DEFAULT 1,
		tags TEXT DEFAULT '[]',
		description TEXT,
		lastPinged TEXT,
		status TEXT DEFAULT 'unknown',
		activeConfig INTEGER,
		createdBy INTEGER,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	)`).run();
	// Backup before ALTER (pre-migration dump, idempotent, no-op for :memory:)
	try {
		if (sqlitePath !== ':memory:' && fs.existsSync(sqlitePath)) {
			const hasCol = db.prepare(`PRAGMA table_info(caddy_servers)`).all().some(r=>r.name==='createdBy');
			if (!hasCol) {
				const ts = new Date().toISOString().replace(/[:.]/g,'-');
				const backupPath = `${sqlitePath}.bak.${ts}`;
				try { db.prepare(`VACUUM INTO ?`).run(backupPath); console.log(`[migrate] backup (VACUUM) -> ${backupPath}`); }
				catch (_) { fs.copyFileSync(sqlitePath, backupPath); console.log(`[migrate] backup (copy) -> ${backupPath} (${fs.statSync(backupPath).size} bytes)`); }
			}
		}
	} catch (e) { console.warn(`[migrate] backup skipped: ${e.message}`); }
	try { db.prepare(`ALTER TABLE caddy_servers ADD COLUMN createdBy INTEGER`).run(); } catch (_) {}

	// Caddy Configs table (mirrors caddyConfigSQLiteModel.ensureTable)
	db.prepare(`CREATE TABLE IF NOT EXISTS caddy_configs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		servers TEXT NOT NULL,
		name TEXT NOT NULL,
		format TEXT NOT NULL DEFAULT 'json',
		jsonConfig TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'draft',
		metadata TEXT,
		history TEXT,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	)`).run();
	try { db.prepare(`ALTER TABLE caddy_configs ADD COLUMN history TEXT`).run(); } catch (_) {}

	// Audit Logs table
	db.prepare(`CREATE TABLE IF NOT EXISTS audit_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		action TEXT NOT NULL,
		userId INTEGER,
		username TEXT NOT NULL,
		resourceType TEXT NOT NULL,
		resourceId TEXT,
		details TEXT,
		statusCode INTEGER,
		ipAddress TEXT,
		userAgent TEXT,
		timestamp TEXT NOT NULL,
		createdAt TEXT NOT NULL,
		updatedAt TEXT NOT NULL
	)`).run();

	// Auto-migrate: backfill caddy_servers.createdBy NULL -> admin (idempotent)
	try {
		const nullCount = db.prepare(`SELECT COUNT(*) as c FROM caddy_servers WHERE createdBy IS NULL`).get().c;
		if (nullCount > 0) {
			let admin = null;
			try { admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get(); } catch (_) {}
			if (!admin) { try { admin = db.prepare(`SELECT id FROM users ORDER BY id LIMIT 1`).get(); } catch (_) {} }
			if (admin) {
				const info = db.prepare(`UPDATE caddy_servers SET createdBy=? WHERE createdBy IS NULL`).run(admin.id);
				if (info.changes > 0) console.log(`[migrate] auto-backfilled ${info.changes} caddy_servers.createdBy -> user ${admin.id}`);
			}
		}
		if (process.env.NODE_ENV !== 'test') {
			const chk = db.prepare(`PRAGMA integrity_check`).get();
			if (chk.integrity_check !== 'ok') console.error(`[migrate] integrity_check failed: ${chk.integrity_check}`);
		}
	} catch (e) {
		// Non-fatal — don't block boot on migration error (e.g., fresh DB races)
		console.warn(`[migrate] auto-backfill skipped: ${e.message}`);
	}
};

/**
 * Check if any users exist in the database.
 * If not, create a default admin user with credentials:
 * username: admin
 * password: caddyrocks
 */
const createDefaultAdminIfNeeded = () => {
	try {
		const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
		if (row.count === 0) {
			console.log('No users found in SQLite DB. Creating default admin user...');
			const username = 'admin';
			const rawPassword = 'caddyrocks';
			const hashedPassword = bcrypt.hashSync(rawPassword, 10);
			const now = new Date().toISOString();
			db.prepare(`INSERT INTO users (username, email, password, role, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
				.run(username, null, hashedPassword, 'admin', 1, now, now);
			console.log('Default admin user created successfully.');
			console.log(`Username: ${username}`);
			console.log('Password: [hidden]');
			console.log('Please change this password immediately after first login.');
		}
	} catch (error) {
		console.error('Error creating default admin user in SQLite:', error.message);
		// Don't exit the process here, just log the error
	}
};

module.exports = {
	connectToSQLite,
	getDB: () => db
};
