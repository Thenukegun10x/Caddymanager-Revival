const crypto = require('crypto');
const { getDB } = require('../../services/sqliteService');

// Helper to serialize/deserialize permissions as JSON
function serializePermissions(permissions) {
	return JSON.stringify(permissions);
}
function deserializePermissions(str) {
	try {
		return JSON.parse(str);
	} catch {
		return { read: true, write: false, delete: false };
	}
}

// Ensure table exists (should be called at bootstrap, but safe to call here)
function ensureTable() {
	const db = getDB();
	if (!db) return; // Database not initialized yet
	db.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		keyPrefix TEXT,
		userId INTEGER NOT NULL,
		permissions TEXT NOT NULL,
		lastUsed TEXT,
		expiresAt TEXT,
		createdAt TEXT NOT NULL,
		isActive INTEGER NOT NULL DEFAULT 1
	)`).run();
	const columns = db.prepare('PRAGMA table_info(api_keys)').all().map(c => c.name);
	if (!columns.includes('keyPrefix')) {
		db.prepare('ALTER TABLE api_keys ADD COLUMN keyPrefix TEXT').run();
	}
}

// Keys are stored as sha256(key) so a DB leak does not yield usable credentials (H1).
function hashKey(key) {
	return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// Don't call ensureTable() immediately - let the service handle table creation
// ensureTable();

const ApiKeySQLiteModel = {
	generateKey() {
		return crypto.randomBytes(32).toString('hex');
	},

	createApiKey(userId, name, permissions = {}, expiration = null) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const key = this.generateKey();
		const keyPrefix = key.slice(0, 8);
		const now = new Date();
		const expiresAt = expiration ? new Date(expiration) : (() => {
			const d = new Date();
			d.setFullYear(d.getFullYear() + 1);
			return d;
		})();
		const perms = { read: true, write: false, delete: false, ...permissions };
		const stmt = db.prepare(`INSERT INTO api_keys (name, key, keyPrefix, userId, permissions, expiresAt, createdAt, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		const info = stmt.run(
			name,
			hashKey(key),
			keyPrefix,
			userId,
			serializePermissions(perms),
			expiresAt.toISOString(),
			now.toISOString(),
			1
		);
		// key is returned once (plaintext) so the user can copy it; only its hash is stored.
		return { id: info.lastInsertRowid, _id: String(info.lastInsertRowid), name, key, keyPrefix, plaintextKey: key, userId, permissions: perms, expiresAt, createdAt: now, isActive: true };
	},

	validateApiKey(key) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND isActive = 1').get(hashKey(key));
		if (!row) return null;
		if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
		// Update lastUsed
		db.prepare('UPDATE api_keys SET lastUsed = ? WHERE id = ?').run(new Date().toISOString(), row.id);
		return {
			...row,
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		};
	},

	findAll(query = {}) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		let sql = 'SELECT id, name, keyPrefix, userId, permissions, lastUsed, expiresAt, createdAt, isActive FROM api_keys';
		const params = [];
		
		if (Object.keys(query).length > 0) {
			const conditions = [];
			if (query.userId) {
				conditions.push('userId = ?');
				params.push(query.userId);
			}
			if (query.isActive !== undefined) {
				conditions.push('isActive = ?');
				params.push(query.isActive ? 1 : 0);
			}
			if (conditions.length > 0) {
				sql += ' WHERE ' + conditions.join(' AND ');
			}
		}
		
		sql += ' ORDER BY createdAt DESC';
		
		const rows = db.prepare(sql).all(...params);
		return rows.map(row => ({
			...row,
			_id: String(row.id), // Convert to string and add for MongoDB compatibility
			id: String(row.id), // Convert id to string for consistency
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		}));
	},

	findByUserId(userId) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const rows = db.prepare('SELECT id, name, keyPrefix, userId, permissions, lastUsed, expiresAt, createdAt, isActive FROM api_keys WHERE userId = ? ORDER BY createdAt DESC').all(userId);
		return rows.map(row => ({
			...row,
			_id: row.id, // For MongoDB compatibility
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		}));
	},

	findById(id) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const row = db.prepare('SELECT id, name, keyPrefix, userId, permissions, lastUsed, expiresAt, createdAt, isActive FROM api_keys WHERE id = ?').get(id);
		if (!row) return null;
		return {
			...row,
			_id: String(row.id), // Convert to string and add for MongoDB compatibility
			id: String(row.id), // Convert id to string for consistency
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		};
	},

	findOne(query) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		let sql = 'SELECT id, name, keyPrefix, userId, permissions, lastUsed, expiresAt, createdAt, isActive FROM api_keys';
		const params = [];
		const conditions = [];

		if (query._id) {
			conditions.push('id = ?');
			params.push(query._id);
		}
		if (query.userId) {
			conditions.push('userId = ?');
			params.push(query.userId);
		}
		if (query.name) {
			conditions.push('name = ?');
			params.push(query.name);
		}
		if (query.isActive !== undefined) {
			conditions.push('isActive = ?');
			params.push(query.isActive ? 1 : 0);
		}

		if (conditions.length > 0) {
			sql += ' WHERE ' + conditions.join(' AND ');
		}

		const row = db.prepare(sql).get(...params);
		if (!row) return null;
		return {
			...row,
			_id: row.id, // For MongoDB compatibility
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		};
	},

	findByIdAndUpdate(id, updateData, options = {}) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const updateFields = [];
		const params = [];

		if (updateData.name) {
			updateFields.push('name = ?');
			params.push(updateData.name);
		}
		if (updateData.permissions) {
			updateFields.push('permissions = ?');
			params.push(serializePermissions(updateData.permissions));
		}
		if (updateData.isActive !== undefined) {
			updateFields.push('isActive = ?');
			params.push(updateData.isActive ? 1 : 0);
		}
		if (updateData.lastUsed) {
			updateFields.push('lastUsed = ?');
			params.push(updateData.lastUsed.toISOString());
		}

		if (updateFields.length === 0) {
			// No updates, just return current record
			return this.findById(id);
		}

		params.push(id);
		const sql = `UPDATE api_keys SET ${updateFields.join(', ')} WHERE id = ?`;
		const result = db.prepare(sql).run(...params);

		if (result.changes === 0) {
			return null; // Not found
		}

		return this.findById(id);
	},

	findOneAndUpdate(query, updateData, options = {}) {
		const existing = this.findOne(query);
		if (!existing) return null;
		return this.findByIdAndUpdate(existing.id, updateData, options);
	},

	findOneAndDelete(query) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const existing = this.findOne(query);
		if (!existing) return null;

		const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(existing.id);
		if (result.changes === 0) return null;
		
		return existing;
	},

	findByIdAndDelete(id) {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const existing = this.findById(id);
		if (!existing) return null;

		const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
		if (result.changes === 0) return null;
		
		return existing;
	},

	findAllWithUsers() {
		const db = getDB();
		if (!db) throw new Error('Database not initialized');
		
		const sql = `
			SELECT 
				ak.id, ak.name, ak.keyPrefix, ak.userId, ak.permissions, ak.lastUsed, ak.expiresAt, ak.createdAt, ak.isActive,
				u.username, u.email
			FROM api_keys ak
			LEFT JOIN users u ON ak.userId = u.id
			ORDER BY ak.createdAt DESC
		`;
		
		const rows = db.prepare(sql).all();
		return rows.map(row => ({
			id: row.id,
			_id: row.id, // For MongoDB compatibility
			name: row.name,
			userId: {
				_id: row.userId,
				id: row.userId,
				username: row.username,
				email: row.email
			},
			permissions: deserializePermissions(row.permissions),
			lastUsed: row.lastUsed ? new Date(row.lastUsed) : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
			createdAt: row.createdAt ? new Date(row.createdAt) : null,
			isActive: !!row.isActive
		}));
	},

	// Mongoose compatibility - alias for findAll
	find(query = {}) {
		return {
			select: (fields) => ({
				sort: (sortObj) => ({
					lean: () => this.findAll(query),
					populate: (path, select) => ({
						sort: (sortObj) => ({
							lean: () => {
								if (path === 'userId') {
									return this.findAllWithUsers().filter(item => {
										if (query.userId) return item.userId.id === query.userId;
										return true;
									});
								}
								return this.findAll(query);
							}
						})
					})
				}),
				lean: () => this.findAll(query)
			}),
			lean: () => this.findAll(query),
			populate: (path, select) => ({
				sort: (sortObj) => ({
					lean: () => {
						if (path === 'userId') {
							return this.findAllWithUsers().filter(item => {
								if (query.userId) return item.userId.id === query.userId;
								return true;
							});
						}
						return this.findAll(query);
					}
				})
			})
		};
	}
};

module.exports = ApiKeySQLiteModel;
