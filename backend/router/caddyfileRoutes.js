const express = require('express');
const caddyfileController = require('../controllers/caddyfileController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Protect all caddyfile routes
router.use(protect);

/**
 * @swagger
 * /api/v1/caddyfiles:
 *   get:
 *     summary: List mounted Caddyfiles configured via environment
 *     tags: [Mounted Caddyfiles]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of mounted Caddyfiles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       path:
 *                         type: string
 *                       label:
 *                         type: string
 *                       absolutePath:
 *                         type: string
 *                       exists:
 *                         type: boolean
 */
// List all mounted caddyfiles
router.get('/', caddyfileController.listMounted);

// Get metadata for a single mounted caddyfile
router.get('/:id', caddyfileController.getMountedById);

/**
 * @swagger
 * /api/v1/caddyfiles/{id}:
 *   get:
 *     summary: Get metadata for a mounted Caddyfile
 *     tags: [Mounted Caddyfiles]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Mounted Caddyfile identifier
 *     responses:
 *       200:
 *         description: Mounted Caddyfile metadata
 *       404:
 *         description: Not found
 */

// Get raw content of a mounted caddyfile
router.get('/:id/content', caddyfileController.getMountedContent);

/**
 * @swagger
 * /api/v1/caddyfiles/{id}/content:
 *   get:
 *     summary: Retrieve raw Caddyfile content for a mounted Caddyfile
 *     tags: [Mounted Caddyfiles]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Mounted Caddyfile identifier
 *     responses:
 *       200:
 *         description: Plain text Caddyfile content
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Not found
 */

// Validate mounted caddyfiles (admin)
router.get('/validate', caddyfileController.validateMounted);

/**
 * @swagger
 * /api/v1/caddyfiles/validate:
 *   get:
 *     summary: Validate that env-configured mounted Caddyfiles exist on disk
 *     tags: [Mounted Caddyfiles]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Validation report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     allExist:
 *                       type: boolean
 *                     missing:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           path:
 *                             type: string
 *                           exists:
 *                             type: boolean
 *                     checked:
 *                       type: array
 *                       items:
 *                         type: object
 */

module.exports = router;
