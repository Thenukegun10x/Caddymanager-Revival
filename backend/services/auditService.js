
const auditLogRepository = require('../repositories/auditLogRepository');

/**
 * Audit Service - Logs user actions that change data in the system
 * Excludes monitoring operations such as ping services
 */

const skipActions = ['ping', 'healthCheck', 'statusCheck'];

const auditService = {
  /**
   * Log an audit event
   */
  async logAction({
    action,
    user,
    resourceType,
    resourceId,
    details,
    statusCode,
    ipAddress,
    userAgent
  }) {
    try {
      if (skipActions.includes(action)) {
        return null;
      }
      // Normalize user object for both DBs
      const log = {
        action,
        user: {
          userId: user?.id || user?._id,
          username: user?.username || 'system'
        },
        resourceType,
        resourceId: resourceId?.toString() || null,
        details,
        statusCode,
        ipAddress,
        userAgent
      };
      return await auditLogRepository.create(log);
    } catch (error) {
      console.error('Failed to create audit log:', error);
      return null;
    }
  },

  /**
   * Get audit logs with filtering and pagination (Set F)
   */
  async getAuditLogs({ filter = {}, limit = 100, skip = 0, sort = { timestamp: -1 } } = {}) {
    try {
      limit = Math.min(Math.max(parseInt(limit) || 100, 1), 100);
      skip = Math.max(parseInt(skip) || 0, 0);
      // Normalize Mongo-style filter keys (user.username as regex) for SQLite
      const norm = { ...filter };
      if (filter['user.username']) {
        const v = filter['user.username'];
        norm.username = typeof v === 'object' && v.$regex ? v.$regex : v;
        delete norm['user.username'];
      }
      if (filter['user.userId']) {
        const v = filter['user.userId'];
        norm.userId = typeof v === 'object' && v.$regex ? v.$regex : v;
        delete norm['user.userId'];
      }
      filter = norm;
      // Try repository with filter if available (Mongo)
      if (typeof auditLogRepository.findWithFilter === 'function') {
        return await auditLogRepository.findWithFilter(filter, { limit, skip, sort });
      }
      // Fallback: fetch and filter in-memory (SQLite)
      const all = await auditLogRepository.findAll({ limit: 1000, offset: 0 });
      let filtered = all.filter(log => {
        const logUserId = log.user?.userId ?? log.userId;
        const logUsername = log.user?.username ?? log.username;
        if (filter.action && log.action !== filter.action) return false;
        if (filter.resourceType && log.resourceType !== filter.resourceType) return false;
        if (filter.resourceId && String(log.resourceId) !== String(filter.resourceId)) return false;
        if (filter.userId && String(logUserId) !== String(filter.userId)) return false;
        if (filter.username && !String(logUsername || '').toLowerCase().includes(String(filter.username).toLowerCase())) return false;
        if (filter.startDate) {
          const start = new Date(filter.startDate);
          if (!isNaN(start) && new Date(log.timestamp) < start) return false;
        }
        if (filter.endDate) {
          const end = new Date(filter.endDate);
          if (!isNaN(end) && new Date(log.timestamp) > end) return false;
        }
        return true;
      });
      // Sort by timestamp desc by default
      filtered.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
      const total = filtered.length;
      const logs = filtered.slice(skip, skip + limit);
      return {
        logs,
        pagination: {
          total,
          limit,
          skip,
          hasMore: skip + limit < total
        }
      };
    } catch (error) {
      console.error('Failed to retrieve audit logs:', error);
      throw error;
    }
  },

  /**
   * Get audit logs for a specific resource
   */
  async getResourceAuditLogs(resourceType, resourceId, options = {}) {
    return auditLogRepository.findByResource(resourceType, resourceId, options);
  },

  /**
   * Get audit logs for a specific user
   */
  async getUserAuditLogs(userId, options = {}) {
    return auditLogRepository.findByUser(userId, options);
  },

  /**
   * Get statistics about actions in the audit logs
   */
  async getActionStats() {
    const stats = await auditLogRepository.getStats();
    return stats.byAction || [];
  },

  /**
   * Get statistics about resources in the audit logs
   */
  async getResourceStats() {
    const stats = await auditLogRepository.getStats();
    return stats.byResourceType || [];
  },

  /**
   * Get statistics about users in the audit logs
   */
  async getUserStats(limit = 10) {
    // Not implemented in SQLite, only available in MongoDB
    if (typeof auditLogRepository.getUserStats === 'function') {
      return auditLogRepository.getUserStats(limit);
    }
    return [];
  },

  /**
   * Get daily activity counts for the past days
   */
  async getDailyActivity(days = 30) {
    // Not implemented in SQLite, only available in MongoDB
    if (typeof auditLogRepository.getDailyActivity === 'function') {
      return auditLogRepository.getDailyActivity(days);
    }
    return [];
  },

  /**
   * Get unique values for a field in the audit logs
   */
  async getUniqueValues(field) {
    if (typeof auditLogRepository.getUniqueValues === 'function') {
      return auditLogRepository.getUniqueValues(field);
    }
    return [];
  },

  /**
   * Get unique users from the audit logs
   */
  async getUniqueUsers(limit = 50) {
    if (typeof auditLogRepository.getUniqueUsers === 'function') {
      return auditLogRepository.getUniqueUsers(limit);
    }
    return [];
  },

  /**
   * Cleanup old audit logs based on retention (Set D)
   */
  async cleanupOldLogs() {
    const days = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
    if (!days || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString();
    try {
      if ((process.env.DB_ENGINE || 'sqlite') === 'mongodb') {
        const AuditLog = require('../models/auditLog');
        const res = await AuditLog.deleteMany({ timestamp: { $lt: cutoff } });
        if (res.deletedCount > 0) console.log(`[audit] cleaned ${res.deletedCount} logs older than ${days}d`);
        return res.deletedCount;
      } else {
        const db = require('./sqliteService').getDB();
        if (!db) return 0;
        // Ensure table exists before delete
        try { db.prepare(`SELECT 1 FROM audit_logs LIMIT 1`).get(); } catch { return 0; }
        const info = db.prepare(`DELETE FROM audit_logs WHERE timestamp < ?`).run(cutoffIso);
        if (info.changes > 0) console.log(`[audit] cleaned ${info.changes} logs older than ${days}d`);
        return info.changes;
      }
    } catch (e) {
      console.warn(`[audit] cleanup failed: ${e.message}`);
      return 0;
    }
  }
};

module.exports = auditService;