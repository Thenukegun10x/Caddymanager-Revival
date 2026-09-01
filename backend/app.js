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

// Fail fast if JWT_SECRET not set in non-test (covers AGENTS.md C1)
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'test') {
  console.error('FATAL: JWT_SECRET must be set — refusing to boot with insecure default');
  process.exit(1);
}

// Create Express app
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;


// Select and connect to the configured database engine
const DB_ENGINE = process.env.DB_ENGINE || 'sqlite';
if (DB_ENGINE === 'mongodb') {
  connectToMongo();
  console.log('Using MongoDB as the database engine.');
} else if (DB_ENGINE === 'sqlite') {
  connectToSQLite();
  console.log('Using SQLite as the database engine.');
} else {
  console.error(`Unknown DB_ENGINE: ${DB_ENGINE}`);
  process.exit(1);
}

// Middleware — hardened per AGENTS.md §7 H2/H7
const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : null;
const corsOptions = {
  origin: allowedOrigins ? (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  } : false,
  credentials: !!allowedOrigins,
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-API-Key']
};
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(helmet({ contentSecurityPolicy: false, hsts: { maxAge: 31536000, includeSubDomains: true } }));
// Rate limiting — generous in test, strict in prod (AGENTS.md §7 H7)
const isTest = process.env.NODE_ENV === 'test';
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
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
  skip: () => isTest
});
app.use('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/caddy/test-connection', testConnLimiter);
app.use('/api/v1/', apiLimiter);
app.use(express.json({ limit: '200kb' }));
app.use(express.text({ limit: '512kb', type: 'text/plain' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
// Only verbose logging in development
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Swagger API Documentation UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs, { explorer: true }));

// Expose the Swagger JSON schema for frontend consumption
app.get('/api/v1/docs/swagger.json', (req, res) => {
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
  setInterval(()=> auditService.cleanupOldLogs().catch(()=>{}), 24*60*60*1000);
} catch {}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
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
  app.listen(PORT, () => {
    console.log(`Caddy Manager API server listening on port ${PORT}`);
    console.log(`Ping service is running: ${pingService.getPingServiceStatus().running}`);
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