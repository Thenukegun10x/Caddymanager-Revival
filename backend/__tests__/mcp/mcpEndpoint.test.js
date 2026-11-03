/**
 * HTTP surface for MCP: off by default, API-key only, origin-allowlisted.
 */
jest.mock('../../services/pingService', () => ({
  startPingService: jest.fn().mockReturnValue({ running: false }),
  stopPingService: jest.fn(),
  getPingServiceStatus: jest.fn().mockReturnValue({ running: false }),
}));
jest.mock('../../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(null), cleanupOldLogs: jest.fn() }));
jest.mock('../../models/apiKey', () => ({ validateApiKey: jest.fn() }));
jest.mock('../../repositories/userRepository', () => ({ findById: jest.fn() }));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.create = jest.fn(() => ({ get: jest.fn(), post: jest.fn() }));
  return fn;
});

// CORS is computed at import time, so the allowlists must exist before the app loads.
const originalCors = process.env.CORS_ORIGIN;
const originalMcpEnabled = process.env.MCP_ENABLED;
const originalMcpOrigins = process.env.MCP_ALLOWED_ORIGIN;
process.env.CORS_ORIGIN = 'http://ui.local';
process.env.MCP_ENABLED = 'true';
process.env.MCP_ALLOWED_ORIGIN = 'http://agent.local:8080';

const request = require('supertest');
const axios = require('axios');
const ApiKey = require('../../models/apiKey');
const userRepository = require('../../repositories/userRepository');
const app = require('../../app');

const API_KEY = 'b'.repeat(64);
const ENDPOINT = '/api/v1/mcp';

function initialize() {
  return { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
}

function post(body = initialize(), headers = {}) {
  const req = request(app).post(ENDPOINT).set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return req.send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MCP_ENABLED = 'true';
  process.env.MCP_ALLOWED_ORIGIN = 'http://agent.local:8080';

  ApiKey.validateApiKey.mockResolvedValue({
    _id: 'k1',
    name: 'agent',
    userId: 'u1',
    permissions: { read: true, write: true, delete: false },
  });
  userRepository.findById.mockResolvedValue({
    id: 'u1',
    username: 'agent',
    email: 'agent@example.com',
    role: 'user',
    isActive: true,
  });
  axios.mockResolvedValue({ status: 200, data: { success: true, data: [] } });
});

afterAll(() => {
  if (originalCors === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = originalCors;
  if (originalMcpEnabled === undefined) delete process.env.MCP_ENABLED;
  else process.env.MCP_ENABLED = originalMcpEnabled;
  if (originalMcpOrigins === undefined) delete process.env.MCP_ALLOWED_ORIGIN;
  else process.env.MCP_ALLOWED_ORIGIN = originalMcpOrigins;
});

describe('MCP endpoint exposure', () => {
  test('is indistinguishable from a missing route when disabled', async () => {
    process.env.MCP_ENABLED = 'false';
    const response = await post(initialize(), { Authorization: `Bearer ${API_KEY}` });
    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Not found');
    expect(ApiKey.validateApiKey).not.toHaveBeenCalled();

    const disabledGet = await request(app).get(ENDPOINT);
    expect(disabledGet.status).toBe(404);
    const disabledPreflight = await request(app)
      .options(ENDPOINT)
      .set('Origin', 'http://agent.local:8080')
      .set('Access-Control-Request-Method', 'POST');
    expect(disabledPreflight.status).toBe(404);

    const disabledMalformed = await request(app)
      .post(ENDPOINT)
      .set('Content-Type', 'application/json')
      .send('{ invalid');
    expect(disabledMalformed.status).toBe(404);
  });

  test('rejects non-POST methods even when enabled', async () => {
    const response = await request(app).get(ENDPOINT).set('Authorization', `Bearer ${API_KEY}`);
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  test('requires an API key', async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/Authorization: Bearer/);
  });

  test('rejects JWT-shaped bearer tokens', async () => {
    const response = await post(initialize(), { Authorization: 'Bearer aaa.bbb.ccc' });
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/API key, not a JWT/);
    expect(ApiKey.validateApiKey).not.toHaveBeenCalled();
  });

  test('rejects invalid or expired keys', async () => {
    ApiKey.validateApiKey.mockResolvedValue(null);
    const response = await post(initialize(), { Authorization: `Bearer ${API_KEY}` });
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/Invalid or expired/);
  });

  test('rejects keys whose user is inactive', async () => {
    userRepository.findById.mockResolvedValue({ id: 'u1', isActive: false });
    const response = await post(initialize(), { Authorization: `Bearer ${API_KEY}` });
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/inactive/);
  });

  test('rejects browser origins outside MCP_ALLOWED_ORIGIN', async () => {
    const blocked = await post(initialize(), {
      Authorization: `Bearer ${API_KEY}`,
      Origin: 'http://ui.local',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/Origin is not allowed/);
    expect(ApiKey.validateApiKey).not.toHaveBeenCalled();

    const allowed = await post(initialize(), {
      Authorization: `Bearer ${API_KEY}`,
      Origin: 'http://agent.local:8080',
    });
    expect(allowed.status).toBe(200);
  });

  test('adds MCP_ALLOWED_ORIGIN to CORS while MCP is enabled', async () => {
    const response = await request(app)
      .options(ENDPOINT)
      .set('Origin', 'http://agent.local:8080')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://agent.local:8080');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  test('does not grant MCP-only origins CORS access to the REST API', async () => {
    const response = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://agent.local:8080');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('MCP JSON-RPC over HTTP', () => {
  test('initialize returns the negotiated protocol and server info', async () => {
    const response = await post(initialize(), { Authorization: `Bearer ${API_KEY}` });
    expect(response.status).toBe(200);
    expect(response.body.jsonrpc).toBe('2.0');
    expect(response.body.id).toBe(1);
    expect(response.body.result.serverInfo.name).toBe('caddymanager-mcp');
    expect(response.body.result.capabilities.tools).toBeDefined();
  });

  test('notifications return 202 with no body', async () => {
    const response = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { Authorization: `Bearer ${API_KEY}` },
    );
    expect(response.status).toBe(202);
    expect(response.text).toBe('');
  });

  test('tools/list is available to a read-only key', async () => {
    ApiKey.validateApiKey.mockResolvedValue({
      _id: 'k1',
      name: 'read only',
      userId: 'u1',
      permissions: { read: true, write: false, delete: false },
    });

    const response = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(response.status).toBe(200);
    expect(response.body.result.tools).toHaveLength(7);
  });

  test('a tool call is proxied to the REST API with the same key', async () => {
    axios.mockResolvedValue({
      status: 200,
      data: { success: true, data: [{ _id: 's1', name: 'caddy-1' }] },
    });

    const response = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_servers', arguments: {} } },
      { Authorization: `Bearer ${API_KEY}` },
    );

    expect(response.status).toBe(200);
    expect(response.body.result.structuredContent.servers).toEqual([
      expect.objectContaining({ id: 's1', name: 'caddy-1' }),
    ]);
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/api/v1/caddy/servers'),
      headers: expect.objectContaining({ 'x-api-key': API_KEY }),
    }));
  });

  test('malformed payloads produce a JSON-RPC invalid request', async () => {
    const response = await post([], { Authorization: `Bearer ${API_KEY}` });
    expect(response.status).toBe(200);
    expect(response.body.error.code).toBe(-32600);
  });

  test('malformed JSON bodies produce the JSON-RPC parse error shape', async () => {
    const response = await request(app)
      .post(ENDPOINT)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'application/json')
      .send('{ definitely not JSON');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(-32700);
    expect(response.body.error.message).toBe('Parse error');
  });
});
