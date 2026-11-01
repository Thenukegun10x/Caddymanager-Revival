const auditLogRepository = require('../../repositories/auditLogRepository');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../app');
const userRepository = require('../../repositories/userRepository');

function logEntry(action, resourceId) {
  return {
    action,
    user: { username: 'integrity-test' },
    resourceType: 'system',
    resourceId,
    details: { source: 'audit-integrity-regression-test' },
    statusCode: 200,
  };
}

describe('Audit hash chain (M7)', () => {
  test('serializes concurrent appends and links each entry to its predecessor', async () => {
    const [first, second] = await Promise.all([
      auditLogRepository.create(logEntry('integrity_append_a', 'm7-a')),
      auditLogRepository.create(logEntry('integrity_append_b', 'm7-b')),
    ]);

    expect(first.chainSequence).toBeDefined();
    expect(second.chainSequence).toBe(first.chainSequence + 1);
    expect(second.previousHash).toBe(first.entryHash);
    expect(first.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.entryHash).toMatch(/^[a-f0-9]{64}$/);

    const integrity = await auditLogRepository.verifyChain();
    expect(integrity.valid).toBe(true);
    expect(integrity.checked).toBeGreaterThanOrEqual(2);
  });

  test('detects changed audit content', async () => {
    const created = await auditLogRepository.create(logEntry('integrity_tamper_test', 'm7-tamper'));
    const id = created.id || created._id;

    if (process.env.DB_ENGINE === 'mongodb') {
      const AuditLog = require('../../models/auditLog');
      await AuditLog.updateOne({ _id: id }, { $set: { details: { tampered: true } } });
    } else {
      const db = require('../../services/sqliteService').getDB();
      db.prepare('UPDATE audit_logs SET details = ? WHERE id = ?')
        .run(JSON.stringify({ tampered: true }), id);
    }

    const integrity = await auditLogRepository.verifyChain();
    expect(integrity.valid).toBe(false);
    expect(integrity.failure.reason).toBe('entry hash mismatch');
  });

  test('integrity endpoint is admin-only', async () => {
    const suffix = Date.now().toString(36);
    const regularUser = await userRepository.create({
      username: `integrity-user-${suffix}`,
      password: 'AuditTestPassword123!',
      role: 'user',
    });
    const adminUser = await userRepository.create({
      username: `integrity-admin-${suffix}`,
      password: 'AuditTestPassword123!',
      role: 'admin',
    });
    const tokenFor = user => jwt.sign({
      id: user.id || user._id,
      tokenVersion: user.tokenVersion || 0,
    }, process.env.JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });

    const forbidden = await request(app)
      .get('/api/v1/audit-logs/integrity')
      .set('Authorization', `Bearer ${tokenFor(regularUser)}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .get('/api/v1/audit-logs/integrity')
      .set('Authorization', `Bearer ${tokenFor(adminUser)}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toHaveProperty('valid');
  });
});
