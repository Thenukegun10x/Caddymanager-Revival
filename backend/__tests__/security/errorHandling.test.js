/**
 * H6/H8 regression tests — internal error detail must not reach production
 * responses, and the Swagger spec must require an admin session.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../services/pingService', () => ({
  startPingService: jest.fn().mockReturnValue({ running: false }),
  stopPingService: jest.fn(),
  getPingServiceStatus: jest.fn().mockReturnValue({ running: false }),
}));

const { scrubErrorResponses } = require('../../utils/httpError');
const app = require('../../app');

describe('Error response scrubbing (H6)', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('production responses drop error and stack', async () => {
    process.env.NODE_ENV = 'production';
    const local = express();
    local.use(scrubErrorResponses);
    local.get('/boom', (req, res) => {
      res.status(500).json({
        success: false,
        message: 'Error fetching servers',
        error: 'connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)',
        stack: 'at secret.js:1',
      });
    });

    const response = await request(local).get('/boom');
    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Error fetching servers');
    expect(response.body.error).toBeUndefined();
    expect(response.body.stack).toBeUndefined();
  });

  test('successful bodies are untouched', async () => {
    process.env.NODE_ENV = 'production';
    const local = express();
    local.use(scrubErrorResponses);
    local.get('/ok', (req, res) => res.json({ success: true, data: { error: 'legit field' } }));

    const response = await request(local).get('/ok');
    expect(response.body.data.error).toBe('legit field');
  });
});

describe('Swagger exposure (H8)', () => {
  test('swagger UI requires authentication', async () => {
    const response = await request(app).get('/api-docs/');
    expect(response.status).toBe(401);
  });

  test('swagger spec requires authentication', async () => {
    const response = await request(app).get('/api/v1/docs/swagger.json');
    expect(response.status).toBe(401);
  });
});
