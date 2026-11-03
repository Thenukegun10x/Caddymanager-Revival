/**
 * RFC 6902 patch engine + canonical digest (MCP surface).
 *
 * The MCP tools mutate live Caddy configs, so these tests focus on the safety
 * rails: prototype pollution, invalid documents, pointer escapes and the
 * "only apply if the result parses" gate.
 */
const {
  PatchError,
  applyPatch,
  assertValidConfig,
  canonicalize,
  digest,
  parsePointer,
} = require('../../utils/jsonPatch');

const baseConfig = () => ({
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
});

describe('jsonPatch parsePointer', () => {
  test('root pointer is an empty segment list', () => {
    expect(parsePointer('')).toEqual([]);
    expect(() => parsePointer(undefined)).toThrow(/invalid JSON pointer/);
  });

  test('decodes ~1 and ~0 escapes', () => {
    expect(parsePointer('/apps/http/a~1b')).toEqual(['apps', 'http', 'a/b']);
    expect(parsePointer('/a~0b')).toEqual(['a~b']);
  });

  test('rejects pointers without a leading slash', () => {
    expect(() => parsePointer('apps/http')).toThrow(PatchError);
  });

  test('rejects invalid tilde escapes', () => {
    expect(() => parsePointer('/a~2b')).toThrow(/invalid JSON pointer escape/);
    expect(() => parsePointer('/a~')).toThrow(/invalid JSON pointer escape/);
  });

  test('rejects prototype-pollution segments', () => {
    for (const pointer of ['/__proto__/polluted', '/a/constructor/prototype', '/prototype']) {
      expect(() => parsePointer(pointer)).toThrow(/forbidden pointer segment/);
    }
  });
});

describe('jsonPatch operations', () => {
  test('add inserts into objects and arrays', () => {
    const patched = applyPatch(baseConfig(), [
      { op: 'add', path: '/apps/http/servers/srv0/routes/0/handle/0/browse', value: true },
      { op: 'add', path: '/apps/http/servers/srv0/listen/-', value: ':443' },
    ]);

    expect(patched.apps.http.servers.srv0.routes[0].handle[0].browse).toBe(true);
    expect(patched.apps.http.servers.srv0.listen).toEqual([':80', ':443']);
  });

  test('remove deletes an object key', () => {
    const patched = applyPatch(baseConfig(), [
      { op: 'remove', path: '/apps/http/servers/srv0/routes/0/handle/0/root' },
    ]);
    expect(patched.apps.http.servers.srv0.routes[0].handle[0].root).toBeUndefined();
  });

  test('replace swaps a value', () => {
    const patched = applyPatch(baseConfig(), [
      { op: 'replace', path: '/apps/http/servers/srv0/listen/0', value: ':8080' },
    ]);
    expect(patched.apps.http.servers.srv0.listen).toEqual([':8080']);
  });

  test('move relocates a value', () => {
    const patched = applyPatch(
      { a: { b: 1 }, c: {} },
      [{ op: 'move', from: '/a/b', path: '/c/d' }],
    );
    expect(patched).toEqual({ a: {}, c: { d: 1 } });
  });

  test('copy duplicates a value', () => {
    const patched = applyPatch(
      { a: { b: 1 }, c: {} },
      [{ op: 'copy', from: '/a/b', path: '/c/d' }],
    );
    expect(patched).toEqual({ a: { b: 1 }, c: { d: 1 } });
  });

  test('test passes on equal values and fails on different ones', () => {
    const doc = { a: { b: [1, 2] }, c: 3 };
    expect(() => applyPatch(doc, [{ op: 'test', path: '/a', value: { b: [1, 2] } }])).not.toThrow();
    expect(() => applyPatch(doc, [{ op: 'test', path: '/c', value: 4 }])).toThrow(/test failed/);
  });

  test('does not mutate the input document', () => {
    const original = baseConfig();
    applyPatch(original, [
      { op: 'replace', path: '/apps/http/servers/srv0/listen/0', value: ':8080' },
    ]);
    expect(original.apps.http.servers.srv0.listen).toEqual([':80']);
  });

  test('missing intermediate paths are rejected', () => {
    expect(() =>
      applyPatch(baseConfig(), [{ op: 'add', path: '/apps/nope/deep', value: 1 }]),
    ).toThrow(/path does not exist/);
  });

  test('a later failed operation does not partially mutate the input', () => {
    const original = { apps: { http: { enabled: true } } };
    const before = JSON.stringify(original);

    expect(() => applyPatch(original, [
      { op: 'replace', path: '/apps/http/enabled', value: false },
      { op: 'replace', path: '/apps/missing', value: true },
    ])).toThrow();

    expect(JSON.stringify(original)).toBe(before);
  });

  test('malformed array indexes and root-removing moves fail closed', () => {
    const original = { items: ['a', 'b'] };
    const invalidOperations = [
      { op: 'add', path: '/items/01', value: 'x' },
      { op: 'add', path: '/items/-1', value: 'x' },
      { op: 'remove', path: '/items/-' },
      { op: 'replace', path: '/items/2', value: 'x' },
      { op: 'move', from: '', path: '/items/0' },
    ];

    for (const operation of invalidOperations) {
      const before = JSON.stringify(original);
      expect(() => applyPatch(original, [operation])).toThrow();
      expect(JSON.stringify(original)).toBe(before);
    }
  });

  test('a JSON value containing an own __proto__ key stays data, not a prototype', () => {
    const nested = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const patched = applyPatch({ safe: true }, [
      { op: 'add', path: '/payload', value: nested },
    ]);

    expect(Object.prototype.hasOwnProperty.call(patched.payload, '__proto__')).toBe(true);
    expect(patched.payload.__proto__).toEqual({ polluted: 'yes' });
    expect({}.polluted).toBeUndefined();
  });
});

