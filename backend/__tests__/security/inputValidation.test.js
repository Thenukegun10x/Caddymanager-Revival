/**
 * M11 regression tests — names that reach response headers or generated YAML
 * must not accept CR/LF or metacharacters.
 */
const { serverCreateSchema, serverUpdateSchema } = require('../../utils/validate');

const baseServer = {
  name: 'edge-1',
  apiUrl: 'http://93.184.216.34',
  apiPort: 2019,
  adminApiPath: '/config/',
};

describe('Server name validation (M11)', () => {
  test.each([
    'evil\r\nX-Injected: yes',
    'evil\nname',
    'name"onmouseover=alert(1)',
    "name'; drop table",
    '-leading-dash',
  ])('rejects %j', (name) => {
    expect(serverCreateSchema.safeParse({ ...baseServer, name }).success).toBe(false);
    expect(serverUpdateSchema.safeParse({ name }).success).toBe(false);
  });

  test.each(['edge-1', 'Edge 1', 'edge_1.prod', 'A1'])('accepts %j', (name) => {
    expect(serverCreateSchema.safeParse({ ...baseServer, name }).success).toBe(true);
  });
});
