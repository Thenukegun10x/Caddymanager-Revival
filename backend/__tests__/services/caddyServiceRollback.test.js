/**
 * Apply safety: dry runs must not touch anything, and a failed apply must
 * restore the pre-apply snapshot. These are the guarantees the MCP surface
 * relies on (AGENTS.md §11), and they apply to the web UI too.
 */
jest.mock('../../repositories/caddyServersRepository');
jest.mock('../../repositories/caddyConfigRepository');
jest.mock('axios');

const axios = require('axios');
const caddyServersRepository = require('../../repositories/caddyServersRepository');
const caddyConfigRepository = require('../../repositories/caddyConfigRepository');
const caddyService = require('../../services/caddyService');
const { digest } = require('../../utils/jsonPatch');

const LIVE_CONFIG = {
  apps: { http: { servers: { srv0: { listen: [':80'], routes: [] } } } },
};
const NEW_CONFIG = {
  apps: { http: { servers: { srv0: { listen: [':8080'], routes: [] } } } },
};

describe('caddyService.applyConfigToServer safety', () => {
  let axiosInstance;
  let config;
  let server;

  beforeEach(() => {
    jest.clearAllMocks();

    axiosInstance = { get: jest.fn(), post: jest.fn() };
    axios.create.mockReturnValue(axiosInstance);

    config = {
      _id: 'cfg1',
      name: 'test config',
      jsonConfig: NEW_CONFIG,
      servers: ['srv1'],
      status: 'draft',
      history: [],
    };
    server = {
      _id: 'srv1',
      name: 'caddy-1',
      apiUrl: 'http://127.0.0.1',
      apiPort: 2019,
      adminApiPath: '/config/',
    };

    caddyConfigRepository.findById.mockResolvedValue(config);
    caddyConfigRepository.find.mockResolvedValue([]);
    caddyConfigRepository.save.mockImplementation(async (value) => value);
    caddyServersRepository.findById.mockResolvedValue(server);
    caddyServersRepository.save.mockImplementation(async (value) => value);

    jest.spyOn(caddyService, 'validateConfig').mockResolvedValue({
      isValid: true,
      message: 'Configuration is valid',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('dryRun validates but never reads, writes or saves', async () => {
    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.servers).toEqual([
      expect.objectContaining({ serverId: 'srv1', status: 'validated', dryRun: true }),
    ]);
    expect(axiosInstance.get).not.toHaveBeenCalled();
    expect(axiosInstance.post).not.toHaveBeenCalled();
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
    expect(caddyServersRepository.save).not.toHaveBeenCalled();
    expect(config.history).toHaveLength(0);
  });

  test('a successful apply snapshots first, then writes', async () => {
    axiosInstance.get.mockResolvedValue({ data: LIVE_CONFIG });
    axiosInstance.post.mockResolvedValue({ status: 200 });

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: false });

    expect(result.success).toBe(true);
    expect(result.failed).toEqual([]);
    expect(axiosInstance.get).toHaveBeenCalledWith('/config/');
    expect(axiosInstance.post).toHaveBeenCalledTimes(1);
    expect(axiosInstance.post).toHaveBeenCalledWith('/config/', NEW_CONFIG);
    expect(config.status).toBe('live');
    expect(caddyConfigRepository.save).toHaveBeenCalled();
    expect(server.activeConfig).toBe('cfg1');
    expect(caddyServersRepository.save).toHaveBeenCalled();
  });

  test('a rejected apply restores the snapshot and does not mark the config live', async () => {
    axiosInstance.get.mockResolvedValue({ data: LIVE_CONFIG });
    axiosInstance.post
      .mockRejectedValueOnce({
        message: 'Request failed with status code 400',
        response: { status: 400, data: { error: 'loading config: unexpected end of JSON input' } },
      })
      .mockResolvedValueOnce({ status: 200 });

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.servers).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual(expect.objectContaining({
      serverId: 'srv1',
      statusCode: 400,
      rolledBack: true,
      rollbackFailed: false,
      error: 'loading config: unexpected end of JSON input',
    }));
    expect(result.failed[0].rollbackError).toBeUndefined();

    // First POST is the new config, second is the snapshot restore.
    expect(axiosInstance.post).toHaveBeenCalledTimes(2);
    expect(axiosInstance.post.mock.calls[1][1]).toEqual(LIVE_CONFIG);
    expect(config.status).toBe('draft');
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
    expect(caddyServersRepository.save).not.toHaveBeenCalled();
  });

  test('expectedLiveDigest compares against the rollback snapshot and refuses stale applies', async () => {
    axiosInstance.get.mockResolvedValue({ data: LIVE_CONFIG });

    const result = await caddyService.applyConfigToServer('cfg1', ['srv1'], {
      expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.failed[0]).toEqual(expect.objectContaining({
      conflict: true,
      expectedLiveDigest: `sha256:${'0'.repeat(64)}`,
      currentLiveDigest: digest(LIVE_CONFIG),
    }));
    expect(axiosInstance.get).toHaveBeenCalledTimes(1);
    expect(axiosInstance.post).not.toHaveBeenCalled();
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
  });

  test('expectedLiveDigest checks the same snapshot in dryRun mode', async () => {
    axiosInstance.get.mockResolvedValue({ data: LIVE_CONFIG });

    const result = await caddyService.applyConfigToServer('cfg1', ['srv1'], {
      dryRun: true,
      expectedLiveDigest: digest(LIVE_CONFIG),
    });

    expect(result.success).toBe(true);
    expect(result.servers[0].status).toBe('validated');
    expect(axiosInstance.get).toHaveBeenCalledWith('/config/');
    expect(axiosInstance.post).not.toHaveBeenCalled();
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
  });

  test('a failed rollback is reported, not swallowed', async () => {
    axiosInstance.get.mockResolvedValue({ data: LIVE_CONFIG });
    axiosInstance.post
      .mockRejectedValueOnce({ message: 'apply failed', response: { status: 502, data: {} } })
      .mockRejectedValueOnce(new Error('restore refused'));

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.failed[0].rolledBack).toBe(false);
    expect(result.failed[0].rollbackFailed).toBe(true);
    expect(result.failed[0].rollbackError).toBe('restore refused');
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
  });

  test('an unreadable snapshot refuses the apply instead of writing blind', async () => {
    axiosInstance.get.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.failed[0].error).toMatch(/Could not snapshot the live configuration/);
    expect(result.failed[0].rolledBack).toBe(false);
    expect(axiosInstance.post).not.toHaveBeenCalled();
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
  });

  test('an empty or non-object snapshot refuses the apply instead of writing blind', async () => {
    axiosInstance.get.mockResolvedValue({ data: null });

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: false });

    expect(result.success).toBe(false);
    expect(result.failed[0].error).toMatch(/Could not snapshot the live configuration/);
    expect(axiosInstance.post).not.toHaveBeenCalled();
    expect(caddyConfigRepository.save).not.toHaveBeenCalled();
  });

  test('a config that fails validation is never posted', async () => {
    caddyService.validateConfig.mockResolvedValue({
      isValid: false,
      message: 'listen address is invalid',
    });

    const result = await caddyService.applyConfigToServer('cfg1', null, { dryRun: true });

    expect(result.success).toBe(false);
    expect(result.failed[0].error).toMatch(/validation failed/i);
    expect(axiosInstance.post).not.toHaveBeenCalled();
  });

  test('missing configs are rejected before any request', async () => {
    caddyConfigRepository.findById.mockResolvedValue(null);
    await expect(caddyService.applyConfigToServer('missing')).rejects.toThrow('Configuration not found');
    expect(axios.create).not.toHaveBeenCalled();
  });
});
