/**
 * MCP tool layer: protocol shape, permission gates, and the safety rules that
 * make an agent safe to point at a live Caddy server.
 *
 * The REST API is mocked at the axios boundary; these tests assert what the MCP
 * layer sends and refuses to send, not how Express handles it.
 */
jest.mock('axios');
jest.mock('../../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(null) }));

const axios = require('axios');
const mcpService = require('../../services/mcpService');
const { digest } = require('../../utils/jsonPatch');

const WRITE_KEY = 'a'.repeat(64);

function makeReq(permissions = { read: true, write: true }, extra = {}) {
  return {
    mcpApiKey: WRITE_KEY,
    headers: { 'user-agent': 'jest' },
    ip: '127.0.0.1',
    user: {
      id: 'u1',
      username: 'agent',
      role: 'user',
      isApiRequest: true,
      apiKey: { id: 'k1', name: 'agent key', permissions },
    },
    ...extra,
  };
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function toolResult(payload) {
  expect(payload.result).toBeDefined();
  return JSON.parse(payload.result.content[0].text);
}

const CONFIG = {
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [':80'],
          routes: [
            {
              match: [{ host: ['example.com'] }],
              handle: [{ handler: 'file_server', root: '/srv' }],
            },
          ],
        },
      },
    },
  },
};

function mockApi(handler) {
  axios.mockImplementation(async (options) => handler(options));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi((options) => {
    if (options.method === 'GET') {
      return {
        status: 200,
        data: { success: true, data: { _id: 'cfg1', name: 'site', status: 'draft', jsonConfig: CONFIG } },
      };
    }
    return { status: 200, data: { success: true, data: {} } };
  });
});

describe('MCP protocol', () => {
  test('initialize advertises tools only', async () => {
    const { status, body } = await mcpService.handlePayload(makeReq(), rpc('initialize', {}));
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe(mcpService.PROTOCOL_VERSION);
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe('caddymanager-mcp');
  });

  test('initialize accepts a supported older protocol version', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('initialize', { protocolVersion: '2024-11-05' }),
    );
    expect(body.result.protocolVersion).toBe('2024-11-05');
  });

  test('notifications are accepted with 202 and no body', async () => {
    const { status, body } = await mcpService.handlePayload(makeReq(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(status).toBe(202);
    expect(body).toBeUndefined();
  });

  test('an explicit null ID is not treated as a notification', async () => {
    const { status, body } = await mcpService.handlePayload(makeReq(), {
      jsonrpc: '2.0',
      id: null,
      method: 'ping',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ jsonrpc: '2.0', id: null, result: {} });
  });

  test('invalid JSON-RPC IDs are rejected', async () => {
    const { body } = await mcpService.handlePayload(makeReq(), {
      jsonrpc: '2.0',
      id: true,
      method: 'ping',
    });
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBeNull();
  });

  test('tools/list exposes the seven bounded tools', async () => {
    const { body } = await mcpService.handlePayload(makeReq(), rpc('tools/list'));
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      'apply_config',
      'list_configs',
      'list_servers',
      'patch_config',
      'read_config',
      'save_config',
      'validate_config',
    ]);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
    }
  });

  test('unknown methods and tools are JSON-RPC errors', async () => {
    const method = await mcpService.handlePayload(makeReq(), rpc('resources/list'));
    expect(method.body.error.code).toBe(-32601);

    const tool = await mcpService.handlePayload(makeReq(), rpc('tools/call', { name: 'exec_shell' }));
    expect(tool.body.error.code).toBe(-32602);
  });

  test('batches larger than 20 are rejected', async () => {
    const batch = Array.from({ length: 21 }, (_, index) => rpc('ping', {}, index + 1));
    const { body } = await mcpService.handlePayload(makeReq(), batch);
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/Batch too large/);
  });
});

