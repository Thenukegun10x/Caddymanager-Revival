/**
 * Real localhost security smoke test for the MCP boundary.
 *
 * Unlike mcpEndpoint.test.js, this uses the real SQLite API-key model, JWT
 * middleware and REST proxy, and binds the app only to 127.0.0.1 on an
 * ephemeral port. The Jest setup uses SQLITE_DB_PATH=:memory:.
 */
jest.mock('../../services/pingService', () => ({
  startPingService: jest.fn().mockReturnValue({ running: false }),
  stopPingService: jest.fn(),
  getPingServiceStatus: jest.fn().mockReturnValue({ running: false }),
}));

const originalMcpEnabled = process.env.MCP_ENABLED;
const originalMcpOrigin = process.env.MCP_ALLOWED_ORIGIN;
const originalCorsOrigin = process.env.CORS_ORIGIN;
const originalMcpSelfUrl = process.env.MCP_SELF_URL;

process.env.MCP_ENABLED = 'true';
process.env.MCP_ALLOWED_ORIGIN = 'http://agent.local';
process.env.CORS_ORIGIN = 'http://ui.local';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const app = require('../../app');
const sqliteService = require('../../services/sqliteService');

const endpointPath = '/api/v1/mcp';
let server;
let baseUrl;
let userToken;
let apiKey;

async function postMcp(payload, token = apiKey, extraHeaders = {}) {
  return fetch(`${baseUrl}${endpointPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.MCP_SELF_URL = baseUrl;
  if (server.address().address !== '127.0.0.1') {
    throw new Error(`Local security smoke bound to unexpected address ${server.address().address}`);
  }

  const now = new Date().toISOString();
  const inserted = sqliteService.getDB().prepare(`
    INSERT INTO users (username, email, password, role, isActive, tokenVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('mcp-localhost-test', 'mcp-localhost@example.test', 'test-only-password-hash', 'user', 1, 0, now, now);
  userToken = jwt.sign(
    { id: inserted.lastInsertRowid, role: 'user', tokenVersion: 0 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );

  const created = await fetch(`${baseUrl}/api/v1/apikeys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'localhost-mcp-read-only',
      permissions: { read: true, write: false, delete: false },
    }),
  });
  if (created.status !== 201) {
    throw new Error(`Could not create isolated test API key (HTTP ${created.status})`);
  }
  const createdBody = await created.json();
  apiKey = createdBody.apiKey && createdBody.apiKey.key;
  if (!apiKey) throw new Error('API key plaintext was not returned at creation');
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [name, value] of [
    ['MCP_ENABLED', originalMcpEnabled],
    ['MCP_ALLOWED_ORIGIN', originalMcpOrigin],
    ['CORS_ORIGIN', originalCorsOrigin],
    ['MCP_SELF_URL', originalMcpSelfUrl],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('MCP localhost security smoke', () => {
  test('API key is random-looking, stored only as a hash, and not listed again', async () => {
    expect(apiKey).toMatch(/^[a-f0-9]{64}$/);

    const row = sqliteService.getDB()
      .prepare('SELECT key, keyPrefix FROM api_keys WHERE keyPrefix = ?')
      .get(apiKey.slice(0, 8));
    const expectedHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    expect(row.key).toBe(expectedHash);
    expect(row.key).not.toBe(apiKey);
    expect(row.keyPrefix).toBe(apiKey.slice(0, 8));

    const listed = await fetch(`${baseUrl}/api/v1/apikeys`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).not.toContain(apiKey);
    expect(listedBody.apiKeys[0].key).toBeUndefined();
    expect(listedBody.apiKeys[0].plaintextKey).toBeUndefined();
  });

  test('disabled MCP is 404 even on localhost, then valid API-key auth works', async () => {
    process.env.MCP_ENABLED = 'false';
    const hidden = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(hidden.status).toBe(404);

    process.env.MCP_ENABLED = 'true';
    const missing = await postMcp({ jsonrpc: '2.0', id: 2, method: 'initialize' }, null);
    expect(missing.status).toBe(401);

    const jwtRejected = await postMcp({ jsonrpc: '2.0', id: 3, method: 'initialize' }, 'not.a.jwt');
    expect(jwtRejected.status).toBe(401);

    const initialized = await postMcp({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
    expect(initialized.status).toBe(200);
    const body = await initialized.json();
    expect(body.result.serverInfo.name).toBe('caddymanager-mcp');
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  test('browser origin is MCP-allowlisted, not inherited from the REST CORS origin', async () => {
    const rejected = await postMcp(
      { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} },
      apiKey,
      { origin: 'http://ui.local' },
    );
    expect(rejected.status).toBe(403);

    const accepted = await postMcp(
      { jsonrpc: '2.0', id: 6, method: 'initialize', params: {} },
      apiKey,
      { origin: 'http://agent.local' },
    );
    expect(accepted.status).toBe(200);

    const rest = await fetch(`${baseUrl}/api/v1/health`, { headers: { origin: 'http://agent.local' } });
    expect(rest.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('read-only API key can use the localhost REST proxy but cannot patch', async () => {
    const list = await postMcp({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'list_servers', arguments: {} },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.result.structuredContent).toEqual({ servers: [], count: 0 });
    expect(JSON.stringify(listBody)).not.toContain(apiKey);

    const deniedWrite = await postMcp({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'patch_config',
        arguments: { configId: '1', operations: [{ op: 'remove', path: '/apps' }] },
      },
    });
    expect(deniedWrite.status).toBe(200);
    const deniedBody = await deniedWrite.json();
    expect(deniedBody.result.isError).toBe(true);
    expect(deniedBody.result.content[0].text).toContain('MCP_FORBIDDEN');
  });

  test('oversized localhost MCP payload is bounded before authentication', async () => {
    const response = await fetch(`${baseUrl}${endpointPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        padding: 'x'.repeat(1024 * 1024 + 10),
      }),
    });

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toBe('Request body too large');
  });
});
