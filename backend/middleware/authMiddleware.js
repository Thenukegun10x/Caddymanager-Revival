const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const ApiKey = require('../models/apiKey');

// Environment variables — fail fast if JWT_SECRET not set (except test)
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'test') return 'test-jwt-secret-for-ci-only-not-for-prod';
    throw new Error('JWT_SECRET must be set — refusing to start with insecure default (see AGENTS.md §4)');
  }
  return secret;
}
// Fail fast at import in non-test so app does not boot with insecure default
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'test') {
  throw new Error('JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET; // kept for backwards compat, but getJwtSecret() is canonical

// Protect routes - supports both JWT and API key authentication
exports.protect = async (req, res, next) => {
  try {
    let token;
    let isApiKey = false;
    
    // Check if token exists in headers
    if (req.headers.authorization) {
      // Check if it's a Bearer token (JWT) — require "Bearer " with space
      if (req.headers.authorization.startsWith('Bearer ')) {
        const parts = req.headers.authorization.split(' ');
        if (parts.length === 2 && parts[1]) token = parts[1];
      } 
      // Check if it's an API key
      else if (req.headers.authorization.startsWith('ApiKey')) {
        token = req.headers.authorization.split(' ')[1];
        isApiKey = true;
      }
    }
    
    // Also check for x-api-key header for API keys
    if (!token && req.headers['x-api-key']) {
      token = req.headers['x-api-key'];
      isApiKey = true;
    }
    
    // Check if token exists
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }
    
    try {
      if (isApiKey) {
        // Validate API key
        const apiKey = await ApiKey.validateApiKey(token);
        
        if (!apiKey) {
          return res.status(401).json({
            success: false,
            message: 'Invalid or expired API key'
          });
        }
        
        // Get the user associated with this API key
        const user = await userRepository.findById(apiKey.userId);
        
        if (!user || !user.isActive) {
          return res.status(401).json({
            success: false,
            message: 'User associated with this API key is inactive or does not exist'
          });
        }
        
        // Add user and API key info to request
        req.user = {
          id: user.id || user._id,
          username: user.username,
          email: user.email,
          role: user.role,
          isApiRequest: true,
          apiKey: {
            id: apiKey._id,
            name: apiKey.name,
            permissions: apiKey.permissions
          }
        };
      } else {
        // Verify JWT — enforce HS256, no fallback secret
        const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
        
        // Check if user still exists
        const user = await userRepository.findById(decoded.id);
        
        if (!user) {
          return res.status(401).json({
            success: false,
            message: 'User no longer exists'
          });
        }
        
        if (!user.isActive) {
          return res.status(401).json({
            success: false,
            message: 'User account is disabled'
          });
        }
        
        // Add user to request
        req.user = {
          id: user.id || user._id,
          username: user.username,
          email: user.email,
          role: user.role,
          isApiRequest: false
        };
      }
      
      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route',
        error: error.message
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error in authentication',
      error: error.message
    });
  }
};

// Authorize by role
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role ${req.user ? req.user.role : 'undefined'} is not authorized to access this route`
      });
    }
    next();
  };
};

// Check API key permissions
exports.checkApiPermission = (permission) => {
  return (req, res, next) => {
    // Skip permission check if it's not an API request
    if (!req.user.isApiRequest) {
      return next();
    }
    
    // Check if the API key has the required permission
    if (!req.user.apiKey.permissions[permission]) {
      return res.status(403).json({
        success: false,
        message: `API key doesn't have ${permission} permission`
      });
    }
    
    next();
  };
};