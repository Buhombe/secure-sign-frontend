'use strict';

/**
 * routes/decline.js — HakikiSign Decline Routes (v2)
 *
 * CHANGE FROM v1
 * ───────────────
 * Replace enqueueDeclineNotification (email-only) with
 * enqueueNotificationDecline (WhatsApp-first + email fallback).
 *
 * The owner now receives a WhatsApp decline alert if they have a phone
 * in their profile or notification_preferences. Falls back to email
 * if WhatsApp is unavailable.
 *
 * ALL DECLINE LOGIC, DB TRANSACTIONS, TOKEN VALIDATION, AND AUDIT TRAILS
 * ARE UNCHANGED. This is a surgical change to the two notification enqueue
 * calls only.
 */

const express  = require('express');
const xss      = require('xss');
const pool     = require('../config/database');
const logger   = require('../config/logger');
const { signerAuthLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/auth');
const { validateParams } = require('../middleware/sanitize');
const { hashToken }  = require('../services/encryptionService');
const { log, ACTIONS } = require('../services/auditService');

// CHANGED: use WhatsApp-first producer instead of email-only
const { enqueueNotificationDecline } = require('../queues/producers');

const router = express.Router();

const REASON_MAX = 1000;
const REASON_MIN = 10;

function sanitizeReason(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = xss(raw.trim(), { whiteList: {}, stripIgnoreTag: true });
  return stripped.slice(0, REASON_MAX);
}

// ── Shared decline handler ────────────────────────────────────────────────────

async function performDecline({
  documentId,
  signerId,
  reason,
  verificationMethod,
}) {
  const client = await pool.connect();
  let ownerEmail   = null;
  let ownerPhone   = null;  // NEW: capture for WhatsApp
  let ownerName    = null;  // NEW: capture for WhatsApp template
  let documentName = null;

  try {
    await client.query('BEGIN');

    const lockResult = await client.query(
      `SELECT ds.id, ds.email, ds.name AS signer_name, ds.status,
              ds.order_num, ds.token_used, ds.token_expires_at,
              d.status        AS doc_status,
              d.original_name AS doc_name,
              d.current_signer_order,
              d.total_signers,
              u.email         AS owner_email,
              u.name          AS owner_name
       FROM document_signers ds
       JOIN documents d ON d.id = ds.document_id
       JOIN users     u ON u.id = d.user_id
       WHERE ds.id          = $1
         AND ds.document_id = $2
       FOR UPDATE OF ds, d`,
      [signerId, documentId]
    );

    if (!lockResult.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 404, error: 'Signer record not found.' };
    }

    const row = lockResult.rows[0];
    ownerEmail   = row.owner_email;
    ownerName    = row.owner_name;
    documentName = row.doc_name;

    const terminalDocStates = ['declined', 'revoked', 'voided', 'signed'];
    if (terminalDocStates.includes(row.doc_status)) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        error: `This document is already ${row.doc_status} and cannot be declined.`,
      };
    }

    if (row.status === 'declined') {
      await client.query('ROLLBACK');
      return { status: 409, error: 'You have already declined this document.' };
    }
    if (row.status === 'signed') {
      await client.query('ROLLBACK');
      return { status: 409, error: 'You have already signed this document.' };
    }

    // Mark signer as declined
    await client.query(
      `UPDATE document_signers
       SET status       = 'declined',
           declined_at  = NOW(),
           decline_reason = $1,
           token_used   = TRUE
       WHERE id = $2`,
      [reason, signerId]
    );

    // Mark document as declined
    await client.query(
      `UPDATE documents SET status = 'declined' WHERE id = $1`,
      [documentId]
    );

    // Cancel all downstream pending signers
    const cancelResult = await client.query(
      `UPDATE document_signers
       SET status = 'cancelled'
       WHERE document_id = $1
         AND order_num > $2
         AND status = 'pending'
       RETURNING email`,
      [documentId, row.order_num]
    );

    await client.query('COMMIT');

    return {
      success:          true,
      signerEmail:      row.email,
      signerName:       row.signer_name,
      ownerEmail,
      ownerName,
      documentName,
      reason,
      cancelledSigners: cancelResult.rows.map(r => r.email),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    throw err;
  } finally {
    client.release();
  }
}

