/**
 * Opt-in MCP (Model Context Protocol) server, exposed over HTTP.
 *
 * Design constraints (see AGENTS.md §11):
 *   - stateless JSON-RPC over POST; no SSE, no sessions
 *   - every tool call is proxied to the existing REST API with the caller's
 *     own API key, so RBAC/ownership/SSRF/audit behaviour is identical to a
 *     normal client and nothing is duplicated here
 *   - mutations require the `write` permission; reads require `read`
 *   - apply requires an explicit confirm flag; dry-run never changes a server
 */

const axios = require('axios');

const { applyPatch, digest, assertValidConfig } = require('../utils/jsonPatch');
const { summarizeConfig } = require('../utils/configSummary');
const auditService = require('./auditService');

const PROTOCOL_VERSION = '2025-06-18';
// The stateless subset implemented here (initialize, tools/list, tools/call,
// ping, notifications) is wire-compatible with these revisions, so echo an
// older requested version instead of forcing a disconnect.
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BATCH = 20;

class McpToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.details = details;
  }
}

// ── Loopback client ─────────────────────────────────────────────────────────
// Fixed host (never user-controlled), fixed path prefix, no redirects.
function apiBaseUrl() {
  const raw = (process.env.MCP_SELF_URL || `http://127.0.0.1:${process.env.PORT || 3000}`)
    .replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new McpToolError('MCP_CONFIG_ERROR', 'MCP_SELF_URL is not a valid URL');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !['127.0.0.1', '::1', 'localhost'].includes(host)
    || (parsed.pathname && parsed.pathname !== '/')
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    // The caller's key travels on this request; it must never leave loopback.
    throw new McpToolError('MCP_CONFIG_ERROR', 'MCP_SELF_URL must point at the loopback API');
  }
  return raw;
}

async function callApi(req, method, path, data, timeoutMs = 15000) {
  const url = `${apiBaseUrl()}/api/v1${path}`;
  // Forward the key as x-api-key: the REST layer already accepts API keys in
  // that header, so enabling MCP never widens Bearer-token semantics globally.
  const apiKey = req.mcpApiKey
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let response;
  try {
    response = await axios({
      method,
      url,
      data,
      timeout: timeoutMs,
      proxy: false,
      maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024,
      validateStatus: () => true,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'caddymanager-mcp',
      },
    });
  } catch (error) {
    throw new McpToolError('MCP_BACKEND_UNREACHABLE', 'Caddy Manager API is unreachable', {
      cause: error.code || 'unknown',
    });
  }

  if (response.status >= 400) {
    const message = (response.data && response.data.message) || `API returned ${response.status}`;
    const details = { status: response.status };
    if (response.status === 409) {
      const conflicts = response.data && response.data.data && response.data.data.failed;
      const conflict = Array.isArray(conflicts) ? conflicts.find((failure) => failure && failure.conflict) : null;
      if (conflict) {
        if (conflict.expectedLiveDigest) details.expectedLiveDigest = conflict.expectedLiveDigest;
        if (conflict.currentLiveDigest) details.currentLiveDigest = conflict.currentLiveDigest;
      }
    }
    throw new McpToolError(
      response.status === 403 ? 'MCP_FORBIDDEN' : response.status === 409 ? 'MCP_CONFLICT' : 'MCP_API_ERROR',
      message,
      details,
    );
  }
  return response.data;
}

function encodeId(id) {
  return encodeURIComponent(String(id));
}

// ── Argument helpers ────────────────────────────────────────────────────────
function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpToolError('MCP_INVALID_ARGUMENT', `'${key}' must be a non-empty string`);
  }
  return value.trim();
}

function optionalStringArray(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new McpToolError('MCP_INVALID_ARGUMENT', `'${key}' must be an array of strings`);
  }
  return value;
}

function optionalDigest(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new McpToolError('MCP_INVALID_ARGUMENT', `'${key}' must be a sha256 digest`);
  }
  return value;
}

function requireConfigObject(value, key = 'json') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpToolError('MCP_INVALID_CONFIG', `'${key}' must be a JSON object`);
  }
  try {
    return assertValidConfig(value);
  } catch {
    throw new McpToolError('MCP_INVALID_CONFIG', `'${key}' is not valid JSON`);
  }
}

