'use strict';

const { z } = require('zod');
const { password: pwCfg } = require('../config/security');

// ── Reusable primitives ───────────────────────────────────────────────────────

const emailSchema = z
  .string({ required_error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .email('Invalid email address.')
  .max(254, 'Email too long.');

const passwordSchema = z
  .string({ required_error: 'Password is required.' })
  .min(pwCfg.minLength, `Password must be at least ${pwCfg.minLength} characters.`)
  .max(128, 'Password too long.')
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/,
    'Password must contain uppercase, lowercase, a number, and a special character.'
  );

// Coordinate as percentage (0–100)
const coordSchema = z.coerce.number().min(0).max(100);

// Dimension in PDF points
const dimSchema = (min, max) => z.coerce.number().min(min).max(max);

// UUID v4 format
const uuidSchema = z
  .string()
  .uuid('Invalid ID format.');

// Pagination
const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).partial();

// ── Route schemas ─────────────────────────────────────────────────────────────

const schemas = {

  // ── Auth ──────────────────────────────────────────────────────────────────

  signup: z.object({
    email:    emailSchema,
    password: passwordSchema,
  }).strict(),

  login: z.object({
    email:    emailSchema,
    // Looser on login — bcrypt decides correctness, not the schema
    password: z.string({ required_error: 'Password is required.' }).min(1).max(128),
  }).strict(),

  // ── Email verification (Phase 2) ──────────────────────────────────────────

  // GET /api/auth/verify-email?token=... — token in query string
  verifyEmailQuery: z.object({
    token: z
      .string({ required_error: 'Verification token is required.' })
      .length(64, 'Invalid verification token.')
      .regex(/^[a-f0-9]{64}$/, 'Invalid verification token format.'),
  }),

  // POST /api/auth/resend-verification — body: { email }
  resendVerification: z.object({
    email: emailSchema,
  }).strict(),

  // ── Password reset (Phase 2) ──────────────────────────────────────────────

  // POST /api/auth/forgot-password — body: { email }
  forgotPassword: z.object({
    email: emailSchema,
  }).strict(),

  // POST /api/auth/reset-password — body: { token, password }
  // token here is the raw 32-byte hex token from the reset email link
  resetPassword: z.object({
    token:    z
      .string({ required_error: 'Reset token is required.' })
      .length(64, 'Invalid reset token.')
      .regex(/^[a-f0-9]{64}$/, 'Invalid reset token format.'),
    password: passwordSchema,
  }).strict(),

  // ── MFA ───────────────────────────────────────────────────────────────────

  verifyMfa: z.object({
    token: z
      .string({ required_error: 'TOTP code is required.' })
      .length(6, 'TOTP code must be exactly 6 digits.')
      .regex(/^\d{6}$/, 'TOTP code must contain only digits.'),
  }).strict(),

  disableMfa: z.object({
    token:    z.string().length(6).regex(/^\d{6}$/),
    password: z.string().min(1).max(128),
  }).strict(),

  // ── Documents ─────────────────────────────────────────────────────────────

  uploadDocument: z.object({
    recipient_email: emailSchema
      .optional()
      .or(z.literal(''))
      .transform(v => v || undefined),
  }).strict(),

  addSigners: z.object({
    signers: z.array(emailSchema).min(1).max(10),
  }),

  signDocument: z.object({
    signatureData: z
      .string({ required_error: 'Signature data is required.' })
      .min(100,  'Signature data too short.')
      .max(500_000, 'Signature data too large.')
      .regex(
        /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,
        'Signature must be a PNG data URL.'
      ),
    sigX:       coordSchema.default(0),
    sigY:       coordSchema.default(0),
    sigWidth:   dimSchema(10, 500).default(200),
    sigHeight:  dimSchema(10, 200).default(80),
    pageNumber: z.coerce.number().int().min(1).max(9999).default(1),
  }).strict(),

  // ── Params / query validation ─────────────────────────────────────────────

  documentId: z.object({
    id: uuidSchema,
  }),

  signatureDocumentId: z.object({
    documentId: uuidSchema,
  }),

  recipientToken: z.object({
    token: z
      .string({ required_error: 'Token is required.' })
      .min(32, 'Invalid token.')
      .max(128, 'Invalid token.')
      .regex(/^[a-f0-9-]+$/i, 'Invalid token format.'),
  }),

  pagination: paginationSchema,
};

// ── Middleware factories ───────────────────────────────────────────────────────

function validate(schemaName) {
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`Unknown validation schema: "${schemaName}"`);

  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error:  'Validation failed.',
        errors: result.error.errors.map(e => ({
          field:   e.path.join('.'),
          message: e.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

function validateParams(schemaName) {
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`Unknown validation schema: "${schemaName}"`);

  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({
        error:  'Invalid request parameters.',
        errors: result.error.errors.map(e => ({
          field:   e.path.join('.'),
          message: e.message,
        })),
      });
    }
    req.params = result.data;
    next();
  };
}

function validateQuery(schemaName) {
  const schema = schemas[schemaName];
  if (!schema) throw new Error(`Unknown validation schema: "${schemaName}"`);

  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error:  'Invalid query parameters.',
        errors: result.error.errors.map(e => ({
          field:   e.path.join('.'),
          message: e.message,
        })),
      });
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validate, validateParams, validateQuery, schemas };