describe('MCP read tools', () => {
  test('read_config summarizes by default and returns a digest', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'read_config', arguments: { configId: 'cfg1' } }),
    );

    const result = toolResult(body);
    expect(result.source).toBe('saved');
    expect(result.digest).toBe(digest(CONFIG));
    expect(result.summary.http.servers[0].routes[0].handlers[0]).toEqual(
      expect.objectContaining({ type: 'file_server', root: '/srv' }),
    );
    expect(result.config).toBeUndefined();
  });

  test('read_config requires exactly one of serverId/configId', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'read_config', arguments: { serverId: 's1', configId: 'cfg1' } }),
    );
    expect(body.result.isError).toBe(true);
    expect(toolResult(body).error).toBe('MCP_INVALID_ARGUMENT');
  });

  test('read_config on a live server uses skipSave=true', async () => {
    mockApi(() => ({ status: 200, data: { success: true, data: CONFIG } }));

    await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'read_config', arguments: { serverId: 's1' } }),
    );

    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: expect.stringContaining('/caddy/servers/s1/current-config?skipSave=true'),
    }));
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': WRITE_KEY }),
    }));
  });

  test('read_config save=true creates an inactive draft snapshot', async () => {
    mockApi((options) => {
      if (options.method === 'GET') {
        return { status: 200, data: { success: true, data: CONFIG } };
      }
      return {
        status: 201,
        data: { success: true, data: { _id: 'snapshot1', name: options.data.name, status: 'draft' } },
      };
    });

    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'read_config',
        arguments: { serverId: 's1', save: true, name: 'before maintenance' },
      }),
    );

    const result = toolResult(body);
    expect(result.configId).toBe('snapshot1');
    expect(result.name).toBe('before maintenance');
    expect(result.digest).toBe(digest(CONFIG));

    const calls = axios.mock.calls.map(([options]) => options);
    expect(calls[0].url).toContain('/current-config?skipSave=true');
    expect(calls[1]).toEqual(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/caddy/servers/s1/configs'),
      data: expect.objectContaining({ status: 'draft', jsonConfig: CONFIG, name: 'before maintenance' }),
    }));
    expect(calls.some((options) => options.url.includes('skipSave=false'))).toBe(false);
  });

  test('read_config save=true is a mutation and needs write permission', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq({ read: true, write: false }),
      rpc('tools/call', { name: 'read_config', arguments: { serverId: 's1', save: true } }),
    );

    expect(toolResult(body).error).toBe('MCP_FORBIDDEN');
    expect(axios).not.toHaveBeenCalled();
  });

  test('list_servers forwards the API key, not a Bearer token', async () => {
    mockApi(() => ({ status: 200, data: { success: true, data: [{ _id: 's1', name: 'caddy-1' }] } }));

    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'list_servers', arguments: {} }),
    );

    expect(toolResult(body).servers).toEqual([
      expect.objectContaining({ id: 's1', name: 'caddy-1' }),
    ]);
    const options = axios.mock.calls[0][0];
    expect(options.headers['x-api-key']).toBe(WRITE_KEY);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.proxy).toBe(false);
  });
});

