const caddyfileService = require('../services/caddyfileService');

/**
 * Controller for mounted Caddyfile management (env-mounted Caddyfiles)
 */
const caddyfileController = {
  // List all mounted caddyfiles discovered from environment
  listMounted: async (req, res) => {
    try {
      const list = caddyfileService.getMountedCaddyfiles();
      return res.status(200).json({
        success: true,
        count: list.length,
        data: list
      });
    } catch (error) {
      console.error('Error listing mounted caddyfiles:', error);
      return res.status(500).json({
        success: false,
        message: 'Error listing mounted Caddyfiles',
        error: error.message
      });
    }
  },

  // Get a single mounted caddyfile metadata by ID
  getMountedById: async (req, res) => {
    try {
      const id = req.params.id;
      const entry = caddyfileService.getMountedCaddyfileById(id);
      if (!entry) {
        return res.status(404).json({ success: false, message: 'Caddyfile not found' });
      }
      return res.status(200).json({ success: true, data: entry });
    } catch (error) {
      console.error('Error fetching mounted caddyfile:', error);
      return res.status(500).json({ success: false, message: 'Error fetching mounted Caddyfile', error: error.message });
    }
  },

  // Return the raw content of the mounted caddyfile (text/plain)
  getMountedContent: async (req, res) => {
    try {
      const id = req.params.id;
      const content = caddyfileService.readMountedCaddyfileContent(id);
      // Return raw text for convenience (clients may request plain text)
      res.type('text/plain; charset=utf-8');
      return res.status(200).send(content);
    } catch (error) {
      console.error('Error reading caddyfile content:', error);
      // If file not found or config missing, surface a 404 for clarity
      if (error.message && error.message.includes('not configured')) {
        return res.status(404).json({ success: false, message: error.message });
      }
      return res.status(500).json({ success: false, message: 'Error reading Caddyfile content', error: error.message });
    }
  }
  ,

  // Admin endpoint: validate all mounted caddyfiles and return a report
  validateMounted: async (req, res) => {
    try {
      const report = caddyfileService.validateMountedCaddyfiles();
      return res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      console.error('Error validating mounted caddyfiles:', error);
      return res.status(500).json({ success: false, message: 'Error validating mounted Caddyfiles', error: error.message });
    }
  }
};

module.exports = caddyfileController;
