const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    trim: true
  },
  user: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    username: {
      type: String,
      required: true
    }
  },
  resourceType: {
    type: String,
    required: true,
    enum: ['config', 'server', 'user', 'apiKey', 'system', 'other']
  },
  resourceId: {
    type: String
  },
  details: {
    type: Object,
    default: {}
  },
  statusCode: {
    type: Number
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  chainSequence: {
    type: Number,
    min: 1
  },
  previousHash: {
    type: String,
    match: /^[a-f0-9]{64}$/
  },
  entryHash: {
    type: String,
    match: /^[a-f0-9]{64}$/
  }
}, {
  // Enable automatic timestamps
  timestamps: true
});

// At most one writer may claim each sequence number. Concurrent instances retry
// on duplicate-key conflict and append after the winning writer.
auditLogSchema.index({ chainSequence: 1 }, { unique: true, sparse: true });

// TTL index for retention (Set D)
const retentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
if (retentionDays > 0) {
  auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });
}

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
