const { z } = require('zod');

// Helper: 1 MB JSON limit via stringified length
function jsonWithinLimit(obj, limit = 1024 * 1024) {
  try {
    return JSON.stringify(obj).length <= limit;
  } catch {
    return false;
  }
}

const serverCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  apiUrl: z.string().trim().url().max(2048),
  apiPort: z.coerce.number().int().min(1).max(65535).default(2019),
  adminApiPath: z.string().trim().regex(/^\/[A-Za-z0-9_\-\/.]*$/).default('/config/'),
  active: z.boolean().optional(),
  description: z.string().max(500).optional().nullable(),
  tags: z.array(z.string()).optional(),
  pullExistingConfig: z.boolean().optional(),
}).passthrough(); // allow createdBy etc but will be filtered by sql whitelist

const serverUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  apiUrl: z.string().trim().url().max(2048).optional(),
  apiPort: z.coerce.number().int().min(1).max(65535).optional(),
  adminApiPath: z.string().trim().regex(/^\/[A-Za-z0-9_\-\/.]*$/).optional(),
  active: z.boolean().optional(),
  description: z.string().max(500).optional().nullable(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['online','offline','unknown']).optional(),
  activeConfig: z.string().nullable().optional(),
}).passthrough();

const testConnectionSchema = z.object({
  apiUrl: z.string().trim().url(),
  apiPort: z.coerce.number().int().min(1).max(65535),
  adminApiPath: z.string().trim().regex(/^\/[A-Za-z0-9_\-\/.]*$/).default('/config/'),
}).passthrough();

const configCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  jsonConfig: z.any().refine(v => v != null, { message: 'jsonConfig required' }).refine(v => jsonWithinLimit(v), { message: 'jsonConfig exceeds 1MB' }),
  servers: z.array(z.string()).optional(),
  server: z.string().optional(),
  format: z.string().optional(),
  status: z.enum(['draft','live','archived']).optional(),
  metadata: z.object({}).passthrough().optional(),
  history: z.array(z.any()).optional(),
}).passthrough();

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      return res.status(400).json({ success: false, message: `Validation failed: ${msg}` });
    }
    // Use parsed (coerced) data
    req.body = result.data;
    next();
  };
}

module.exports = {
  serverCreateSchema,
  serverUpdateSchema,
  testConnectionSchema,
  configCreateSchema,
  loginSchema,
  validate,
  jsonWithinLimit,
};
