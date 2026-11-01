/**
 * SSRF hardening — validates apiUrl/apiPort/adminApiPath before any outbound request
 * Covers PLAN.md C2, AGENTS.md §7, sweep C6.
 *
 * Two layers:
 *  1. assertSafeApiUrl() — synchronous checks for scheme, credentials, port, path,
 *     literal IPs (full CIDR, not string prefixes) and known loopback/metadata aliases.
 *  2. safeLookup() — connect-time DNS validation used by the HTTP(S) agents. Every
 *     resolved address is checked, so DNS rebinding and aliases like localtest.me
 *     cannot reach private space even when the hostname looks public.
 */
const { URL } = require('url');
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const tls = require('tls');

// Explicit opt-in is required to talk to private/LAN addresses (local Caddy dev).
function allowPrivateIps() {
  return process.env.ALLOW_PRIVATE_IPS === 'true' ||
    (process.env.NODE_ENV === 'test' && process.env.ALLOW_PRIVATE_IPS !== 'false');
}

// Hosts that must never be reachable, even when private access is explicitly allowed.
const ALWAYS_BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
  'host.docker.internal',
  'gateway.docker.internal',
]);

// Names that resolve to loopback (or encode a loopback IP) in common setups.
const LOOPBACK_ALIAS_SUFFIXES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'localtest.me',
  'lvh.me',
  'nip.io',
  'sslip.io',
  'xip.io',
  'vcap.me',
];

// Special-use TLDs that are only meaningful on a local network.
const PRIVATE_TLDS = ['local', 'internal', 'home.arpa', 'lan'];

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],       // "this" network
  ['10.0.0.0', 8],      // RFC1918
  ['100.64.0.0', 10],   // CGNAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local / cloud metadata
  ['172.16.0.0', 12],   // RFC1918
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // TEST-NET-1
  ['192.88.99.0', 24],  // 6to4 relay anycast
  ['192.168.0.0', 16],  // RFC1918
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24],  // TEST-NET-3
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved + broadcast
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

function isBlockedIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

// Expand an IPv6 literal (including embedded IPv4 and zone id) to 16 bytes.
function ipv6ToBytes(input) {
  let address = String(input).toLowerCase().split('%')[0];
  if (!net.isIPv6(address)) return null;

  const embedded = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded[2].split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    address = `${embedded[1]}${high}:${low}`;
  }

  const [head, tail] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (address.includes('::') && missing === 0)) return null;

  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function bytesToBigInt(bytes) {
  return bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

function hasIPv6Prefix(value, prefix, bits) {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (bytesToBigInt(ipv6ToBytes(prefix)) >> shift);
}

function isBlockedIPv6(ip) {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true;
  const value = bytesToBigInt(bytes);

  if (value === 0n) return true; // :: unspecified
  if (value === 1n) return true; // ::1 loopback
  if (hasIPv6Prefix(value, '::ffff:0:0', 96)) return true; // IPv4-mapped
  if (hasIPv6Prefix(value, '64:ff9b::', 96)) return true; // NAT64
  if (hasIPv6Prefix(value, '100::', 64)) return true; // discard-only
  if (hasIPv6Prefix(value, '2001:db8::', 32)) return true; // documentation
  if (hasIPv6Prefix(value, '2001::', 32)) return true; // Teredo
  if (hasIPv6Prefix(value, '2002::', 16)) return true; // 6to4
  if (hasIPv6Prefix(value, 'fc00::', 7)) return true; // ULA (fc00::/7)
  if (hasIPv6Prefix(value, 'fe80::', 10)) return true; // link-local
  if (hasIPv6Prefix(value, 'ff00::', 8)) return true; // multicast
  return false;
}

// Unknown address families fail closed.
function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

function normalizeHostname(hostname) {
  return String(hostname || '')
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;

  if (ALWAYS_BLOCKED_HOSTS.has(host)) return true;

  // Explicit opt-in for local/LAN targets (development only)
  if (allowPrivateIps()) return false;

  // A literal IP is handled by isBlockedAddress, not the name lists.
  if (net.isIP(host)) return isBlockedAddress(host);

  for (const alias of LOOPBACK_ALIAS_SUFFIXES) {
    if (host === alias || host.endsWith(`.${alias}`)) return true;
  }
  for (const tld of PRIVATE_TLDS) {
    if (host === tld || host.endsWith(`.${tld}`)) return true;
  }
  return false;
}

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

  const host = normalizeHostname(u.hostname);
  if (!host) throw new Error('apiUrl missing hostname');

  if (isBlockedHostname(host)) {
    throw new Error(`Blocked private/internal apiUrl host ${host}`);
  }

  // Port belongs in apiPort, never embedded in the origin.
  if (u.port) {
    throw new Error('apiUrl must not contain a port — use apiPort');
  }
  if (u.username || u.password) throw new Error('apiUrl must not contain credentials');
  if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
    throw new Error('apiUrl must be origin only (no path), use adminApiPath for path');
  }
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
  const u = new URL(serverConfig.apiUrl);
  return `${u.protocol}//${u.host}:${serverConfig.apiPort}`;
}