// ── Helper: load owner phone for WhatsApp notification ───────────────────────
async function loadOwnerPhone(ownerEmail) {
  try {
    const result = await pool.query(
      `SELECT u.phone
       FROM users u
       WHERE u.email = $1`,
      [ownerEmail]
    );
    return result.rows[0]?.phone || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/decline-public
// Token-based decline (unauthenticated signer with signing link)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/decline-public',
  signerAuthLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, reason: rawReason } = req.body;
    const documentId = req.params.documentId;
    const ipAddress  = req.ip;
    const userAgent  = req.headers['user-agent'] || '';

    if (!token) return res.status(400).json({ error: 'Signing token is required.' });

    const reason = sanitizeReason(rawReason);
    if (!reason || reason.length < REASON_MIN) {
      return res.status(400).json({
        error: `Please provide a reason for declining (at least ${REASON_MIN} characters).`,
      });
    }

    try {
      const tokenHash  = hashToken(token);
      const signerRow  = await pool.query(
        `SELECT id, status, token_used, token_expires_at
         FROM document_signers
         WHERE document_id = $1 AND token = $2`,
        [documentId, tokenHash]
      );

      if (!signerRow.rows[0]) return res.status(401).json({ error: 'Invalid or expired signing link.' });

      const s = signerRow.rows[0];
      if (s.token_used)                                   return res.status(401).json({ error: 'This signing link has already been used.' });
      if (new Date(s.token_expires_at) < new Date())     return res.status(401).json({ error: 'This signing link has expired.' });
      if (['declined', 'signed'].includes(s.status))     return res.status(409).json({ error: `Document already ${s.status}.` });

      const result = await performDecline({
        documentId,
        signerId: s.id,
        reason,
        verificationMethod: 'EMAIL-TOKEN',
      });

      if (!result.success) return res.status(result.status).json({ error: result.error });

      // Audit log
      await log({
        userId: null, documentId,
        action: ACTIONS.DECLINE || 'DECLINE',
        ipAddress, deviceInfo: userAgent,
        metadata: {
          signerEmail:         result.signerEmail,
          reason:              result.reason,
          method:              'EMAIL-TOKEN',
          cancelledDownstream: result.cancelledSigners?.length || 0,
        },
      });

      // ── CHANGED: WhatsApp-first decline notification ──────────────────────
      if (result.ownerEmail) {
        const ownerPhone = await loadOwnerPhone(result.ownerEmail);

        enqueueNotificationDecline({
          documentId,
          ownerEmail:   result.ownerEmail,
          ownerPhone,                        // null → orchestrator falls to email
          ownerName:    result.ownerName,
          documentName: result.documentName,
          signerName:   result.signerName || result.signerEmail,
          signerEmail:  result.signerEmail,
          declineReason: result.reason,
        }).catch(err =>
          logger.error('[decline] Failed to enqueue decline notification', {
            documentId, message: err.message,
          })
        );
      }

      return res.json({
        message: 'You have declined to sign this document. The sender has been notified.',
      });

    } catch (err) {
      logger.error('[decline-public] Error', { message: err.message });
      return res.status(500).json({ error: 'Could not process decline.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/decline-auth
// Session-based decline (authenticated user)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/decline-auth',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { reason: rawReason } = req.body;
    const documentId = req.params.documentId;
    const ipAddress  = req.ip;
    const userAgent  = req.headers['user-agent'] || '';

    const reason = sanitizeReason(rawReason);
    if (!reason || reason.length < REASON_MIN) {
      return res.status(400).json({
        error: `Please provide a reason for declining (at least ${REASON_MIN} characters).`,
      });
    }

    try {
      const signerRow = await pool.query(
        `SELECT id, status FROM document_signers
         WHERE document_id = $1 AND LOWER(email) = LOWER($2)`,
        [documentId, req.user.email]
      );

      if (!signerRow.rows[0]) return res.status(403).json({ error: 'You are not a signer on this document.' });

      const s = signerRow.rows[0];
      if (['declined', 'signed'].includes(s.status)) {
        return res.status(409).json({ error: `Document already ${s.status}.` });
      }

      const result = await performDecline({
        documentId,
        signerId: s.id,
        reason,
        verificationMethod: 'SESSION',
      });

      if (!result.success) return res.status(result.status).json({ error: result.error });

      await log({
        userId: req.user.id, documentId,
        action: ACTIONS.DECLINE || 'DECLINE',
        ipAddress, deviceInfo: userAgent,
        metadata: {
          signerEmail:         result.signerEmail,
          reason:              result.reason,
          method:              'SESSION',
          cancelledDownstream: result.cancelledSigners?.length || 0,
        },
      });

      // ── CHANGED: WhatsApp-first decline notification ──────────────────────
      if (result.ownerEmail) {
        const ownerPhone = await loadOwnerPhone(result.ownerEmail);

        enqueueNotificationDecline({
          documentId,
          ownerEmail:    result.ownerEmail,
          ownerPhone,
          ownerName:     result.ownerName,
          documentName:  result.documentName,
          signerName:    result.signerName || result.signerEmail,
          signerEmail:   result.signerEmail,
          declineReason: result.reason,
        }).catch(err =>
          logger.error('[decline-auth] Failed to enqueue decline notification', {
            documentId, message: err.message,
          })
        );
      }

      return res.json({
        message: 'You have declined to sign this document. The sender has been notified.',
      });

    } catch (err) {
      logger.error('[decline-auth] Error', { message: err.message });
      return res.status(500).json({ error: 'Could not process decline.' });
    }
  }
);

module.exports = router;
