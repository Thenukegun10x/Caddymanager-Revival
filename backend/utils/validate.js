const { z } = require('zod');

// Helper: 1 MB JSON limit via stringified length
function jsonWithinLimit(obj, limit = 1024 * 1024) {
  try {
    return JSON.stringify(obj).length <= limit;
  } catch {
    return false;
  }
}

const serverNameSchema = z.string()
  .trim()
  .min(1)
  .max(100)
  // M11: no CR/LF or YAML/header metacharacters in a name that reaches headers
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, 'name may contain letters, digits, space, dot, dash, underscore');

const serverCreateSchema = z.object({
  name: serverNameSchema,
  apiUrl: z.string().trim().url().max(2048),
  apiPort: z.coerce.number().int().min(1).max(65535).default(2019),
  adminApiPath: z.string().trim().regex(/^\/[A-Za-z0-9_\-\/.]*$/).default('/config/'),
  active: z.boolean().optional(),
  description: z.string().max(500).optional().nullable(),
  tags: z.array(z.string()).optional(),
  pullExistingConfig: z.boolean().optional(),
}).passthrough(); // allow createdBy etc but will be filtered by sql whitelist

const serverUpdateSchema = z.object({
  name: serverNameSchema.optional(),
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

// H5: cap length before matching and use Zod's linear-time email pattern.
const emailSchema = z
  .string()
  .trim()
  .max(254, 'email must be at most 254 characters')
  .email('please provide a valid email address')
  .transform(v => v.toLowerCase());

// Empty string is allowed where the field is optional (profile forms submit "").
const optionalEmailSchema = z
  .union([emailSchema, z.literal('')])
  .optional()
  .nullable();

// H4: shared password policy for both database engines.
const COMMON_PASSWORDS = new Set([
  'password1234', 'passwordpassword', 'qwertyqwerty', 'letmeinletmein',
  'adminadmin123', 'welcomewelcome', 'changemechangeme', 'caddymanager',
  'password12345', '123456789012', 'qwerty123456', 'iloveyou1234',
]);

const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(128, 'password must be at most 128 characters')
  .refine(v => {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
      .filter(re => re.test(v)).length;
    return classes >= 3;
  }, 'password must use at least 3 of: lowercase, uppercase, digit, symbol')
  .refine(v => !COMMON_PASSWORDS.has(v.toLowerCase()), 'password is too common');

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
}).passthrough();

const updateProfileSchema = z.object({
  username: z.string().trim().min(3).max(30).optional(),
  email: optionalEmailSchema,
}).passthrough();

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(30),
  email: optionalEmailSchema,
  password: passwordSchema,
  role: z.enum(['admin', 'user']).optional(),
}).passthrough();


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
  emailSchema,
  passwordSchema,
  changePasswordSchema,
  updateProfileSchema,
  createUserSchema,
  validate,
  jsonWithinLimit,
};
