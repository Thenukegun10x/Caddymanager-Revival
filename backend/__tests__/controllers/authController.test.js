const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../app');
const userRepository = require('../../repositories/userRepository');
const apiKeyRepository = require('../../repositories/apiKeyRepository');

// Mock the ping service to avoid actual health checks
jest.mock('../../services/pingService', () => ({
  getPingServiceStatus: jest.fn().mockReturnValue({ running: true }),
  startPingService: jest.fn(),
  stopPingService: jest.fn()
}));

// Mock audit service to avoid database operations
jest.mock('../../services/auditService', () => ({
  logAction: jest.fn().mockResolvedValue()
}));

describe('AuthController', () => {
  let testUser, adminUser, authToken, adminToken;

  beforeEach(async () => {
    // Clear users before each test
    const users = await userRepository.findAll();
    for (const user of users) {
      await userRepository.findByIdAndDelete(user.id || user._id);
    }

    // Create test users
    testUser = await userRepository.create({
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      role: 'user'
    });

    adminUser = await userRepository.create({
      username: 'adminuser',
      email: 'admin@example.com',
      password: 'admin123',
      role: 'admin'
    });

    // Generate tokens
    const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ci-only-not-for-prod';
    authToken = jwt.sign({ id: testUser.id || testUser._id }, JWT_SECRET, { expiresIn: '24h' });
    adminToken = jwt.sign({ id: adminUser.id || adminUser._id }, JWT_SECRET, { expiresIn: '24h' });
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      // H7: SPA path is cookie-only; no JWT in the JSON body by default
      expect(response.body.token).toBeUndefined();
      const cookies = response.headers['set-cookie'] || [];
      expect(cookies.join(';')).toMatch(/auth_token=/);
      expect(cookies.join(';')).toMatch(/HttpOnly/i);
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.password).toBeUndefined();
    });

    it('returns a bearer token only when explicitly enabled', async () => {
      const original = process.env.ALLOW_BEARER_TOKEN;
      process.env.ALLOW_BEARER_TOKEN = 'true';
      try {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ username: 'testuser', password: 'password123' });

        expect(response.status).toBe(200);
        expect(response.body.token).toBeDefined();
      } finally {
        if (original === undefined) delete process.env.ALLOW_BEARER_TOKEN;
        else process.env.ALLOW_BEARER_TOKEN = original;
      }
    });

    it('should fail login with invalid credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          username: 'testuser',
          password: 'wrongpassword'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid credentials');
    });

    it('should fail login with non-existent user', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          username: 'nonexistent',
          password: 'password123'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Invalid credentials');
    });
  });

  describe('POST /auth/logout (M4)', () => {
    it('revokes the current JWT and clears the session cookies', async () => {
      const logout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Cookie', `auth_token=${authToken}`);

      expect(logout.status).toBe(200);
      expect(logout.body.success).toBe(true);
      expect((logout.headers['set-cookie'] || []).join(';')).toMatch(/auth_token=;/);

      const afterLogout = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${authToken}`);
      expect(afterLogout.status).toBe(401);
    });

    it('requires a user session and rejects API keys', async () => {
      const anonymous = await request(app).post('/api/v1/auth/logout');
      expect(anonymous.status).toBe(401);

      const apiKey = await apiKeyRepository.createApiKey(
        testUser.id || testUser._id,
        'logout-deny-test',
        { read: true, write: true, delete: true }
      );
      const keyValue = apiKey.plaintextKey || apiKey.key;
      const keyLogout = await request(app)
        .post('/api/v1/auth/logout')
        .set('x-api-key', keyValue);
      expect(keyLogout.status).toBe(403);
    });

    it('returns a generic correlated error in production if revocation fails', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const revocation = jest.spyOn(userRepository, 'incrementTokenVersion')
        .mockRejectedValueOnce(new Error('database internals must not leak'));
      let response;
      try {
        response = await request(app)
          .post('/api/v1/auth/logout')
          .set('Cookie', `auth_token=${authToken}`);
      } finally {
        revocation.mockRestore();
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }

      expect(response.status).toBe(500);
      expect(response.body.message).toBe('Unable to log out');
      expect(response.body.errorId).toMatch(/^[a-f0-9]{12}$/);
      expect(JSON.stringify(response.body)).not.toContain('database internals');
    });
  });

  describe('GET /auth/me', () => {
    it('should get current user profile', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.email).toBe('test@example.com');
      expect(response.body.user.password).toBeUndefined();
    });

    it('should fail without authentication', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('PUT /auth/profile', () => {
    it('should update user profile successfully', async () => {
      const response = await request(app)
        .put('/api/v1/auth/update-profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          username: 'updateduser',
          email: 'updated@example.com'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('updateduser');
      expect(response.body.user.email).toBe('updated@example.com');
    });

    it('should fail with duplicate username', async () => {
      const response = await request(app)
        .put('/api/v1/auth/update-profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          username: 'adminuser' // Already exists
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Username already exists');
    });

    it('should reject a catastrophic-backtracking email quickly (H5)', async () => {
      const evil = 'a.a!'.repeat(12); // 48 chars, previously minutes of backtracking
      const started = Date.now();
      const response = await request(app)
        .put('/api/v1/auth/update-profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ email: evil });
      const elapsed = Date.now() - started;

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/email/i);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should reject an over-long email without scanning it', async () => {
      const response = await request(app)
        .put('/api/v1/auth/update-profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ email: `${'a'.repeat(300)}@example.com` });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/email/i);
    });
  });

  describe('PUT /auth/change-password', () => {
    it('should change password successfully', async () => {
      const response = await request(app)
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'Newpassword123!'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Password updated successfully');

      // C5: the stored value must be a bcrypt hash, not plaintext
      const stored = await userRepository.findById(testUser.id || testUser._id, { includePassword: true });
      expect(stored.password).toMatch(/^\$2[aby]\$/);
      await expect(userRepository.comparePassword('Newpassword123!', stored.password)).resolves.toBe(true);
      await expect(userRepository.comparePassword('password123', stored.password)).resolves.toBe(false);
    });

    it('should reject a weak new password', async () => {
      const response = await request(app)
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'short'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toMatch(/at least 12 characters/);
    });

    it('should reject a password missing character classes', async () => {
      const response = await request(app)
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'alllowercase123'
        });

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/3 of/);
    });

    it('should fail with incorrect current password', async () => {
      const response = await request(app)
        .put('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          currentPassword: 'wrongpassword',
          newPassword: 'Newpassword123!'
        });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Current password is incorrect');
    });
  });

  describe('Admin Routes', () => {
    describe('GET /auth/users', () => {
      it('should get all users for admin', async () => {
        const response = await request(app)
          .get('/api/v1/auth/users')
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.users).toHaveLength(2);
      });

      it('should fail for non-admin user', async () => {
        const response = await request(app)
          .get('/api/v1/auth/users')
          .set('Authorization', `Bearer ${authToken}`);

        expect(response.status).toBe(403);
        expect(response.body.success).toBe(false);
      });
    });

    describe('POST /auth/users', () => {
      it('should create user as admin', async () => {
        const response = await request(app)
          .post('/api/v1/auth/create-user')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            username: 'newuser',
            email: 'new@example.com',
            password: 'Password123!x',
            role: 'user'
          });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);
        expect(response.body.user.username).toBe('newuser');
      });

      it('should reject a weak password', async () => {
        const response = await request(app)
          .post('/api/v1/auth/create-user')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            username: 'weakuser',
            password: 'password123'
          });

        expect(response.status).toBe(400);
        expect(response.body.message).toMatch(/at least 12 characters/);
      });

      it('should fail with duplicate username', async () => {
        const response = await request(app)
          .post('/api/v1/auth/create-user')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            username: 'testuser', // Already exists
            password: 'Password123!x'
          });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe('Username already exists');
      });
    });

    describe('PUT /auth/users/role', () => {
      it('should update user role as admin', async () => {
        const response = await request(app)
          .put('/api/v1/auth/update-user-role')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            userId: testUser.id || testUser._id,
            role: 'admin'
          });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.user.role).toBe('admin');
      });

      it('should fail with invalid role', async () => {
        const response = await request(app)
          .put('/api/v1/auth/update-user-role')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            userId: testUser.id || testUser._id,
            role: 'invalidrole'
          });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe('Invalid role');
      });
    });

    describe('DELETE /auth/users/:userId', () => {
      it('should delete user as admin', async () => {
        const response = await request(app)
          .delete(`/api/v1/auth/delete-user/${testUser.id || testUser._id}`)
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.message).toBe('User deleted successfully');
      });

      it('should not allow admin to delete themselves', async () => {
        const response = await request(app)
          .delete(`/api/v1/auth/delete-user/${adminUser.id || adminUser._id}`)
          .set('Authorization', `Bearer ${adminToken}`);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.message).toBe('Cannot delete your own account');
      });
    });
  });
});
