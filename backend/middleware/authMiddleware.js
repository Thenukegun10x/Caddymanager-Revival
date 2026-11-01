const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const ApiKey = require('../models/apiKey');

const { getJwtSecret } = require('../utils/jwtSecret');

// Fail fast at import in non-test so the app never boots with an insecure default (C1)
getJwtSecret();

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

    // Also check httpOnly cookie (Set D, mitigates XSS)
    if (!token && req.cookies && req.cookies.auth_token) {
      token = req.cookies.auth_token;
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

        // Check tokenVersion rotation (Set D) — invalidates old JWTs after password change
        if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
          return res.status(401).json({
            success: false,
            message: 'Token has been invalidated (password changed)'
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
      // Do not reveal why a token failed (expired vs bad signature vs version)
      console.warn(`[auth] token rejected: ${error.message}`);
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }
  } catch (error) {
    console.error('[auth] middleware error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Server error in authentication'
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

