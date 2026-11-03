/**
 * Authentication for the opt-in agent surface (MCP over HTTP).
 *
 * Deliberately narrower than the main `protect` middleware:
 *   - only API keys are accepted, and only in `Authorization: Bearer <key>`
 *   - the endpoint does not exist unless MCP_ENABLED=true
 *   - browser origins must be listed in MCP_ALLOWED_ORIGIN
 *
 * It reuses the same API-key store as the REST API, so revocation, expiry and
 * read/write/delete permissions behave identically.
 */

const ApiKey = require('../models/apiKey');
const userRepository = require('../repositories/userRepository');

const JWT_SHAPE = /\./; // API keys are 64 hex chars; JWTs always contain dots

function isEnabled() {
  return process.env.MCP_ENABLED === 'true';
}

function allowedOrigins() {
  return (process.env.MCP_ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

exports.isEnabled = isEnabled;

exports.checkOrigin = (req, res, next) => {
  const origin = req.headers.origin;
  // Non-browser MCP clients (CLI, editors, agents) send no Origin header.
  if (!origin) return next();

  const allowed = allowedOrigins();
  // Secure default: an unset allowlist means no browser origin may call MCP.
  if (!allowed.length || !allowed.includes(origin)) {
    return res.status(403).json({
      success: false,
      message: 'Origin is not allowed to access the MCP endpoint',
    });
  }
  return next();
};

exports.protectMcp = async (req, res, next) => {
  try {
    // Hide the endpoint entirely when the feature is off.
    if (!isEnabled()) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'MCP requires Authorization: Bearer <api key>',
      });
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token || JWT_SHAPE.test(token)) {
      return res.status(401).json({
        success: false,
        message: 'MCP requires an API key, not a JWT',
      });
    }

    const apiKey = await ApiKey.validateApiKey(token);
    if (!apiKey) {
      return res.status(401).json({ success: false, message: 'Invalid or expired API key' });
    }

    const user = await userRepository.findById(apiKey.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User associated with this API key is inactive or does not exist',
      });
    }

    req.user = {
      id: user.id || user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      isApiRequest: true,
      apiKey: {
        id: apiKey._id || apiKey.id,
        name: apiKey.name,
        permissions: apiKey.permissions,
      },
    };
    // Kept only so the loopback client can re-authenticate as this key without
    // widening the REST API to accept API keys in the Bearer header.
    req.mcpApiKey = token;

    return next();
  } catch (error) {
    console.error('[mcp] auth error:', error.message);
    return res.status(500).json({ success: false, message: 'Server error in MCP authentication' });
  }
};

/** Tool-level permission check (read is the default for read-only tools). */
exports.hasPermission = (req, permission) => {
  const permissions = req.user && req.user.apiKey && req.user.apiKey.permissions;
  return !!(permissions && permissions[permission] === true);
};
