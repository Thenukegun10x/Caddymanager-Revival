/**
 * Opt-in MCP endpoint (Model Context Protocol over HTTP).
 *
 * Stateless JSON-RPC 2.0 over POST. There is no SSE stream and no session
 * state, which keeps the surface small: one route, one parser, no long-lived
 * connections. The route is invisible unless MCP_ENABLED=true.
 */

const express = require('express');
const { checkOrigin, protectMcp, isEnabled } = require('../middleware/mcpAuth');
const mcpService = require('../services/mcpService');

const router = express.Router();

// Hide every method while disabled. When enabled, evaluate the origin before
// authentication so a browser cannot probe whether a key is valid.
router.use((req, res, next) => {
  if (!isEnabled()) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  return checkOrigin(req, res, next);
});

router.post('/', protectMcp, async (req, res) => {
  try {
    const { status, body } = await mcpService.handlePayload(req, req.body);
    if (body === undefined) {
      return res.status(status).end();
    }
    return res.status(status).json(body);
  } catch (error) {
    console.error('[mcp] payload error:', error.message);
    return res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
});

// No streaming transport, and no state to read back.
router.all('/', (req, res) => {
  res.set('Allow', 'POST');
  res.status(405).json({
    success: false,
    message: 'MCP endpoint accepts POST only',
  });
});

module.exports = router;
