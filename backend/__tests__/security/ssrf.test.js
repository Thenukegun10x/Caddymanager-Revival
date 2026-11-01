/**
 * C6 regression tests — SSRF must reject private/internal targets by CIDR and
 * connect-time DNS validation, not string prefixes.
 */
const {
  assertSafeApiUrl,
  isBlockedAddress,
  safeLookup,
  axiosSafeOpts,
} = require('../../utils/ssrf');
const http = require('http');
const axios = require('axios');

const ORIGINAL_ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_IPS;

function lookup(hostname, options = {}) {
  return new Promise((resolve, reject) => {
    safeLookup(hostname, options, (err, address, family) => {
      if (err) return reject(err);
      resolve({ address, family });
    });
  });
}

describe('SSRF hardening (C6)', () => {
  beforeEach(() => {
    process.env.ALLOW_PRIVATE_IPS = 'false';
  });

  afterAll(() => {
    if (ORIGINAL_ALLOW_PRIVATE === undefined) {
      delete process.env.ALLOW_PRIVATE_IPS;
    } else {
      process.env.ALLOW_PRIVATE_IPS = ORIGINAL_ALLOW_PRIVATE;
    }
  });

  describe('literal IPv4 ranges', () => {
    test.each([
      'http://127.0.0.1',
      'http://10.1.2.3',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.1',
      'http://169.254.169.254',
      'http://100.64.0.1',
      'http://0.0.0.0',
      'http://224.0.0.1',
      'http://255.255.255.255',
    ])('blocks %s', (url) => {
      expect(() => assertSafeApiUrl(url)).toThrow(/Blocked private\/internal/);
    });

    test('allows a public literal IPv4', () => {
      expect(() => assertSafeApiUrl('http://93.184.216.34')).not.toThrow();
    });
  });

  describe('IPv6 ranges', () => {
    test.each([
      'http://[::]',              // unspecified
      'http://[::1]',             // loopback
      'http://[::ffff:127.0.0.1]',// IPv4-mapped loopback
      'http://[fd12::1]',         // ULA fd00::/8
      'http://[fc00::1]',         // ULA fc00::/7
      'http://[fe80::1]',         // link-local
      'http://[ff02::1]',         // multicast
      'http://[2001:db8::1]',     // documentation
      'http://[2002::1]',         // 6to4
    ])('blocks %s', (url) => {
      expect(() => assertSafeApiUrl(url)).toThrow(/Blocked private\/internal/);
    });

    test('allows a public IPv6 address', () => {
      expect(() => assertSafeApiUrl('http://[2606:4700:4700::1111]')).not.toThrow();
    });
  });

  describe('hostname aliases', () => {
    test.each([
      'http://localtest.me',
      'http://foo.localtest.me',
      'http://localhost',
      'http://metadata.google.internal',
      'http://instance-data',
      'http://host.docker.internal',
      'http://caddy.internal',
      'http://printer.local',
    ])('blocks %s', (url) => {
      expect(() => assertSafeApiUrl(url)).toThrow(/Blocked private\/internal/);
    });

    test('blocks metadata alias even when private access is enabled', () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      expect(() => assertSafeApiUrl('http://metadata.google.internal')).toThrow(/Blocked private\/internal/);
    });

    test('allows localhost only with explicit dev opt-in', () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      expect(() => assertSafeApiUrl('http://localhost')).not.toThrow();
    });
  });

  describe('URL shape', () => {
    test('rejects an embedded port (use apiPort)', () => {
      expect(() => assertSafeApiUrl('http://example.com:8080')).toThrow(/must not contain a port/);
    });

    test('rejects embedded credentials', () => {
      expect(() => assertSafeApiUrl('http://user:pass@example.com')).toThrow(/credentials/);
    });

    test('rejects a path', () => {
      expect(() => assertSafeApiUrl('http://example.com/admin')).toThrow(/origin only/);
    });

    test('rejects query and hash', () => {
      expect(() => assertSafeApiUrl('http://example.com/?x=1')).toThrow(/query or hash/);
      expect(() => assertSafeApiUrl('http://example.com/#x')).toThrow(/query or hash/);
    });
  });

  describe('connect-time DNS validation', () => {
    test('safeLookup rejects loopback resolution when private access is off', async () => {
      await expect(lookup('localhost')).rejects.toThrow(/Blocked private\/internal/);
    });

    test('safeLookup allows loopback only with explicit dev opt-in', async () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      const result = await lookup('localhost');
      expect(result.address).toBeTruthy();
    });

    test('isBlockedAddress covers ULA, mapped and unspecified', () => {
      expect(isBlockedAddress('fd12::1')).toBe(true);
      expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
      expect(isBlockedAddress('::')).toBe(true);
      expect(isBlockedAddress('8.8.8.8')).toBe(false);
    });
  });

  describe('axios safe agents', () => {
    let server;
    let port;

    beforeAll((done) => {
      server = http.createServer((req, res) => res.end('ok'));
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
      });
    });

    afterAll(async () => {
      if (!server) return;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    test('the configured agent blocks loopback at connect time', async () => {
      process.env.ALLOW_PRIVATE_IPS = 'false';
      await expect(axios.get(`http://127.0.0.1:${port}`, axiosSafeOpts)).rejects.toMatchObject({
        code: 'ERR_SSRF_BLOCKED',
      });
    });

    test('the configured agent permits loopback with explicit opt-in', async () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      const response = await axios.get(`http://127.0.0.1:${port}`, axiosSafeOpts);
      expect(response.data).toBe('ok');
    });
  });
});
