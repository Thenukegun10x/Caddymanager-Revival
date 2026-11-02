/**
 * H1 regression tests — only sha256(key) may be persisted, the plaintext is
 * returned exactly once, and read paths never expose the stored hash.
 */
const crypto = require('crypto');

const dbEngine = process.env.DB_ENGINE || 'sqlite';

const describeIfSqlite = dbEngine === 'sqlite' ? describe : describe.skip;

describeIfSqlite('API key storage (H1)', () => {
  let ApiKey;
  let sqliteService;
  let userRepository;

  let ownerId;

  beforeAll(async () => {
    ApiKey = require('../../models/apiKey/apiKeySQLiteModel');
    sqliteService = require('../../services/sqliteService');
    userRepository = require('../../repositories/userRepository');

    const users = await userRepository.findAll();
    if (users.length > 0) {
      ownerId = users[0].id || users[0]._id;
    } else {
      const createdUser = await userRepository.create({
        username: 'key-owner',
        email: 'key-owner@example.com',
        password: 'password12345',
        role: 'user',
      });
      ownerId = createdUser.id || createdUser._id;
    }
  });

  test('stores a hash and returns the plaintext once', async () => {
    const created = ApiKey.createApiKey(
      ownerId,
      'hash-test-key',
      { read: true, write: false, delete: false }
    );

    const plaintext = created.plaintextKey;
    expect(typeof plaintext).toBe('string');
    expect(plaintext).toHaveLength(64);
    expect(created.key).toBe(plaintext);

    const row = sqliteService
      .getDB()
      .prepare('SELECT key, keyPrefix FROM api_keys WHERE id = ?')
      .get(created.id);

    const expectedHash = crypto.createHash('sha256').update(plaintext).digest('hex');
    expect(row.key).toBe(expectedHash);
    expect(row.key).not.toBe(plaintext);
    expect(row.keyPrefix).toBe(plaintext.slice(0, 8));

    // The plaintext validates; the stored hash must not be usable as a credential.
    expect(ApiKey.validateApiKey(plaintext)).toBeTruthy();
    expect(ApiKey.validateApiKey(expectedHash)).toBeNull();
  });

  test('read paths never return the stored key hash', async () => {
    const created = ApiKey.createApiKey(ownerId, 'read-path-key');

    const listed = ApiKey
      .findByUserId(ownerId)
      .find(item => String(item.id) === String(created.id));

    expect(listed).toBeDefined();
    expect(listed.key).toBeUndefined();
    expect(listed.keyPrefix).toBe(created.plaintextKey.slice(0, 8));

    const fetched = ApiKey.findById(created.id);
    expect(fetched.key).toBeUndefined();
  });

  test('revoking a key makes the plaintext unusable', async () => {
    const created = ApiKey.createApiKey(ownerId, 'revoke-test-key');

    expect(ApiKey.validateApiKey(created.plaintextKey)).toBeTruthy();
    ApiKey.findByIdAndUpdate(created.id, { isActive: false });
    expect(ApiKey.validateApiKey(created.plaintextKey)).toBeNull();
  });
});
