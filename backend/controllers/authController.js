const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const userRepository = require('../repositories/userRepository');
const auditService = require('../services/auditService');
const { getJwtSecret } = require('../utils/jwtSecret');
const { sendError } = require('../utils/httpError');

// Fail fast if JWT_SECRET is missing/short/placeholder (C1); support both
// JWT_EXPIRES_IN and JWT_EXPIRATION
getJwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || process.env.JWT_EXPIRATION || '24h';

// Constant-cost dummy hash so a missing user and a wrong password take the same
// time (M3 — username enumeration by timing).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/**
 * Cookie policy (M1):
 * - HTTPS production: __Host- prefix, Secure, SameSite=Strict, Path=/
 * - plain-HTTP LAN/dev: regular name with Lax, otherwise browsers drop the cookie
 */
function authCookie(req) {
  const isSecure = process.env.NODE_ENV === 'production' &&
    (req.secure || req.headers['x-forwarded-proto'] === 'https');
  return {
    name: isSecure ? '__Host-auth_token' : 'auth_token',
    options: {
      httpOnly: true,
      secure: isSecure,
      sameSite: isSecure ? 'strict' : 'lax',
      path: '/',
    },
  };
}

// Generate JWT token — enforce HS256, include tokenVersion for rotation
const generateToken = (userId, tokenVersion = 0) => {
  return jwt.sign({ id: userId, tokenVersion }, getJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: 'HS256'
  });
};