function buildSafeUrl(serverConfig, path) {
  assertSafeAdminApiPath(path);
  return path;
}

function ssrfBlockedError(message) {
  const error = new Error(message);
  error.code = 'ERR_SSRF_BLOCKED';
  return error;
}

/**
 * Connect-time lookup: resolves every address and refuses private/internal ones.
 * Used as the `lookup` option on the HTTP(S) agents, which pins the connection to
 * the validated address and closes the DNS-rebinding window.
 */
function safeLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options || {});
  const cb = typeof options === 'function' ? options : callback;

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return cb(new Error(`Unable to resolve host ${hostname}`));
    }

    if (!allowPrivateIps()) {
      for (const entry of addresses) {
        if (isBlockedAddress(entry.address)) {
          return cb(ssrfBlockedError(`Blocked private/internal address ${entry.address} for host ${hostname}`));
        }
      }
    }

    if (opts.all) return cb(null, addresses);

    const chosen = opts.family
      ? addresses.find(entry => entry.family === opts.family)
      : addresses[0];
    if (!chosen) return cb(new Error(`No address family ${opts.family} for host ${hostname}`));
    return cb(null, chosen.address, chosen.family);
  });
}

/**
 * Second layer: `lookup` is skipped for literal IP hosts, so validate the target
 * address when the socket is actually created. Covers direct IP literals that
 * reach the agent by another code path.
 */
function createGuardedConnection(connectFn) {
  return (options, callback) => {
    const host = normalizeHostname(options && (options.host || options.hostname));
    if (!allowPrivateIps() && net.isIP(host) && isBlockedAddress(host)) {
      const error = ssrfBlockedError(`Blocked private/internal address ${host}`);
      if (typeof callback === 'function') {
        process.nextTick(() => callback(error));
        return undefined;
      }
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(error));
      return socket;
    }
    return connectFn(options, callback);
  };
}

const httpAgent = new http.Agent({ keepAlive: false, lookup: safeLookup });
const httpsAgent = new https.Agent({ keepAlive: false, lookup: safeLookup });

// http.Agent ignores `createConnection` in its options object, so override the
// instance method (addRequest calls this.createConnection).
httpAgent.createConnection = createGuardedConnection(net.createConnection);
httpsAgent.createConnection = createGuardedConnection(tls.connect);

const axiosSafeOpts = {
  maxRedirects: 0,
  maxContentLength: 1_000_000,
  timeout: 10000,
  validateStatus: null,
  proxy: false, // do not let HTTP(S)_PROXY env route around the safe agents
  httpAgent,
  httpsAgent,
};

// Operator-controlled URLs (e.g. CADDY_SANDBOX_URL) are not user input, so they
// may legitimately point at a local sandbox. Keep the other SSRF limits but use
// the default agents instead of the private-address-blocking ones.
const axiosSandboxOpts = {
  ...axiosSafeOpts,
  httpAgent: undefined,
  httpsAgent: undefined,
};

module.exports = {
  assertSafePort,
  assertSafeApiUrl,
  assertSafeAdminApiPath,
  assertSafeServerConfig,
  buildSafeBaseUrl,
  buildSafeUrl,
  axiosSafeOpts,
  axiosSandboxOpts,
  safeLookup,
  isBlockedAddress,
  isBlockedHostname,
  allowPrivateIps,
};
