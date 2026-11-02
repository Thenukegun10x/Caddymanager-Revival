// Unified repository for audit log data access
// This abstracts away the differences between Mongoose and SQLite models

const AuditLogModel = require('../models/auditLog');
const crypto = require('crypto');

const GENESIS_HASH = '0'.repeat(64);
const isMongoModel = typeof AuditLogModel.findOne === 'function';
let mongoAppendQueue = Promise.resolve();

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
    }
    return result;
  }
  return value;
}

function hashAuditEntry(record) {
  const userId = record.user?.userId ?? record.userId ?? null;
  const username = record.user?.username ?? record.username ?? 'system';
  const timestamp = record.timestamp instanceof Date
    ? record.timestamp.toISOString()
    : new Date(record.timestamp).toISOString();
  const payload = {
    chainSequence: Number(record.chainSequence),
    previousHash: record.previousHash,
    action: record.action,
    user: { userId: userId == null ? null : String(userId), username },
    resourceType: record.resourceType,
    resourceId: record.resourceId ?? null,
    details: record.details ?? {},
    statusCode: record.statusCode ?? null,
    ipAddress: record.ipAddress ?? null,
    userAgent: record.userAgent ?? null,
    timestamp,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(payload)))
    .digest('hex');
}

function withChainFields(log, sequence, previousHash) {
  const entry = {
    ...log,
    timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
    chainSequence: sequence,
    previousHash,
  };
  entry.entryHash = hashAuditEntry(entry);
  return entry;
}

function sqliteChainHead() {
  const db = require('../services/sqliteService').getDB();
  return db.prepare(
    'SELECT chainSequence, entryHash FROM audit_logs WHERE chainSequence IS NOT NULL ORDER BY chainSequence DESC LIMIT 1'
  ).get() || null;
}

async function appendMongo(log, retries = 0) {
  const latest = await AuditLogModel.findOne({ chainSequence: { $exists: true } })
    .sort({ chainSequence: -1 })
    .select('chainSequence entryHash')
    .lean();
  const sequence = (latest?.chainSequence || 0) + 1;
  const entry = withChainFields(log, sequence, latest?.entryHash || GENESIS_HASH);

  try {
    return await AuditLogModel.create(entry);
  } catch (error) {
    // The unique sequence index serializes appends across backend instances.
    if (error && error.code === 11000 && retries < 8) return appendMongo(log, retries + 1);
    throw error;
  }
}

function normalizeRecordForHash(record) {
  const normalized = { ...record };
  if (!normalized.user && (record.userId !== undefined || record.username !== undefined)) {
    normalized.user = { userId: record.userId ?? null, username: record.username || 'system' };
  }
  if (typeof normalized.details === 'string') {
    try { normalized.details = JSON.parse(normalized.details); } catch (_) {}
  }
  return normalized;
}

