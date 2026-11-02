const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dbConfig = require('../config/dbConfig');
// Lazy require to avoid needing dev dep when DB_ENGINE=sqlite (pruned image)
let MongoMemoryServer;
try { ({ MongoMemoryServer } = require('mongodb-memory-server')); } catch (_) { MongoMemoryServer = null; }
require('dotenv').config();

let mongoServer = null; // Keep reference to memory server instance
let connectPromise = null; // Idempotent: app import and test setup may both call

const connectToMongo = () => {
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        if (dbConfig.isProduction && dbConfig.uri) {
          // Production: Use real MongoDB
          await mongoose.connect(dbConfig.uri, dbConfig.options);
          console.log('Connected to MongoDB successfully (Production)');
        } else {
          if (!MongoMemoryServer) {
            throw new Error('mongodb-memory-server not installed (pruned) — set MONGODB_URI or use DB_ENGINE=sqlite');
          }
          // Development: Use MongoDB Memory Server
          console.log('Starting MongoDB Memory Server for development...');
          mongoServer = await MongoMemoryServer.create(dbConfig.memoryServerOptions);
          const uri = mongoServer.getUri();
          await mongoose.connect(uri, dbConfig.options);
          console.log('Connected to MongoDB Memory Server successfully (Development)');
          console.log(`Memory Server URI: ${uri}`);
        }

        // Check for and create admin user if none exists
        await createDefaultAdminIfNeeded();
      } catch (error) {
        console.error('Failed to connect to MongoDB:', error.message);
        process.exit(1); // Exit with failure
      }
    })();
  }
  return connectPromise;
};

/**
 * Resolve the first-boot admin password.
 * - Explicit ADMIN_PASSWORD (12+ chars) wins.
 * - Production refuses to bootstrap with no password.
 * - Development generates a random one and logs it once.
 */
const resolveBootstrapAdminPassword = () => {
  const provided = process.env.ADMIN_PASSWORD;
  if (provided) {
    if (provided.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    }
    return { password: provided, generated: false };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_PASSWORD is required to bootstrap the first admin in production');
  }
  return { password: crypto.randomBytes(18).toString('base64url'), generated: true };
};

/**
 * Check if any users exist in the database.
 * If not, create the bootstrap admin (random password in dev, ADMIN_PASSWORD in prod).
 */
const createDefaultAdminIfNeeded = async () => {
  // Require the User model here to avoid circular dependencies
  const User = require('../models/user/userMongoModel');

  const userCount = await User.countDocuments();

  if (userCount === 0) {
    const { password, generated } = resolveBootstrapAdminPassword();
    console.log('No users found in database. Creating bootstrap admin user...');

    const adminUser = new User({
      username: 'admin',
      password, // hashed by the pre-save hook
      role: 'admin',
      isActive: true
    });

    await adminUser.save();
    console.log('Bootstrap admin user created successfully.');
    console.log('Username: admin');
    if (generated) {
      console.log(`Generated admin password (shown once — change it after login): ${password}`);
    } else {
      console.log('Password: [from ADMIN_PASSWORD]');
    }
  }

  // Warn loudly if an existing admin still uses the old public default password.
  const admins = await User.find({ role: 'admin' }).select('+password');
  for (const admin of admins) {
    if (admin.password && (await bcrypt.compare('caddyrocks', admin.password))) {
      console.error(
        `[SECURITY] Admin "${admin.username}" still uses the old public default password. Change it now.`
      );
    }
  }
};

/**
 * Gracefully disconnect from MongoDB and stop memory server if running
 */
const disconnectFromMongo = async () => {
  try {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    
    if (mongoServer) {
      await mongoServer.stop();
      console.log('MongoDB Memory Server stopped');
    }
  } catch (error) {
    console.error('Error during MongoDB disconnect:', error.message);
  }
};

module.exports = {
  connectToMongo,
  disconnectFromMongo,
  getMongoServer: () => mongoServer
};