describe('MCP write tools', () => {
  test('patch_config applies RFC 6902 ops and returns the new digest', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: {
          configId: 'cfg1',
          operations: [{ op: 'replace', path: '/apps/http/servers/srv0/listen/0', value: ':8080' }],
        },
      }),
    );

    const result = toolResult(body);
    expect(result.previousDigest).toBe(digest(CONFIG));
    expect(result.operationsApplied).toBe(1);

    const put = axios.mock.calls.find(([options]) => options.method === 'PUT');
    expect(put).toBeTruthy();
    expect(put[0].url).toContain('/caddy/configs/cfg1/content');
    expect(put[0].data.jsonConfig.apps.http.servers.srv0.listen).toEqual([':8080']);
  });

  test('patch_config rejects a patch whose pointer does not exist and never writes', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: {
          configId: 'cfg1',
          operations: [{ op: 'replace', path: '/apps/nope', value: 1 }],
        },
      }),
    );

    const result = toolResult(body);
    expect(body.result.isError).toBe(true);
    expect(result.error).toBe('MCP_PATCH_INVALID');
    expect(axios.mock.calls.some(([options]) => options.method === 'PUT')).toBe(false);
  });

  test('hostile or malformed agent edits never reach the REST write endpoint', async () => {
    const attacks = [
      { op: 'add', path: '/__proto__/polluted', value: true },
      { op: 'copy', from: '/constructor/prototype', path: '/copied' },
      { op: 'move', from: '/apps', path: '/apps/http/servers/srv0/child' },
      { op: 'replace', path: '', value: ['not', 'a', 'config', 'object'] },
      { op: 'remove', path: '/apps/http/servers/srv0/listen/-' },
      { op: 'replace', path: '/apps/http/servers/srv0/listen/01', value: ':9999' },
      { op: 'execute', path: '/apps', value: 'not supported' },
    ];

    for (const operation of attacks) {
      axios.mockClear();
      const { body } = await mcpService.handlePayload(
        makeReq(),
        rpc('tools/call', {
          name: 'patch_config',
          arguments: { configId: 'cfg1', operations: [operation] },
        }),
      );

      expect(body.result.isError).toBe(true);
      expect(toolResult(body).error).toBe('MCP_PATCH_INVALID');
      expect(axios.mock.calls.some(([options]) => options.method === 'PUT')).toBe(false);
      expect({}.polluted).toBeUndefined();
    }
  });

  test('patch_config rejects over-limit operation lists without writing', async () => {
    const operations = Array.from({ length: 101 }, () => ({
      op: 'test',
      path: '/apps/http/servers/srv0/listen/0',
      value: ':80',
    }));
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'patch_config', arguments: { configId: 'cfg1', operations } }),
    );

    expect(toolResult(body).error).toBe('MCP_PATCH_INVALID');
    expect(axios.mock.calls.some(([options]) => options.method === 'PUT')).toBe(false);
  });

  test('patch_config refuses a stale expectedDigest', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: {
          configId: 'cfg1',
          expectedDigest: `sha256:${'0'.repeat(64)}`,
          operations: [{ op: 'replace', path: '/apps/http/servers/srv0/listen/0', value: ':8080' }],
        },
      }),
    );

    expect(toolResult(body).error).toBe('MCP_CONFLICT');
    expect(axios.mock.calls.some(([options]) => options.method === 'PUT')).toBe(false);
  });

  test('patch_config rejects malformed expectedDigest before reading the config', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: {
          configId: 'cfg1',
          expectedDigest: 'sha256:not-a-digest',
          operations: [{ op: 'remove', path: '/apps' }],
        },
      }),
    );

    expect(toolResult(body).error).toBe('MCP_INVALID_ARGUMENT');
    expect(axios).not.toHaveBeenCalled();
  });

  test('save_config rejects non-object JSON', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'save_config',
        arguments: { serverId: 's1', name: 'bad', json: [1, 2, 3] },
      }),
    );
    expect(toolResult(body).error).toBe('MCP_INVALID_CONFIG');
  });

  test('validate_config calls the read-only validate endpoint', async () => {
    mockApi(() => ({
      status: 200,
      data: { success: true, data: { configId: 'cfg1', valid: true, results: [] } },
    }));

    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'validate_config',
        arguments: { configId: 'cfg1', serverIds: ['s1', 's2'] },
      }),
    );

    expect(toolResult(body).valid).toBe(true);
    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: expect.stringContaining('/caddy/configs/cfg1/validate?serverIds=s1%2Cs2'),
    }));
  });

  test('apply_config requires confirmation unless it is a dry run', async () => {
    const blocked = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'apply_config', arguments: { configId: 'cfg1' } }),
    );
    expect(toolResult(blocked.body).error).toBe('MCP_CONFIRMATION_REQUIRED');
    expect(axios.mock.calls.some(([options]) => options.method === 'POST')).toBe(false);

    const dryRun = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', { name: 'apply_config', arguments: { configId: 'cfg1', dryRun: true } }),
    );
    expect(dryRun.body.result.isError).toBeFalsy();
    const post = axios.mock.calls.find(([options]) => options.method === 'POST');
    expect(post[0].url).toContain('/caddy/configs/cfg1/apply');
    expect(post[0].data).toEqual({ dryRun: true });
  });

  test('apply_config checks the live digest when one is supplied', async () => {
    mockApi((options) => options.method === 'POST'
      ? {
        status: 409,
        data: {
          success: false,
          message: 'Live config changed since it was read',
          data: {
            failed: [{
              conflict: true,
              expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
              currentLiveDigest: digest(CONFIG),
            }],
          },
        },
      }
      : { status: 200, data: { success: true, data: {} } });

    const { body } = await mcpService.handlePayload(
      makeReq(),
      rpc('tools/call', {
        name: 'apply_config',
        arguments: {
          configId: 'cfg1',
          serverIds: ['s1'],
          confirm: true,
          expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
        },
      }),
    );

    const conflict = toolResult(body);
    expect(conflict.error).toBe('MCP_CONFLICT');
    expect(conflict.details).toEqual({
      status: 409,
      expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
      currentLiveDigest: digest(CONFIG),
    });
    const post = axios.mock.calls.find(([options]) => options.method === 'POST');
    expect(post[0].data).toEqual({
      serverIds: ['s1'],
      dryRun: false,
      expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(axios.mock.calls.some(([options]) => options.url.includes('current-config'))).toBe(false);
  });

  test('a read-only key cannot call write tools', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq({ read: true, write: false }),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: { configId: 'cfg1', operations: [{ op: 'remove', path: '/apps' }] },
      }),
    );

    expect(body.result.isError).toBe(true);
    expect(toolResult(body).error).toBe('MCP_FORBIDDEN');
    expect(axios).not.toHaveBeenCalled();
  });

  test('patch_config needs both read and write because it reads before the write', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq({ read: false, write: true }),
      rpc('tools/call', {
        name: 'patch_config',
        arguments: { configId: 'cfg1', operations: [{ op: 'remove', path: '/apps' }] },
      }),
    );

    expect(toolResult(body).error).toBe('MCP_FORBIDDEN');
    expect(toolResult(body).message).toMatch(/read permission/);
    expect(axios).not.toHaveBeenCalled();
  });

  test('a key without read permission cannot call read tools', async () => {
    const { body } = await mcpService.handlePayload(
      makeReq({ read: false, write: true }),
      rpc('tools/call', { name: 'list_servers', arguments: {} }),
    );

    expect(toolResult(body).error).toBe('MCP_FORBIDDEN');
    expect(axios).not.toHaveBeenCalled();
  });

  test('a non-loopback MCP_SELF_URL is refused before the key is sent', async () => {
    const original = process.env.MCP_SELF_URL;
    process.env.MCP_SELF_URL = 'http://evil.example:3000';
    try {
      const { body } = await mcpService.handlePayload(
        makeReq(),
        rpc('tools/call', { name: 'list_servers', arguments: {} }),
      );
      expect(toolResult(body).error).toBe('MCP_CONFIG_ERROR');
      expect(axios).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.MCP_SELF_URL;
      else process.env.MCP_SELF_URL = original;
    }
  });
});