const auditLogRepository = {
  create(log) {
    if (typeof AuditLogModel.create !== 'function') throw new Error('AuditLogModel.create not implemented');
    if (isMongoModel) {
      const pending = mongoAppendQueue.then(() => appendMongo(log));
      mongoAppendQueue = pending.catch(() => undefined);
      return pending;
    }
    const latest = sqliteChainHead();
    const entry = withChainFields(log, (latest?.chainSequence || 0) + 1, latest?.entryHash || GENESIS_HASH);
    return AuditLogModel.create(entry);
  },

  async verifyChain() {
    let records;
    let legacyEntries;
    if (isMongoModel) {
      [records, legacyEntries] = await Promise.all([
        AuditLogModel.find({ chainSequence: { $exists: true } }).sort({ chainSequence: 1 }).lean(),
        AuditLogModel.countDocuments({ $or: [{ chainSequence: { $exists: false } }, { chainSequence: null }] }),
      ]);
    } else {
      const db = require('../services/sqliteService').getDB();
      const rows = db.prepare('SELECT * FROM audit_logs WHERE chainSequence IS NOT NULL ORDER BY chainSequence ASC').all();
      records = rows.map(normalizeRecordForHash);
      legacyEntries = db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE chainSequence IS NULL').get().count;
    }

    let previous = null;
    let checked = 0;
    let failure = null;
    for (const raw of records) {
      const entry = normalizeRecordForHash(raw);
      const sequence = Number(entry.chainSequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        failure = { sequence: entry.chainSequence, reason: 'invalid sequence' };
        break;
      }
      if (previous) {
        if (sequence !== previous.sequence + 1) {
          failure = { sequence, reason: 'sequence gap or duplicate' };
          break;
        }
        if (entry.previousHash !== previous.entryHash) {
          failure = { sequence, reason: 'previous hash mismatch' };
          break;
        }
      } else if (sequence === 1 && entry.previousHash !== GENESIS_HASH) {
        failure = { sequence, reason: 'genesis hash mismatch' };
        break;
      }

      const computed = hashAuditEntry(entry);
      if (computed !== entry.entryHash) {
        failure = { sequence, reason: 'entry hash mismatch' };
        break;
      }
      checked += 1;
      previous = { sequence, entryHash: entry.entryHash };
    }

    const firstSequence = records.length ? Number(records[0].chainSequence) : null;
    const anchored = !failure && legacyEntries === 0 && (records.length === 0 || firstSequence === 1);
    return {
      valid: !failure,
      anchored,
      checked,
      legacyEntries,
      firstSequence,
      lastSequence: previous?.sequence ?? null,
      failure,
      message: failure
        ? `Audit chain verification failed at sequence ${failure.sequence}: ${failure.reason}`
        : anchored
          ? 'Audit chain is valid and anchored at genesis.'
          : 'Retained chain segment is valid, but legacy or expired entries prevent full-history anchoring.',
    };
  },

  async findAll({ limit = 100, offset = 0 } = {}) {
    // Normalize caller-controlled pagination consistently across Mongo/SQLite.
    limit = Math.max(1, parseInt(limit, 10) || 100);
    offset = Math.max(0, parseInt(offset, 10) || 0);
    if (typeof AuditLogModel.find === 'function') {
      // Mongoose
      return AuditLogModel.find({})
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    }
    // SQLite
    return AuditLogModel.findAll({ limit, offset });
  },

  async findById(id) {
    if (typeof AuditLogModel.findById === 'function') {
      const result = await AuditLogModel.findById(id);
      if (result && typeof result.toObject === 'function') {
        // Mongoose document
        return result.toObject();
      }
      // SQLite result or null
      return result;
    }
    throw new Error('AuditLogModel.findById not implemented');
  },

  async findByResource(resourceType, resourceId, { limit = 100, offset = 0 } = {}) {
    if (typeof AuditLogModel.find === 'function') {
      // Mongoose
      return AuditLogModel.find({ resourceType, resourceId })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    }
    // SQLite
    return AuditLogModel.findByResource(resourceType, resourceId, { limit, offset });
  },

  async findByUser(userId, { limit = 100, offset = 0 } = {}) {
    if (typeof AuditLogModel.find === 'function') {
      // Mongoose
      return AuditLogModel.find({ 'user.userId': userId })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean();
    }
    // SQLite
    return AuditLogModel.findByUser(userId, { limit, offset });
  },

  async getFilterOptions() {
    if (typeof AuditLogModel.distinct === 'function') {
      // Mongoose
      const actions = await AuditLogModel.distinct('action');
      const resourceTypes = await AuditLogModel.distinct('resourceType');
      const users = await AuditLogModel.distinct('user.username');
      return { actions, resourceTypes, users };
    }
    // SQLite
    return AuditLogModel.getFilterOptions();
  },

  async getStats() {
    if (typeof AuditLogModel.aggregate === 'function') {
      // Mongoose aggregation for stats
      const total = await AuditLogModel.countDocuments();
      const byAction = await AuditLogModel.aggregate([
        { $group: { _id: '$action', count: { $sum: 1 } } }
      ]);
      const byResourceType = await AuditLogModel.aggregate([
        { $group: { _id: '$resourceType', count: { $sum: 1 } } }
      ]);
      return {
        total,
        byAction: byAction.map(a => ({ action: a._id, count: a.count })),
        byResourceType: byResourceType.map(r => ({ resourceType: r._id, count: r.count }))
      };
    }
    // SQLite
    return AuditLogModel.getStats();
  }
};

module.exports = auditLogRepository;
