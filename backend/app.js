const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./config/swagger');
const { connectToMongo, disconnectFromMongo } = require('./services/mongoService');
const { connectToSQLite } = require('./services/sqliteService');
const pingService = require('./services/pingService');
const routes = require('./router');
const { sendError, scrubErrorResponses } = require('./utils/httpError');

// Fail fast if JWT_SECRET is missing, short, or a known placeholder (C1)
try {
  require('./utils/jwtSecret').getJwtSecret();
} catch (error) {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
}

// Create Express app
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;


// Select and connect to the configured database engine
const DB_ENGINE = process.env.DB_ENGINE || 'sqlite';
let dbReady = Promise.resolve();
if (DB_ENGINE === 'mongodb') {
  dbReady = connectToMongo();
  console.log('Using MongoDB as the database engine.');
} else if (DB_ENGINE === 'sqlite') {
  connectToSQLite();
  console.log('Using SQLite as the database engine.');
} else {
  console.error(`Unknown DB_ENGINE: ${DB_ENGINE}`);
  process.exit(1);
}

// Middleware — hardened per AGENTS.md §7 H2/H7
const splitOrigins = (value) => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : []);
const corsOrigins = splitOrigins(process.env.CORS_ORIGIN);
const mcpOrigins = process.env.MCP_ENABLED === 'true' ? splitOrigins(process.env.MCP_ALLOWED_ORIGIN) : [];
const apiOriginAllowlist = corsOrigins.length ? corsOrigins : null;
const mcpOriginAllowlist = [...new Set([...corsOrigins, ...mcpOrigins])];
// Hide MCP before CORS/preflight and body parsing when disabled, so every
// method (including OPTIONS and malformed JSON) gets the same 404 response.
app.use('/api/v1/mcp', (req, res, next) => {
  if (process.env.MCP_ENABLED !== 'true') {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  return next();
});
const makeCorsOptions = (origins) => ({
  origin: origins.length ? (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl
    if (origins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  } : false,
  credentials: origins.length > 0,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-API-Key','Mcp-Session-Id','MCP-Protocol-Version']
});
const apiCors = cors(makeCorsOptions(apiOriginAllowlist || []));
const mcpCors = cors(makeCorsOptions(mcpOriginAllowlist));
// MCP may have a separate browser origin, but don't add it to the CORS policy
// for cookie-authenticated REST routes. MCP's own checkOrigin gate is stricter
// still and accepts only MCP_ALLOWED_ORIGIN.
app.use((req, res, next) => {
  const pathname = (req.originalUrl || '').split('?')[0];
  const middleware = pathname === '/api/v1/mcp' || pathname.startsWith('/api/v1/mcp/')
    ? mcpCors
    : apiCors;
  return middleware(req, res, next);
});
// The MCP transport is stateless POST-only. Keep non-POST methods from reaching
// body parsers (CORS OPTIONS has already been handled above).
app.use('/api/v1/mcp', (req, res, next) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return res.status(405).json({
      success: false,
      message: 'MCP endpoint accepts POST only',
    });
  }
  return next();
});
app.use(cookieParser());
app.use(helmet({ contentSecurityPolicy: false, hsts: { maxAge: 31536000, includeSubDomains: true } }));
// Never echo internal error detail from production responses (H6)
app.use(scrubErrorResponses);
// Rate limiting — generous in test, strict in prod (AGENTS.md §7 H7)
const isTest = process.env.NODE_ENV === 'test';
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, try later' },
  skip: () => isTest
});
const testConnLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many test-connection attempts' },
  skip: () => isTest
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const pathname = (req.originalUrl || '').split('?')[0];
    return isTest || pathname === '/api/v1/mcp' || pathname.startsWith('/api/v1/mcp/');
  }
});
// Agent traffic is chatty but bursty; give MCP its own bucket instead of
// letting a few tool loops exhaust the 300/15min API allowance.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many MCP requests' } },
  skip: () => isTest
});
app.use('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/caddy/test-connection', testConnLimiter);
app.use('/api/v1/mcp', mcpLimiter);
app.use('/api/v1/', apiLimiter);
// MCP payloads can legitimately be larger than the rest of the API (a full JSON
// config or a patch set), so it gets its own parser before the 200kb default.
app.use('/api/v1/mcp', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '200kb' }));
// Keep parser failures on the MCP transport in JSON-RPC shape instead of
// leaking Express's parser response format into the protocol.
app.use('/api/v1/mcp', (err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Request body too large' },
    });
  }
  return next(err);
});
app.use(express.text({ limit: '512kb', type: 'text/plain' }));
// No express.urlencoded: the API is JSON/text only (M1, smaller parser surface)
// Only log requests in explicit development mode (L1)
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Swagger API Documentation UI — admin only (H8): the spec enumerates every route
const { protect, authorize } = require('./middleware/authMiddleware');
app.use('/api-docs', protect, authorize('admin'), swaggerUi.serve, swaggerUi.setup(swaggerSpecs, { explorer: true }));

// Expose the Swagger JSON schema for frontend consumption (admin only)
app.get('/api/v1/docs/swagger.json', protect, authorize('admin'), (req, res) => {
  res.json(swaggerSpecs);
});

// Mount routes
app.use('/', routes);

// Start the ping service
const pingServiceStatus = pingService.startPingService();
console.log(`Ping service initialized: ${JSON.stringify(pingServiceStatus)}`);

// Audit retention cleanup (Set D)
try {
  const auditService = require('./services/auditService');
  auditService.cleanupOldLogs().catch(()=>{});
  // unref: background maintenance must never hold the process open (Jest/CI open-handle hang)
  setInterval(()=> auditService.cleanupOldLogs().catch(()=>{}), 24*60*60*1000).unref?.();
} catch {}

// Global error handler — generic message + correlation id (H6)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 && err.message ? err.message : 'Internal Server Error';
  sendError(req, res, status, message, err);
});

// Catch 404 and forward to error handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.originalUrl}`
  });
});

// Start the server only if not in test environment
if (process.env.NODE_ENV !== 'test') {
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`Caddy Manager API server listening on port ${PORT}`);
      console.log(`Ping service is running: ${pingService.getPingServiceStatus().running}`);
    });
  }).catch((error) => {
    console.error(`FATAL: database connection failed: ${error.message}`);
    process.exit(1);
  });
}

// Handle graceful shutdown (Docker sends SIGTERM)
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  pingService.stopPingService();
  const DB_ENGINE_TERM = process.env.DB_ENGINE || 'sqlite';
  if (DB_ENGINE_TERM === 'mongodb') await disconnectFromMongo();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  pingService.stopPingService();
  console.log('Ping service stopped');
  
  // Disconnect from database
  const DB_ENGINE = process.env.DB_ENGINE || 'sqlite';
  if (DB_ENGINE === 'mongodb') {
    await disconnectFromMongo();
  }
  
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
});

module.exports = app;