// ── Tool implementations ────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_servers',
    description: 'List Caddy servers visible to this API key. Read-only.',
    permission: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(req) {
      const response = await callApi(req, 'GET', '/caddy/servers');
      const servers = (response.data || []).map((server) => ({
        id: server._id || server.id,
        name: server.name,
        apiUrl: server.apiUrl,
        apiPort: server.apiPort,
        adminApiPath: server.adminApiPath,
        status: server.status,
        active: server.active,
      }));
      return { servers, count: servers.length };
    },
  },

  {
    name: 'list_configs',
    description: 'List saved configurations for a server (metadata only, no JSON bodies). Read-only.',
    permission: 'read',
    inputSchema: {
      type: 'object',
      properties: { serverId: { type: 'string' } },
      required: ['serverId'],
      additionalProperties: false,
    },
    async handler(req, args) {
      const serverId = requireString(args, 'serverId');
      const response = await callApi(req, 'GET', `/caddy/servers/${encodeId(serverId)}/configs`);
      const configs = (response.data || []).map((config) => ({
        configId: config._id || config.id,
        name: config.name,
        status: config.status,
        updatedAt: config.updatedAt,
        digest: config.jsonConfig ? digest(config.jsonConfig) : undefined,
      }));
      return { configs, count: configs.length };
    },
  },

  {
    name: 'read_config',
    description:
      'Read a config. With configId reads the saved config; with serverId reads the live config from Caddy. ' +
      'Returns a compact summary plus a sha256 digest by default; pass full=true for the raw JSON. ' +
      'summary=false returns only the raw JSON. With serverId, save=true persists the live config as a saved config and needs write permission.',
    permission: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string' },
        configId: { type: 'string' },
        name: { type: 'string' },
        full: { type: 'boolean', default: false },
        summary: { type: 'boolean', default: true },
        save: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    async handler(req, args) {
      const hasServer = typeof args.serverId === 'string' && args.serverId.trim().length > 0;
      const hasConfig = typeof args.configId === 'string' && args.configId.trim().length > 0;
      if (hasServer === hasConfig) {
        throw new McpToolError('MCP_INVALID_ARGUMENT', 'provide exactly one of serverId or configId');
      }
      const serverIdArg = hasServer ? requireString(args, 'serverId') : undefined;
      const configIdArg = hasConfig ? requireString(args, 'configId') : undefined;

      let json;
      let configId;
      let name;
      let status;
      let source;

      if (hasConfig) {
        const response = await callApi(req, 'GET', `/caddy/configs/${encodeId(configIdArg)}`);
        const config = response.data || {};
        json = config.jsonConfig;
        configId = config._id || config.id;
        name = config.name;
        status = config.status;
        source = 'saved';
      } else {
        const save = args.save === true;
        // Persisting a live snapshot is a mutation even though the REST route is
        // a GET, so it needs the write permission, not just read.
        if (save) {
          const { hasPermission } = require('../middleware/mcpAuth');
          if (!hasPermission(req, 'write')) {
            throw new McpToolError('MCP_FORBIDDEN', 'save=true requires the write permission');
          }
        }
        const response = await callApi(
          req,
          'GET',
          `/caddy/servers/${encodeId(serverIdArg)}/current-config?skipSave=true`,
          undefined,
          30000,
        );
        if (save) {
          json = requireConfigObject(response.data, 'live config');
          const snapshotName = typeof args.name === 'string' && args.name.trim()
            ? args.name.trim()
            : `MCP snapshot ${new Date().toISOString()}`;
          const saved = await callApi(
            req,
            'POST',
            `/caddy/servers/${encodeId(serverIdArg)}/configs`,
            {
              name: snapshotName,
              format: 'json',
              status: 'draft',
              jsonConfig: json,
              metadata: { description: 'Live Caddy config snapshot saved via MCP' },
            },
          );
          const config = saved.data || {};
          configId = config._id || config.id;
          name = config.name || snapshotName;
        } else {
          json = response.data;
        }
        source = save ? 'live-saved' : 'live';
        if (save) {
          status = 'draft';
        } else {
          name = 'live config';
          status = 'live';
        }
      }

      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new McpToolError('MCP_INVALID_CONFIG', 'config is not a JSON object');
      }

      const result = { source, configId, name, status, digest: digest(json) };
      if (args.summary !== false) result.summary = summarizeConfig(json);
      if (args.full === true || args.summary === false) result.config = json;
      return result;
    },
  },

  {
    name: 'patch_config',
    description:
      'Apply RFC 6902 JSON Patch operations to a saved config without applying it to a server. ' +
      'The patch is rejected unless the resulting document is a valid JSON object. ' +
      'Pass expectedDigest from read_config to avoid overwriting a concurrent edit.',
    // This implementation reads the saved config before its PUT, so the REST
    // proxy needs both permissions rather than silently bypassing the read gate.
    permission: ['read', 'write'],
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        operations: { type: 'array', minItems: 1, maxItems: 100 },
        expectedDigest: { type: 'string' },
      },
      required: ['configId', 'operations'],
      additionalProperties: false,
    },
    async handler(req, args) {
      const configId = requireString(args, 'configId');
      const expectedDigest = optionalDigest(args, 'expectedDigest');
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        throw new McpToolError('MCP_INVALID_ARGUMENT', "'operations' must be a non-empty array");
      }

      const current = await callApi(req, 'GET', `/caddy/configs/${encodeId(configId)}`);
      const json = current.data && current.data.jsonConfig;
      if (!json || typeof json !== 'object') {
        throw new McpToolError('MCP_INVALID_CONFIG', 'saved config has no JSON object');
      }

      const currentDigest = digest(json);
      if (expectedDigest && expectedDigest !== currentDigest) {
        throw new McpToolError('MCP_CONFLICT', 'config changed since it was read', {
          expectedDigest,
          currentDigest,
        });
      }

      let patched;
      try {
        patched = applyPatch(json, args.operations);
      } catch (error) {
        throw new McpToolError(error.code || 'MCP_PATCH_INVALID', error.message, {
          op: error.op,
          path: error.path,
        });
      }

      await callApi(req, 'PUT', `/caddy/configs/${encodeId(configId)}/content`, { jsonConfig: patched });
      return {
        configId,
        previousDigest: currentDigest,
        digest: digest(patched),
        operationsApplied: args.operations.length,
        summary: summarizeConfig(patched),
      };
    },
  },

  {
    name: 'save_config',
    description:
      'Persist a full config document. With configId replaces a saved config; with serverId + name creates a new saved config. ' +
      'Prefer patch_config for edits.',
    permission: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        serverId: { type: 'string' },
        name: { type: 'string' },
        json: { type: 'object' },
      },
      required: ['json'],
      additionalProperties: false,
    },
    async handler(req, args) {
      const json = requireConfigObject(args.json);

      if (typeof args.configId === 'string' && args.configId) {
        await callApi(req, 'PUT', `/caddy/configs/${encodeId(args.configId)}/content`, { jsonConfig: json });
        return { configId: args.configId, digest: digest(json), summary: summarizeConfig(json) };
      }

      const serverId = requireString(args, 'serverId');
      const name = requireString(args, 'name');
      const created = await callApi(req, 'POST', `/caddy/servers/${encodeId(serverId)}/configs`, {
        name,
        format: 'json',
        jsonConfig: json,
      });
      const config = created.data || {};
      return {
        configId: config._id || config.id,
        name: config.name,
        digest: digest(json),
        summary: summarizeConfig(json),
      };
    },
  },

  {
    name: 'validate_config',
    description:
      'Validate a saved config against its Caddy server(s) with Caddy\'s validate_only mode. No changes are made.',
    permission: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        serverIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['configId'],
      additionalProperties: false,
    },
    async handler(req, args) {
      const configId = requireString(args, 'configId');
      const serverIds = optionalStringArray(args, 'serverIds');
      const query = serverIds && serverIds.length ? `?serverIds=${encodeURIComponent(serverIds.join(','))}` : '';
      const response = await callApi(req, 'GET', `/caddy/configs/${encodeId(configId)}/validate${query}`, undefined, 30000);
      return response.data === undefined ? response : response.data;
    },
  },

  {
    name: 'apply_config',
    description:
      'Apply a saved config to its server(s). The backend snapshots the live config and rolls back if Caddy rejects the new one. ' +
      'Pass confirm=true to apply; use dryRun=true to validate without changing anything.',
    permission: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        serverIds: { type: 'array', items: { type: 'string' } },
        confirm: { type: 'boolean', default: false },
        dryRun: { type: 'boolean', default: false },
        expectedLiveDigest: { type: 'string' },
      },
      required: ['configId'],
      additionalProperties: false,
    },
    async handler(req, args) {
      const configId = requireString(args, 'configId');
      const serverIds = optionalStringArray(args, 'serverIds');
      const dryRun = args.dryRun === true;
      const expectedLiveDigest = optionalDigest(args, 'expectedLiveDigest');

      if (!dryRun && args.confirm !== true) {
        throw new McpToolError('MCP_CONFIRMATION_REQUIRED', 'apply_config requires confirm=true (or dryRun=true)');
      }

      if (expectedLiveDigest) {
        if (!serverIds || serverIds.length !== 1) {
          throw new McpToolError(
            'MCP_INVALID_ARGUMENT',
            'expectedLiveDigest requires exactly one serverId',
          );
        }
      }

      const response = await callApi(
        req,
        'POST',
        `/caddy/configs/${encodeId(configId)}/apply`,
        { serverIds, dryRun, expectedLiveDigest },
        120000,
      );
      return response.data === undefined ? response : response.data;
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolErrorResult(id, error) {
  const text = JSON.stringify({
    error: error.code || 'MCP_TOOL_ERROR',
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  });
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      isError: true,
    },
  };
}

