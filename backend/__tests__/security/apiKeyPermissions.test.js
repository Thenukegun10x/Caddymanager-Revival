/**
 * C4 regression tests — API key permissions must gate write/delete operations,
 * and keys must never manage users or mint other keys.
 */
const {
  enforceApiKeyPermissions,
  rejectApiKey,
} = require('../../middleware/apiKeyPermissions');

function invoke(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    middleware(req, res, () => resolve({ status: 200, next: true }));
  });
}

function jwtUser() {
  return { user: { id: 'u1', role: 'user', isApiRequest: false } };
}

function apiKeyUser(permissions) {
  return {
    user: {
      id: 'u1',
      role: 'user',
      isApiRequest: true,
      apiKey: { id: 'k1', permissions },
    },
  };
}

describe('API key permission enforcement (C4)', () => {
  test('JWT sessions are not constrained by key permissions', async () => {
    const result = await invoke(enforceApiKeyPermissions, { method: 'DELETE', ...jwtUser() });
    expect(result.next).toBe(true);
  });

  test('read-only key can GET', async () => {
    const result = await invoke(enforceApiKeyPermissions, {
      method: 'GET',
      ...apiKeyUser({ read: true, write: false, delete: false }),
    });
    expect(result.next).toBe(true);
  });

  test('read-only key cannot POST/PUT', async () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const result = await invoke(enforceApiKeyPermissions, {
        method,
        ...apiKeyUser({ read: true, write: false, delete: false }),
      });
      expect(result.status).toBe(403);
      expect(result.body.message).toMatch(/write permission/);
    }
  });

  test('read+write key cannot DELETE', async () => {
    const result = await invoke(enforceApiKeyPermissions, {
      method: 'DELETE',
      ...apiKeyUser({ read: true, write: true, delete: false }),
    });
    expect(result.status).toBe(403);
    expect(result.body.message).toMatch(/delete permission/);
  });

  test('delete permission allows DELETE', async () => {
    const result = await invoke(enforceApiKeyPermissions, {
      method: 'DELETE',
      ...apiKeyUser({ read: true, write: true, delete: true }),
    });
    expect(result.next).toBe(true);
  });

  test('missing permissions object fails closed', async () => {
    const result = await invoke(enforceApiKeyPermissions, {
      method: 'GET',
      user: { id: 'u1', role: 'user', isApiRequest: true, apiKey: { id: 'k1' } },
    });
    expect(result.status).toBe(403);
  });

  test('API keys cannot access auth or key-management routes', async () => {
    const blocked = await invoke(rejectApiKey, apiKeyUser({ read: true, write: true, delete: true }));
    expect(blocked.status).toBe(403);

    const allowed = await invoke(rejectApiKey, jwtUser());
    expect(allowed.next).toBe(true);
  });
});
