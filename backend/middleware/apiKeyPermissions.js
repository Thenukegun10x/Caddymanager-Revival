/**
 * API-key authorization (sweep C4).
 *
 * API keys are long-lived and often read-only, so the HTTP method must map to an
 * explicit permission instead of inheriting the owning user's full role. Keys are
 * also forbidden from user/credential/key-management routes, which prevents a
 * leaked read-only key from minting a privileged key or changing a password.
 */

// Check a specific API key permission (kept for route-level use).
exports.checkApiPermission = (permission) => {
  return (req, res, next) => {
    // JWT sessions are governed by role + ownership checks, not key permissions.
    if (!req.user || !req.user.isApiRequest) return next();

    if (!req.user.apiKey || !req.user.apiKey.permissions || !req.user.apiKey.permissions[permission]) {
      return res.status(403).json({
        success: false,
        message: `API key doesn't have ${permission} permission`
      });
    }

    next();
  };
};

// Map the HTTP method to the permission an API key must hold.
exports.enforceApiKeyPermissions = (req, res, next) => {
  if (!req.user || !req.user.isApiRequest) return next();

  const method = req.method.toUpperCase();
  const permission = (method === 'GET' || method === 'HEAD')
    ? 'read'
    : (method === 'DELETE' ? 'delete' : 'write');

  const permissions = req.user.apiKey && req.user.apiKey.permissions;
  if (!permissions || permissions[permission] !== true) {
    return res.status(403).json({
      success: false,
      message: `API key doesn't have ${permission} permission`
    });
  }
  next();
};

// API keys must never manage users, passwords, roles, or other API keys.
exports.rejectApiKey = (req, res, next) => {
  if (req.user && req.user.isApiRequest) {
    return res.status(403).json({
      success: false,
      message: 'API keys cannot access this route'
    });
  }
  next();
};
