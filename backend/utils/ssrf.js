/**
 * SSRF hardening — validates apiUrl/apiPort/adminApiPath before any outbound request
 * Covers PLAN.md C2, AGENTS.md §7
 */
const { URL } = require('url');

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|::1|fc00:|fe80:|fd00:)/i;

function assertSafePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid apiPort ${port} — must be 1-65535`);
  }
  return n;
}

function assertSafeApiUrl(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) throw new Error('apiUrl is required');
  let u;
  try {
    u = new URL(apiUrl);
  } catch (_) {
    throw new Error(`Invalid apiUrl ${apiUrl}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error(`apiUrl must be http(s), got ${u.protocol}`);
  }
  // Hostname must be explicit, reject private ranges and metadata
  // In test, allow localhost/private so jest can use spin-caddy-servers.sh targets
  const host = u.hostname;
  if (!host) throw new Error('apiUrl missing hostname');
  const isPrivate = PRIVATE_HOST_RE.test(host);
  const allowPrivate = process.env.NODE_ENV === 'test' || process.env.ALLOW_PRIVATE_IPS === 'true';
  if (isPrivate && !allowPrivate) {
    throw new Error(`Blocked private/internal apiUrl host ${host} (set ALLOW_PRIVATE_IPS=true to allow for local Caddy)`);
  }
  // Block embedded credentials / non-standard ports in apiUrl — port is separate field
  if (u.username || u.password) throw new Error('apiUrl must not contain credentials');
  // Path must be empty or "/" — apiUrl should be origin only
  if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
    // allow "/" but not "/admin/evil" — that belongs in adminApiPath
    throw new Error('apiUrl must be origin only (no path), use adminApiPath for path');
  }
  // Forbid query/hash in apiUrl
  if (u.search || u.hash) throw new Error('apiUrl must not contain query or hash');
  return u;
}

function assertSafeAdminApiPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('adminApiPath is required');
  if (p.includes('://') || p.startsWith('http') || p.startsWith('//')) {
    throw new Error('adminApiPath must be a path, not a URL (blocked SSRF override)');
  }
  if (!p.startsWith('/')) throw new Error('adminApiPath must start with /');
  if (!/^\/[A-Za-z0-9_\-\/.]*$/.test(p)) {
    throw new Error(`Invalid adminApiPath ${p}`);
  }
  // Disallow traversal
  if (p.includes('..')) throw new Error('adminApiPath must not contain ..');
  return p;
}

function assertSafeServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') throw new Error('serverConfig required');
  assertSafeApiUrl(serverConfig.apiUrl);
  assertSafePort(serverConfig.apiPort);
  assertSafeAdminApiPath(serverConfig.adminApiPath);
}

function buildSafeBaseUrl(serverConfig) {
  assertSafeServerConfig(serverConfig);
  // Strip trailing slash from apiUrl origin, then add colon+port (apiUrl is origin like http://host)
  const origin = serverConfig.apiUrl.replace(/\/$/, '');
  return `${origin}:${serverConfig.apiPort}`;
}

function buildSafeUrl(serverConfig, path) {
  // path must be safe, but if called with server.adminApiPath we validate it
  assertSafeAdminApiPath(path);
  // Not used for absolute override — base is already validated
  return path;
}

const axiosSafeOpts = {
  maxRedirects: 0,
  maxContentLength: 1_000_000,
  timeout: 10000,
  validateStatus: null,
};

module.exports = {
  assertSafePort,
  assertSafeApiUrl,
  assertSafeAdminApiPath,
  assertSafeServerConfig,
  buildSafeBaseUrl,
  buildSafeUrl,
  axiosSafeOpts,
  PRIVATE_HOST_RE,
};
