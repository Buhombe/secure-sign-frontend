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

const coordSchema = z.coerce.number().min(0).max(100);
const dimSchema = (min, max) => z.coerce.number().min(min).max(max);
const uuidSchema = z.string().uuid('Invalid ID format.');

const paginationSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).partial();

// Phase 8
const fieldTypeSchema = z.enum(['signature', 'initials', 'date', 'text', 'checkbox']);

const fieldPlacementSchema = z.object({
  signer_id:   uuidSchema,
  field_type:  fieldTypeSchema,
  page_number: z.coerce.number().int().min(1).max(9999).default(1),
  x_pct:       coordSchema,
  y_pct:       coordSchema,
  width_pct:   z.coerce.number().min(0.5).max(100),
  height_pct:  z.coerce.number().min(0.5).max(100),
  required:    z.boolean().optional().default(true),
  label:       z.string().max(100).optional().nullable(),
}).strict();

const submitValueSchema = z.object({
  field_id: uuidSchema,
  value:    z.string({ required_error: 'Value is required.' }).max(1_000_000, 'Value too large.'),
}).strict();

// ── Route schemas ─────────────────────────────────────────────────────────────

const schemas = {
  signup: z.object({
    email:    emailSchema,
    password: passwordSchema,
  }).strict(),

  login: z.object({
    email:    emailSchema,
    password: z.string({ required_error: 'Password is required.' }).min(1).max(128),
  }).strict(),

  verifyEmailQuery: z.object({
    token: z.string({ required_error: 'Verification token is required.' })
      .length(64, 'Invalid verification token.')
      .regex(/^[a-f0-9]{64}$/, 'Invalid verification token format.'),
  }),

  resendVerification: z.object({ email: emailSchema }).strict(),

  forgotPassword: z.object({ email: emailSchema }).strict(),

  resetPassword: z.object({
    token:    z.string({ required_error: 'Reset token is required.' })
      .length(64, 'Invalid reset token.')
      .regex(/^[a-f0-9]{64}$/, 'Invalid reset token format.'),
    password: passwordSchema,
  }).strict(),

  verifyMfa: z.object({
    token: z.string({ required_error: 'TOTP code is required.' })
      .length(6, 'TOTP code must be exactly 6 digits.')
      .regex(/^\d{6}$/, 'TOTP code must contain only digits.'),
  }).strict(),

  disableMfa: z.object({
    token:    z.string().length(6).regex(/^\d{6}$/),
    password: z.string().min(1).max(128),
  }).strict(),

  uploadDocument: z.object({
    recipient_email: emailSchema.optional().or(z.literal('')).transform(v => v || undefined),
  }).strict(),

  addSigners: z.object({
    signers: z.array(emailSchema).min(1).max(10),
  }),

  signDocument: z.object({
    signatureData: z.string({ required_error: 'Signature data is required.' })
      .min(100,  'Signature data too short.')
      .max(500_000, 'Signature data too large.')
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, 'Signature must be a PNG data URL.'),
    sigX:       coordSchema.default(0),
    sigY:       coordSchema.default(0),
    sigWidth:   dimSchema(10, 500).default(200),
    sigHeight:  dimSchema(10, 200).default(80),
    pageNumber: z.coerce.number().int().min(1).max(9999).default(1),
  }).strict(),

  // Phase 8
  placeFields: z.object({
    fields: z.array(fieldPlacementSchema).min(1).max(200),
  }).strict(),

  submitFields: z.object({
    token:  z.string().optional(),
    values: z.array(submitValueSchema).min(1).max(200),
  }),

  documentId:          z.object({ id: uuidSchema }),
  signatureDocumentId: z.object({ documentId: uuidSchema }),

  recipientToken: z.object({
    token: z.string({ required_error: 'Token is required.' })
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
        errors: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
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
        errors: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
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
        errors: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
      });
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validate, validateParams, validateQuery, schemas };