describe('jsonPatch safety gates', () => {
  test('rejects an empty operation list', () => {
    expect(() => applyPatch(baseConfig(), [])).toThrow(/non-empty array/);
  });

  test('rejects more than 100 operations', () => {
    const operations = Array.from({ length: 101 }, (_, index) => ({
      op: 'add',
      path: `/key${index}`,
      value: index,
    }));
    expect(() => applyPatch(baseConfig(), operations)).toThrow(/max 100/);
  });

  test('rejects unsupported ops and missing values', () => {
    expect(() => applyPatch({ a: 1 }, [{ op: 'merge', path: '/a', value: 2 }])).toThrow(/unsupported operation/);
    expect(() => applyPatch({ a: 1 }, [{ op: 'add', path: '/b' }])).toThrow(/requires a value/);
    expect(() => applyPatch({ a: 1 }, [{ op: 'replace', path: '/a' }])).toThrow(/requires a value/);
    expect(() => applyPatch({ a: 1 }, [{ op: 'replace', value: { b: 2 } }])).toThrow(/invalid JSON pointer/);
  });

  test('rejects a patch that turns the document into a non-object', () => {
    expect(() =>
      applyPatch(baseConfig(), [{ op: 'replace', path: '', value: [1, 2, 3] }]),
    ).toThrow(/must be a JSON object/);

    expect(() =>
      applyPatch(baseConfig(), [{ op: 'replace', path: '', value: null }]),
    ).toThrow(/must be a JSON object/);
  });

  test('prototype pollution via a patch is impossible', () => {
    expect(() =>
      applyPatch(baseConfig(), [{ op: 'add', path: '/__proto__/polluted', value: 'yes' }]),
    ).toThrow(PatchError);
    expect({}.polluted).toBeUndefined();
  });

  test('assertValidConfig only accepts JSON objects', () => {
    expect(assertValidConfig({ a: 1 })).toEqual({ a: 1 });
    expect(() => assertValidConfig([])).toThrow(PatchError);
    expect(() => assertValidConfig(null)).toThrow(PatchError);
    expect(() => assertValidConfig('x')).toThrow(PatchError);
  });
});

describe('canonical digest', () => {
  test('key order does not change the digest', () => {
    const a = { b: { d: 2, c: 1 }, a: [1, 2] };
    const b = { a: [1, 2], b: { c: 1, d: 2 } };
    expect(canonicalize(a)).toEqual(b);
    expect(digest(a)).toBe(digest(b));
  });

  test('canonicalization treats __proto__ as data, not a prototype setter', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"a":1}');
    const canonical = canonicalize(value);
    expect(Object.prototype.hasOwnProperty.call(canonical, '__proto__')).toBe(true);
    expect(canonical.__proto__).toEqual({ safe: true });
    expect({}.safe).toBeUndefined();
  });

  test('value changes change the digest', () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  test('digest is a sha256 string', () => {
    expect(digest({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
