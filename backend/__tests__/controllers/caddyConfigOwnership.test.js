/**
 * C3/C7 regression tests — config access must be derived from server ownership.
 * A non-admin must not read, edit, delete, or apply another user's config, nor
 * target another user's server when applying their own config.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../services/caddyService', () => ({
  getConfigById: jest.fn(),
  getAllConfigs: jest.fn(),
  getAllServers: jest.fn(),
  deleteConfig: jest.fn(),
  updateConfigMetadata: jest.fn(),
  updateConfigContent: jest.fn(),
  applyConfigToServer: jest.fn(),
  addConfig: jest.fn(),
  saveConfig: jest.fn(),
}));

jest.mock('../../repositories/caddyServersRepository', () => ({
  findById: jest.fn(),
}));

jest.mock('../../services/auditService', () => ({
  logAction: jest.fn().mockResolvedValue(undefined),
}));

const caddyController = require('../../controllers/caddyController');
const caddyService = require('../../services/caddyService');
const caddyServersRepository = require('../../repositories/caddyServersRepository');

const SERVERS = {
  'srv-alice': { _id: 'srv-alice', id: 'srv-alice', name: 'Alice', createdBy: 'alice' },
  'srv-bob': { _id: 'srv-bob', id: 'srv-bob', name: 'Bob', createdBy: 'bob' },
  'srv-legacy': { _id: 'srv-legacy', id: 'srv-legacy', name: 'Legacy', createdBy: null },
};

const CONFIGS = {
  'cfg-alice': { _id: 'cfg-alice', name: 'Alice config', servers: ['srv-alice'], jsonConfig: { apps: {} } },
  'cfg-bob': { _id: 'cfg-bob', name: 'Bob config', servers: ['srv-bob'], jsonConfig: { apps: {} } },
  'cfg-mixed': { _id: 'cfg-mixed', name: 'Mixed config', servers: ['srv-alice', 'srv-bob'], jsonConfig: { apps: {} } },
  'cfg-standalone': { _id: 'cfg-standalone', name: 'Standalone', servers: [], jsonConfig: { apps: {} } },
  'cfg-legacy': { _id: 'cfg-legacy', name: 'Legacy config', servers: ['srv-legacy'], jsonConfig: { apps: {} } },
};

describe('Config ownership (C3/C7)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    app.use((req, res, next) => {
      req.user = {
        id: req.headers['x-user'] || 'alice',
        username: req.headers['x-user'] || 'alice',
        role: req.headers['x-role'] || 'user',
      };
      req.ip = '127.0.0.1';
      next();
    });

    app.get('/configs', caddyController.getAllConfigs);
    app.post('/configs', caddyController.addConfig);
    app.get('/configs/:id', caddyController.getConfigById);
    app.delete('/configs/:id', caddyController.deleteConfig);
    app.put('/configs/:id/content', caddyController.updateConfigContent);
    app.put('/configs/:id', caddyController.updateConfigMetadata);
    app.post('/configs/:configId/apply', caddyController.applyConfig);
    app.post('/servers/:id/configs', caddyController.createConfig);

    jest.clearAllMocks();

    caddyServersRepository.findById.mockImplementation(async (id) => SERVERS[id] || null);
    caddyService.getConfigById.mockImplementation(async (id) => CONFIGS[id] || null);
    caddyService.getAllServers.mockResolvedValue(Object.values(SERVERS));
    caddyService.getAllConfigs.mockResolvedValue(Object.values(CONFIGS));
    caddyService.deleteConfig.mockResolvedValue(CONFIGS['cfg-bob']);
    caddyService.updateConfigContent.mockResolvedValue(CONFIGS['cfg-bob']);
    caddyService.updateConfigMetadata.mockResolvedValue(CONFIGS['cfg-bob']);
    caddyService.applyConfigToServer.mockResolvedValue({
      success: true,
      message: 'applied',
      servers: [],
      serversApplied: ['srv-alice'],
    });
    caddyService.addConfig.mockResolvedValue({ _id: 'cfg-new', name: 'new', servers: ['srv-alice'] });
    caddyService.saveConfig.mockResolvedValue({ _id: 'cfg-new', name: 'new', servers: ['srv-alice'] });
  });

  describe('reading a config', () => {
    test("non-admin cannot read another user's config", async () => {
      const response = await request(app).get('/configs/cfg-bob');
      expect(response.status).toBe(403);
    });

    test('non-admin can read a config tied to their own server', async () => {
      const response = await request(app).get('/configs/cfg-alice');
      expect(response.status).toBe(200);
      expect(response.body.data._id).toBe('cfg-alice');
    });

    test('non-admin cannot read a mixed-tenant config', async () => {
      const response = await request(app).get('/configs/cfg-mixed');
      expect(response.status).toBe(403);
    });

    test('standalone configs are admin-only', async () => {
      expect((await request(app).get('/configs/cfg-standalone')).status).toBe(403);
      const admin = await request(app).get('/configs/cfg-standalone').set('x-role', 'admin');
      expect(admin.status).toBe(200);
    });

    test('admin can read any config', async () => {
      const response = await request(app).get('/configs/cfg-bob').set('x-role', 'admin');
      expect(response.status).toBe(200);
    });

    test('legacy unowned server stays readable (documented compatibility)', async () => {
      const response = await request(app).get('/configs/cfg-legacy');
      expect(response.status).toBe(200);
    });
  });

  describe('listing configs', () => {
    test('non-admin list is filtered to configs fully backed by owned servers', async () => {
      const response = await request(app).get('/configs');
      expect(response.status).toBe(200);
      const ids = response.body.data.map(c => c._id);
      expect(ids).toContain('cfg-alice');
      expect(ids).toContain('cfg-legacy');
      expect(ids).not.toContain('cfg-bob');
      expect(ids).not.toContain('cfg-mixed');
      expect(ids).not.toContain('cfg-standalone');
    });

    test("non-admin cannot filter by another user's server", async () => {
      const response = await request(app).get('/configs?server=srv-bob');
      expect(response.status).toBe(403);
      expect(caddyService.getAllConfigs).not.toHaveBeenCalled();
    });

    test('admin list is unfiltered', async () => {
      const response = await request(app).get('/configs').set('x-role', 'admin');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(Object.keys(CONFIGS).length);
    });
  });

  describe('mutating a config', () => {
    test("non-admin cannot delete another user's config", async () => {
      const response = await request(app).delete('/configs/cfg-bob');
      expect(response.status).toBe(403);
      expect(caddyService.deleteConfig).not.toHaveBeenCalled();
    });

    test("non-admin cannot edit another user's config content", async () => {
      const response = await request(app)
        .put('/configs/cfg-bob/content')
        .send({ jsonConfig: { apps: { http: { servers: {} } } } });
      expect(response.status).toBe(403);
      expect(caddyService.updateConfigContent).not.toHaveBeenCalled();
    });

    test("non-admin cannot re-assign another user's config to their server", async () => {
      const response = await request(app)
        .put('/configs/cfg-bob')
        .send({ servers: ['srv-alice'] });
      expect(response.status).toBe(403);
      expect(caddyService.updateConfigMetadata).not.toHaveBeenCalled();
    });

    test('admin can delete any config', async () => {
      const response = await request(app).delete('/configs/cfg-bob').set('x-role', 'admin');
      expect(response.status).toBe(200);
      expect(caddyService.deleteConfig).toHaveBeenCalledWith('cfg-bob');
    });
  });

  describe('applying a config', () => {
    test("non-admin cannot apply another user's config", async () => {
      const response = await request(app).post('/configs/cfg-bob/apply').send({});
      expect(response.status).toBe(403);
      expect(caddyService.applyConfigToServer).not.toHaveBeenCalled();
    });

    test("non-admin cannot target another user's server with their own config", async () => {
      const response = await request(app)
        .post('/configs/cfg-alice/apply')
        .send({ serverIds: ['srv-bob'] });
      expect(response.status).toBe(403);
      expect(caddyService.applyConfigToServer).not.toHaveBeenCalled();
    });

    test('non-admin can apply their config to their own server', async () => {
      const response = await request(app)
        .post('/configs/cfg-alice/apply')
        .send({ serverIds: ['srv-alice'] });
      expect(response.status).toBe(200);
      expect(caddyService.applyConfigToServer).toHaveBeenCalledWith('cfg-alice', ['srv-alice']);
    });

    test('admin can apply across tenants', async () => {
      const response = await request(app)
        .post('/configs/cfg-bob/apply')
        .set('x-role', 'admin')
        .send({ serverIds: ['srv-alice'] });
      expect(response.status).toBe(200);
      expect(caddyService.applyConfigToServer).toHaveBeenCalledWith('cfg-bob', ['srv-alice']);
    });
  });

  describe('creating a config', () => {
    test("non-admin cannot create a config against another user's server", async () => {
      const response = await request(app)
        .post('/configs')
        .send({ name: 'pwn', jsonConfig: { apps: {} }, servers: ['srv-bob'] });
      expect(response.status).toBe(403);
      expect(caddyService.addConfig).not.toHaveBeenCalled();
    });

    test('non-admin cannot create a standalone config', async () => {
      const response = await request(app)
        .post('/configs')
        .send({ name: 'standalone', jsonConfig: { apps: {} } });
      expect(response.status).toBe(403);
      expect(caddyService.addConfig).not.toHaveBeenCalled();
    });

    test('non-admin can create a config for their own server', async () => {
      const response = await request(app)
        .post('/configs')
        .send({ name: 'mine', jsonConfig: { apps: {} }, servers: ['srv-alice'] });
      expect(response.status).toBe(201);
      expect(caddyService.addConfig).toHaveBeenCalled();
    });

    test('admin can create a standalone config', async () => {
      const response = await request(app)
        .post('/configs')
        .set('x-role', 'admin')
        .send({ name: 'standalone', jsonConfig: { apps: {} } });
      expect(response.status).toBe(201);
    });

    test("non-admin cannot smuggle another user's server via /servers/:id/configs", async () => {
      const response = await request(app)
        .post('/servers/srv-alice/configs')
        .send({ name: 'mixed', jsonConfig: { apps: {} }, servers: ['srv-bob'] });
      expect(response.status).toBe(403);
      expect(caddyService.saveConfig).not.toHaveBeenCalled();
    });
  });
});
