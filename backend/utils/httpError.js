/**
 * Error responses (sweep H6).
 *
 * Handlers historically returned `error: error.message`, leaking driver errors,
 * file paths, upstream hosts and JWT failure reasons. Every response now carries
 * a short correlation id; details go to the server log and are only echoed when
 * NODE_ENV is not production.
 */
const crypto = require('crypto');

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function newErrorId() {
  return crypto.randomBytes(6).toString('hex');
}

function logError(req, errorId, error) {
  const where = req ? `${req.method} ${req.originalUrl || req.url || ''}` : 'unknown-request';
  console.error(`[${errorId}] ${where}`, error && error.stack ? error.stack : error);
}

function sendError(req, res, status, message, error) {
  const errorId = newErrorId();
  if (error) logError(req, errorId, error);

  const body = { success: false, message, errorId };
  if (!isProduction() && error && error.message) body.error = error.message;
  return res.status(status).json(body);
}

/**
 * Defense in depth: strip detail fields from any JSON body in production even if
 * a handler forgot. express.json is not involved because we wrap res.json.
 */
function scrubErrorResponses(req, res, next) {
  if (!isProduction()) return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.success === false) {
        delete body.error;
        delete body.stack;
      }
    }
    return originalJson(body);
  };
  next();
}

module.exports = {
  isProduction,
  newErrorId,
  sendError,
  scrubErrorResponses,
};
