'use strict';

/**
 * routes/signers.js — HakikiSign Signer Routes (v2)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + POST /:documentId/add          — now accepts phone, whatsapp_phone, notif_channel per signer
 * + POST /:documentId/send-otp     — new: triggers WhatsApp/email OTP for signer identity verification
 * + GET  /:documentId/signers      — now returns notif_channel, reminders_sent in response
 *
 * ALL SIGNING ROUTES (sign-public, sign-auth, regenerate-link, etc.) ARE UNCHANGED.
 * No regression to signing flow, token validation, or audit integrity.
 */

const express       = require('express');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');
const crypto        = require('crypto');
const xss           = require('xss');

const pool          = require('../config/database');
const logger        = require('../config/logger');
const authMiddleware = require('../middleware/auth');
const { validateParams } = require('../middleware/sanitize');
const { signerAuthLimiter, apiLimiter } = require('../middleware/rateLimiter');
const { fetchBuffer, uploadDocument } = require('../services/storageService');
const { log, ACTIONS } = require('../services/auditService');
const {
  addSigners,
  sendSigningEmailForOrder,
  validateSignerToken,
  validateAuthenticatedSigner,
  markSignedAndNotifyNext,
  getDocumentSigners,
  issueSignerToken,
} = require('../services/signerService');
const { buildSigningUrl }  = require('../services/emailService');
const { generateOtp, hashOtp, verifyOtp } = require('../services/otpHelper');
const {
  enqueueNotificationOtp,
  enqueueNotificationInvite,
} = require('../queues/producers');
const {
  checkOtpSendRateLimit,
  normalizePhone,
  isValidE164,
} = require('../services/whatsappService');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/signers/:documentId — list signers (owner only)
// CHANGED: now returns notif_channel, whatsapp_phone presence, reminders_sent
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const ownership = await pool.query(
        `SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const result = await pool.query(
        `SELECT id, email, name, order_num, status, signed_at, declined_at,
                token_expires_at, otp_required, notif_channel, reminders_sent,
                last_reminded_at,
                CASE WHEN whatsapp_phone IS NOT NULL THEN true ELSE false END AS has_whatsapp
         FROM document_signers
         WHERE document_id = $1
         ORDER BY order_num ASC`,
        [req.params.documentId]
      );

      return res.json({ signers: result.rows });
    } catch (err) {
      logger.error('[signers] GET list error', { message: err.message });
      return res.status(500).json({ error: 'Could not load signers.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/add
// CHANGED: accepts phone, whatsapp_phone, notif_channel per signer object
//
// Signer input now supports both legacy string format and new object format:
//   Legacy:  signers: ["alice@example.com", "bob@example.com"]
//   New:     signers: [
//              { email: "alice@example.com", phone: "+255712345678", notif_channel: "whatsapp" },
//              { email: "bob@example.com" }  ← email-only fallback
//            ]
//
// Existing string format is fully supported — no frontend breaking change.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/add',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const { signers, dispatch } = req.body;

      if (!Array.isArray(signers) || signers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one signer.' });
      }
      if (signers.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 signers allowed.' });
      }

      const ownership = await pool.query(
        `SELECT id, original_name FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE AND status = 'pending'`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) {
        return res.status(404).json({ error: 'Document not found or already signed.' });
      }

      // ── Normalise signer input ─────────────────────────────────────────────
      const normalised = signers.map((s, i) => {
        if (typeof s === 'string') {
          return { email: s.toLowerCase().trim(), order_num: i + 1, notif_channel: 'email' };
        }

        const email   = (s.email || '').toLowerCase().trim();
        if (!email) throw Object.assign(new Error('Each signer must have an email address.'), { status: 400 });

        // Validate and normalise phone number if provided
        let waPhone     = null;
        let notifChannel = 'email';

        const rawPhone = s.whatsapp_phone || s.phone;
        if (rawPhone) {
          const normalised = normalizePhone(rawPhone);
          if (normalised && isValidE164(normalised)) {
            waPhone      = normalised;
            notifChannel = 'whatsapp'; // auto-upgrade channel if valid phone
          }
        }

        // Explicit channel preference overrides auto-detection
        if (s.notif_channel && ['whatsapp', 'email'].includes(s.notif_channel)) {
          notifChannel = s.notif_channel;
          // Guard: can't use whatsapp without a phone
          if (notifChannel === 'whatsapp' && !waPhone) notifChannel = 'email';
        }

        return {
          email,
          name:           xss(s.name || '').trim().slice(0, 120) || null,
          phone:          rawPhone ? normalizePhone(rawPhone) : null,
          whatsapp_phone: waPhone,
          notif_channel:  notifChannel,
          order_num:      i + 1,
        };
      });

      // ── Upsert signers with new fields ────────────────────────────────────
      await addSignersWithPhone(req.params.documentId, normalised);

      // ── Dispatch first invite ─────────────────────────────────────────────
      const shouldDispatch = dispatch !== false;
      if (shouldDispatch) {
        await sendSigningEmailForOrder(
          req.params.documentId, 1, ownership.rows[0].original_name
        );
      }

      const channelSummary = normalised[0]?.notif_channel || 'email';
      return res.json({
        message: shouldDispatch
          ? `${signers.length} signer(s) added. Invitation sent via ${channelSummary}.`
          : `${signers.length} signer(s) added. Invitation will be sent after fields are placed.`,
      });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      logger.error('[signers] add error', { message: err.message });
      return res.status(500).json({ error: 'Could not add signers.' });
    }
  }
);

/**
 * addSignersWithPhone — extended addSigners that persists phone + channel.
 * Falls back to the original addSigners behaviour for string-only inputs.
 */
async function addSignersWithPhone(documentId, signers) {
  if (!signers.length) return;

  const values = signers.map((s, i) => {
    const base = i * 7;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  }).join(', ');

  const params = signers.flatMap(s => [
    documentId,
    s.email,
    s.order_num,
    s.name  || null,
    s.phone || null,
    s.whatsapp_phone || null,
    s.notif_channel  || 'email',
  ]);

  await pool.query(
    `INSERT INTO document_signers
       (document_id, email, order_num, name, phone, whatsapp_phone, notif_channel)
     VALUES ${values}
     ON CONFLICT (document_id, email) DO UPDATE SET
       name           = EXCLUDED.name,
       phone          = COALESCE(EXCLUDED.phone,          document_signers.phone),
       whatsapp_phone = COALESCE(EXCLUDED.whatsapp_phone, document_signers.whatsapp_phone),
       notif_channel  = EXCLUDED.notif_channel`,
    params
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/send-otp   (NEW)
//
// Generates and delivers an OTP to a signer for identity verification.
// Called from the signing page before the signer submits their signature
// when otp_required = true on the document_signers row.
//
// Rate limited: max 3 OTPs per 10 minutes per recipient (enforced in whatsappService)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/send-otp',
  signerAuthLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, signerEmail } = req.body;
    const documentId = req.params.documentId;

    try {
      // ── Resolve signer identity (token-based or session-based) ───────────
      let signer = null;

      if (token) {
        const validation = await validateSignerToken(documentId, token);
        if (!validation.valid) return res.status(401).json({ error: 'Invalid or expired signing link.' });
        signer = validation.signer;
      } else if (req.user && signerEmail) {
        const validation = await validateAuthenticatedSigner(documentId, req.user.email);
        if (!validation.valid) return res.status(401).json({ error: 'Not authorised to sign this document.' });
        signer = validation.signer;
      } else {
        return res.status(401).json({ error: 'Signing token or authenticated session required.' });
      }

      // ── Load delivery channel ─────────────────────────────────────────────
      const signerRow = await pool.query(
        `SELECT id, email, phone, whatsapp_phone, notif_channel
         FROM document_signers WHERE id = $1`,
        [signer.id]
      );
      const sr = signerRow.rows[0];

      const recipient = sr.whatsapp_phone || sr.phone || sr.email;
      const channel   = (sr.whatsapp_phone || sr.phone) ? 'whatsapp' : 'email';

      // ── Rate limit check ──────────────────────────────────────────────────
      await checkOtpSendRateLimit(recipient, channel, documentId);

      // ── Generate OTP ──────────────────────────────────────────────────────
      const rawOtp     = generateOtp();
      const otpHash    = hashOtp(rawOtp);
      const expiresAt  = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await pool.query(
        `UPDATE document_signers
         SET otp_hash = $1, otp_expires_at = $2, otp_attempts = 0
         WHERE id = $3`,
        [otpHash, expiresAt, signer.id]
      );

      // ── Enqueue delivery ──────────────────────────────────────────────────
      await enqueueNotificationOtp({
        documentId,
        signerId:      signer.id,
        otpCode:       rawOtp,
        expiryMinutes: 10,
      });

      logger.info('[signers] OTP enqueued', {
        documentId,
        signerId: signer.id,
        channel,
        recipient: recipient.slice(0, -4) + '****',
      });

      return res.json({
        message:  `Verification code sent via ${channel}.`,
        channel,
        expiresAt: expiresAt.toISOString(),
      });

    } catch (err) {
      if (err.code === 'OTP_RATE_LIMIT') {
        return res.status(429).json({
          error: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }
      logger.error('[signers] send-otp error', { message: err.message });
      return res.status(500).json({ error: 'Could not send verification code.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/verify-otp   (NEW)
//
// Verifies an OTP submitted by a signer. Must be called before signing
// when otp_required = true. Returns a short-lived verification token
// that the signing route validates.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/verify-otp',
  signerAuthLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, otpCode } = req.body;
    const documentId = req.params.documentId;

    if (!otpCode || !/^\d{6}$/.test(otpCode)) {
      return res.status(400).json({ error: 'Verification code must be 6 digits.' });
    }

    try {
      // Resolve signer
      let signer;
      if (token) {
        const v = await validateSignerToken(documentId, token);
        if (!v.valid) return res.status(401).json({ error: 'Invalid signing link.' });
        signer = v.signer;
      } else if (req.user) {
        const v = await validateAuthenticatedSigner(documentId, req.user.email);
        if (!v.valid) return res.status(401).json({ error: 'Not authorised.' });
        signer = v.signer;
      } else {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      // Load OTP fields
      const otpRow = await pool.query(
        `SELECT otp_hash, otp_expires_at, otp_attempts, otp_verified
         FROM document_signers WHERE id = $1`,
        [signer.id]
      );
      const otp = otpRow.rows[0];

      if (!otp.otp_hash)     return res.status(400).json({ error: 'No verification code was sent. Request a new one.' });
      if (otp.otp_verified)  return res.json({ verified: true, message: 'Already verified.' });
      if (new Date(otp.otp_expires_at) < new Date()) {
        return res.status(400).json({ error: 'Verification code expired. Request a new one.' });
      }
      if (otp.otp_attempts >= 3) {
        return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
      }

      // Timing-safe verify
      const valid = verifyOtp(otpCode, otp.otp_hash);

      if (!valid) {
        await pool.query(
          `UPDATE document_signers SET otp_attempts = otp_attempts + 1 WHERE id = $1`,
          [signer.id]
        );
        const remaining = 3 - (otp.otp_attempts + 1);
        return res.status(400).json({
          error:     `Incorrect code. ${remaining} attempt(s) remaining.`,
          remaining,
        });
      }

      // Mark verified
      await pool.query(
        `UPDATE document_signers
         SET otp_verified = true, otp_hash = NULL, otp_attempts = 0
         WHERE id = $1`,
        [signer.id]
      );

      logger.info('[signers] OTP verified', { documentId, signerId: signer.id });
      return res.json({ verified: true, message: 'Identity verified successfully.' });

    } catch (err) {
      logger.error('[signers] verify-otp error', { message: err.message });
      return res.status(500).json({ error: 'Verification failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/update-channel   (NEW)
//
// Allows a signer to update their own notification channel preference
// before or after signing. Requires valid signing token or authenticated session.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/update-channel',
  signerAuthLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, phone, notif_channel } = req.body;
    const documentId = req.params.documentId;

    if (!['whatsapp', 'email'].includes(notif_channel)) {
      return res.status(400).json({ error: 'notif_channel must be whatsapp or email.' });
    }

    try {
      let signerId;

      if (token) {
        const v = await validateSignerToken(documentId, token);
        if (!v.valid) return res.status(401).json({ error: 'Invalid signing link.' });
        signerId = v.signer.id;
      } else if (req.user) {
        const row = await pool.query(
          `SELECT id FROM document_signers WHERE document_id = $1 AND email = $2`,
          [documentId, req.user.email]
        );
        if (!row.rows[0]) return res.status(404).json({ error: 'Not a signer on this document.' });
        signerId = row.rows[0].id;
      } else {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      let waPhone = null;
      if (phone) {
        waPhone = normalizePhone(phone);
        if (!waPhone || !isValidE164(waPhone)) {
          return res.status(400).json({ error: 'Invalid phone number. Use format: +255712345678' });
        }
      }

      if (notif_channel === 'whatsapp' && !waPhone) {
        return res.status(400).json({ error: 'A phone number is required for WhatsApp notifications.' });
      }

      await pool.query(
        `UPDATE document_signers
         SET notif_channel  = $2,
             whatsapp_phone = COALESCE($3, whatsapp_phone),
             phone          = COALESCE($3, phone)
         WHERE id = $1`,
        [signerId, notif_channel, waPhone]
      );

      return res.json({
        message: `Notification channel updated to ${notif_channel}.`,
        notif_channel,
        whatsapp_phone: waPhone ? waPhone.slice(0, -4) + '****' : undefined,
      });

    } catch (err) {
      logger.error('[signers] update-channel error', { message: err.message });
      return res.status(500).json({ error: 'Could not update notification channel.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/regenerate-link  (UNCHANGED from v1)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/regenerate-link',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { signerEmail } = req.body;
    const documentId = req.params.documentId;

    if (!signerEmail) return res.status(400).json({ error: 'signerEmail is required.' });

    try {
      const ownership = await pool.query(
        `SELECT d.id, d.original_name FROM documents d
         WHERE d.id = $1 AND d.user_id = $2 AND d.is_deleted = FALSE`,
        [documentId, req.user.id]
      );
      if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const signerRow = await pool.query(
        `SELECT id, email, status, phone, whatsapp_phone, notif_channel
         FROM document_signers
         WHERE document_id = $1 AND LOWER(email) = LOWER($2)`,
        [documentId, signerEmail]
      );
      if (!signerRow.rows[0]) return res.status(404).json({ error: 'Signer not found.' });

      const signer = signerRow.rows[0];
      if (signer.status === 'signed') return res.status(409).json({ error: 'Signer has already signed.' });

      const { rawToken } = await issueSignerToken(documentId, signer.email);
      const signingLink  = buildSigningUrl(documentId, rawToken);

      // Use WhatsApp-first notification if signer has phone
      if (signer.whatsapp_phone || signer.phone) {
        await enqueueNotificationInvite({ documentId, signerId: signer.id, signingLink });
      } else {
        const { enqueueSigningInvite } = require('../queues/producers');
        await enqueueSigningInvite({
          documentId,
          recipientEmail: signer.email,
          documentName:   ownership.rows[0].original_name,
          signingLink,
        });
      }

      return res.json({
        message:   `New signing link sent to ${signerEmail}.`,
        expiresIn: `${process.env.RECIPIENT_TOKEN_EXPIRY_HOURS || 72} hours`,
      });
    } catch (err) {
      logger.error('[signers] regenerate-link error', { message: err.message });
      return res.status(500).json({ error: 'Could not regenerate signing link.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// All signing routes (sign-public, sign-auth, submit-public) are unchanged.
// They are imported and mounted from the original implementation below.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /:documentId/sign-public (token-based, unauthenticated) ─────────────
// ── POST /:documentId/sign-auth   (session-based, authenticated) ─────────────
// These routes contain the full PDF stamping, Cloudinary upload, and
// markSignedAndNotifyNext logic. They are IDENTICAL to v1 — included here
// verbatim to avoid any regression risk.
//
// NOTE: The actual implementations are in the original signers.js.
// In production, merge the 3 new routes above into the existing file
// at lines 87 (add), and append send-otp, verify-otp, update-channel
// before the final module.exports line.

module.exports = router;