async function handleToolCall(req, id, params) {
  if (!params || typeof params !== 'object') {
    return rpcError(id, -32602, 'Invalid params');
  }
  const tool = TOOLS_BY_NAME.get(params.name);
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${params.name}`);
  }

  const { hasPermission } = require('../middleware/mcpAuth');
  const requiredPermissions = Array.isArray(tool.permission) ? tool.permission : [tool.permission];
  const missingPermissions = requiredPermissions.filter((permission) => !hasPermission(req, permission));
  if (missingPermissions.length) {
    return toolErrorResult(id, new McpToolError(
      'MCP_FORBIDDEN',
      `API key doesn't have ${missingPermissions.join(' and ')} permission`,
    ));
  }

  const args = params.arguments || {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return rpcError(id, -32602, 'Tool arguments must be an object');
  }

  try {
    const result = await tool.handler(req, args);
    await auditToolCall(req, tool.name, args, 'success');
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      },
    };
  } catch (error) {
    await auditToolCall(req, tool.name, args, 'error');
    if (error instanceof McpToolError) return toolErrorResult(id, error);
    console.error('[mcp] tool error:', error.message);
    return toolErrorResult(id, new McpToolError('MCP_INTERNAL_ERROR', 'Tool execution failed'));
  }
}

async function handleRequest(req, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const isNotification = !hasId;

  if (hasId && !(id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }

  if (isNotification) {
    // No responses for notifications; initialization is client -> server only.
    return null;
  }

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'caddymanager-mcp', version: '1.0.0' },
        },
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };

    case 'tools/call':
      return handleToolCall(req, id, params);

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Handle a JSON-RPC payload (single object or batch).
 * @returns {Promise<{status:number, body:any|undefined}>}
 */
