const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const caddyServerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  apiUrl: {
    type: String,
    required: true,
    trim: true
  },
  apiPort: {
    type: Number,
    default: 2019
  },
  adminApiPath: {
    type: String,
    default: '/config/',
    trim: true
  },
  active: {
    type: Boolean,
    default: true
  },
  // Optional UUID that links this server to a mounted Caddyfile declared in .env (CADDYFILE_<UUID>_PATH)
  caddyfileUuid: {
    type: String,
    trim: true,
    default: null
  },
  tags: {
    type: [String],
    default: []
  },
  description: {
    type: String,
    trim: true
  },
  lastPinged: {
    type: Date
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'unknown'],
    default: 'unknown'
  },
  // Reference to the active configuration
  activeConfig: {
    type: Schema.Types.ObjectId,
    ref: 'CaddyConfig'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

const CaddyServer = mongoose.model('CaddyServer', caddyServerSchema);

module.exports = CaddyServer;