// Login user
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check if user exists with password field selected
    const user = await userRepository.findByUsername(username, { includePassword: true });
    if (!user) {
      // Log failed login attempt
      await auditService.logAction({
        action: 'login_failed',
        user: { username: username, id: null },
        resourceType: 'user',
        resourceId: null,
        details: {
          reason: 'User not found',
          username: username
        },
        statusCode: 401,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
      
      // M3: burn the same bcrypt cost as a real comparison before failing
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);

      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Check if password is correct
    const isMatch = await userRepository.comparePassword(password, user.password);
    if (!isMatch) {
      // Log failed login attempt with invalid password
      await auditService.logAction({
        action: 'login_failed',
        user: { username: username, id: user.id || user._id },
        resourceType: 'user',
        resourceId: user.id || user._id,
        details: {
          reason: 'Invalid password',
          username: username
        },
        statusCode: 401,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
      
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Update last login time
    const updatedUser = await userRepository.updateLastLogin(user.id || user._id, new Date());

    // Generate token with current tokenVersion
    const token = generateToken(user.id || user._id, user.tokenVersion || 0);

    // Set httpOnly cookie. M1: __Host- + Strict on HTTPS; Lax only for plain-HTTP LAN.
    const cookie = authCookie(req);
    res.cookie(cookie.name, token, { ...cookie.options, maxAge: 24 * 60 * 60 * 1000 });

    // Log successful login
    await auditService.logAction({
      action: 'login_success',
      user: user,
      resourceType: 'user',
      resourceId: user.id || user._id,
      details: {
        username: user.username
      },
      statusCode: 200,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    // Send response. H7: the SPA authenticates via the httpOnly cookie only;
    // a bearer token in the body is opt-in for CLI/automation use.
    const body = {
      success: true,
      user: {
        id: user.id || user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        lastLogin: updatedUser ? updatedUser.lastLogin : new Date()
      }
    };
    if (process.env.ALLOW_BEARER_TOKEN === 'true') {
      body.token = token;
    }
    res.status(200).json(body);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error logging in',
      error: error.message
    });
  }
};

exports.logout = async (req, res) => {
  try {
    // M4: revoke every outstanding JWT for this user before clearing the browser
    // cookie. This makes logout effective even if a token was copied elsewhere.
    const user = await userRepository.incrementTokenVersion(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
    }

    const cookie = authCookie(req);
    // Clear both the current and legacy cookie names after server-side revocation.
    res.clearCookie(cookie.name, cookie.options);
    res.clearCookie('auth_token', cookie.options);
    res.clearCookie('__Host-auth_token', { ...cookie.options, secure: true });
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    return sendError(req, res, 500, 'Unable to log out', error);
  }
};

// Get current user profile
exports.getCurrentUser = async (req, res) => {
  try {
    const user = await userRepository.findById(req.user.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user.id || user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving user profile',
      error: error.message
    });
  }
};

// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const { username, email } = req.body;
    const updateData = {};
    
    // If username is provided, check if it's already taken
    if (username) {
      const usernameExists = await userRepository.isUsernameExists(username, req.user.id);
      
      if (usernameExists) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists'
        });
      }
      
      updateData.username = username;
    }
    
    // If email is provided, check if it's already taken
    if (email) {
      const emailExists = await userRepository.isEmailExists(email, req.user.id);
      
      if (emailExists) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use'
        });
      }
      
      updateData.email = email;
    }
    
    const user = await userRepository.findByIdAndUpdate(
      req.user.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log profile update
    await auditService.logAction({
      action: 'update_profile',
      user: req.user,
      resourceType: 'user',
      resourceId: user.id || user._id,
      details: {
        updates: updateData
      },
      statusCode: 200,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(200).json({
      success: true,
      user: {
        id: user.id || user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        updatedAt: user.updatedAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
};

// Change password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Find user with password
    const user = await userRepository.findById(req.user.id, { includePassword: true });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Verify current password
    const isMatch = await userRepository.comparePassword(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }
    
    // Update password and rotate tokenVersion (invalidates old JWTs).
    // updatePassword() hashes through the model hook — never persist plaintext (C5).
    const newVersion = (user.tokenVersion || 0) + 1;
    await userRepository.updatePassword(user.id || user._id, newPassword, newVersion);
    
    // Log password change
    await auditService.logAction({
      action: 'change_password',
      user: req.user,
      resourceType: 'user',
      resourceId: user.id || user._id,
      details: {
        passwordChanged: true
      },
      statusCode: 200,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error changing password',
      error: error.message
    });
  }
};

// Admin: Get all users
exports.getAllUsers = async (req, res) => {
  try {
    const users = await userRepository.findAll();
    
    res.status(200).json({
      success: true,
      count: users.length,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error retrieving users',
      error: error.message
    });
  }
};

// Admin: Update user role
exports.updateUserRole = async (req, res) => {
  try {
    const { userId, role } = req.body;
    
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role'
      });
    }
    
    const user = await userRepository.findByIdAndUpdate(
      userId,
      { role },
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Log role update
    await auditService.logAction({
      action: 'update_user_role',
      user: req.user,
      resourceType: 'user',
      resourceId: user.id || user._id,
      details: {
        username: user.username,
        newRole: role,
        updatedBy: req.user.username
      },
      statusCode: 200,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating user role',
      error: error.message
    });
  }
};

// Admin: Create a new user (direct creation by admin)
exports.createUser = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    // Validate role if provided
    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role'
      });
    }

    // Check if username already exists
    const usernameExists = await userRepository.isUsernameExists(username);
    if (usernameExists) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    // Only check for duplicate emails if an email is provided and not empty
    if (email && email.trim() !== '') {
      const emailExists = await userRepository.isEmailExists(email.trim().toLowerCase());
      
      if (emailExists) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use'
        });
      }
    }

    // Prepare user data for creation
    const userData = {
      username,
      password,
      role: role || 'user'
    };

    // Only add email field if it's a non-empty value
    // Empty values will be handled by the pre-save hook in the model
    if (email && email.trim() !== '') {
      userData.email = email.trim().toLowerCase();
    }

    // Create the user
    const user = await userRepository.create(userData);

    // Log user creation
    await auditService.logAction({
      action: 'create_user',
      user: req.user,
      resourceType: 'user',
      resourceId: user.id || user._id,
      details: {
        username: user.username,
        role: user.role,
        createdBy: req.user.username
      },
      statusCode: 201,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id || user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating user',
      error: error.message
    });
  }
};

// Admin: Delete a user
exports.deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // Prevent deletion of own account - convert both to strings for comparison
    if (userId.toString() === req.user.id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Find the user to check if they exist
    const userToDelete = await userRepository.findById(userId);
    
    if (!userToDelete) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Log user deletion before actual deletion
    await auditService.logAction({
      action: 'delete_user',
      user: req.user,
      resourceType: 'user',
      resourceId: userId,
      details: {
        deletedUsername: userToDelete.username,
        deletedByUsername: req.user.username
      },
      statusCode: 200,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    // Delete the user
    await userRepository.findByIdAndDelete(userId);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting user',
      error: error.message
    });
  }
};