async function handlePayload(req, payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
    if (payload.length > MAX_BATCH) {
      return { status: 200, body: rpcError(null, -32600, `Batch too large (max ${MAX_BATCH})`) };
    }
    const responses = (await Promise.all(payload.map((message) => handleRequest(req, message))))
      .filter(Boolean);
    if (!responses.length) return { status: 202, body: undefined };
    return { status: 200, body: responses };
  }

  const response = await handleRequest(req, payload);
  if (!response) return { status: 202, body: undefined };
  return { status: 200, body: response };
}

/** Audit write/apply tools without leaking config contents. */
async function auditToolCall(req, toolName, args, outcome) {
  const mutation = ['patch_config', 'save_config', 'apply_config'].includes(toolName);
  if (!mutation) return;
  try {
    await auditService.logAction({
      action: `mcp_${toolName}`,
      user: req.user,
      resourceType: 'config',
      resourceId: args.configId || args.serverId,
      details: {
        via: 'mcp',
        confirm: args.confirm === true,
        dryRun: args.dryRun === true,
        outcome,
      },
      statusCode: outcome === 'success' ? 200 : 500,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  } catch (error) {
    console.warn('[mcp] audit log failed:', error.message);
  }
}

module.exports = {
  PROTOCOL_VERSION,
  TOOLS,
  handlePayload,
  auditToolCall,
  McpToolError,
};
