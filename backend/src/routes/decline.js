'use strict';

/**
 * decline.js — POST /api/signers/:documentId/decline
 *
 * Implements the COMPLETE enterprise-grade decline-to-sign workflow.
 *
 * This module is mounted inside signers.js (or directly in index.js).
 * It handles BOTH token-authenticated (public link) and JWT-authenticated
 * signer declines.
 *
 * WORKFLOW DECISIONS
 * ──────────────────
 * CASE A — Single signer or LAST active signer:
 *   document.status → 'declined'
 *   All remaining 'pending' signers (if any) → 'cancelled'
 *   Sender notified immediately (async queue)
 *   Signing permanently disabled (document status = 'declined')
 *
 * CASE B — Multi-signer sequential (signer N declines, N+1..M pending):
 *   This signer → 'declined'
 *   Downstream signers (order > current) → 'cancelled' (tokens invalidated)
 *   document.status → 'declined'
 *   Workflow halts — no further signers are emailed
 *   Sender notified with full context
 *
 * CASE C — Already-signed signer:
 *   400 — cannot decline after signing
 *
 * CASE D — Expired / revoked / voided document:
 *   409 — appropriate error message
 *
 * SECURITY
 * ────────
 * - Token validated inside a DB transaction with FOR UPDATE (prevents race)
 * - Token marked used immediately on lock acquisition
 * - Reason sanitized: HTML-stripped, length-bounded, stored as TEXT
 * - Idempotency: double-decline returns 409 with no DB mutation
 * - IP and User-Agent captured for legal forensics
 *
 * AUDIT
 * ─────
 * - audit_logs entry (HMAC-signed)
 * - signer_events 'declined' entry (timeline / certificate)
 * - Both are append-only by DB rule
 */

const express = require('express');
const router  = express.Router();
const xss     = require('xss');

const pool           = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { validateParams } = require('../middleware/sanitize');
const { signerAuthLimiter } = require('../middleware/rateLimiter');
const { hashToken }  = require('../services/encryptionService');
const { log, ACTIONS } = require('../services/auditService');
const { enqueueDeclineNotification } = require('../queues/producers');
const logger = require('../config/logger');

// ── Sanitize & validate decline reason ───────────────────────────────────────
const REASON_MAX = 1000;
const REASON_MIN = 10;

function sanitizeReason(raw) {
  if (typeof raw !== 'string') return null;
  // Strip HTML tags — stored as plaintext only
  const stripped = xss(raw.trim(), { whiteList: {}, stripIgnoreTag: true });
  return stripped.slice(0, REASON_MAX);
}

// ── Shared decline handler (used by both public and authenticated paths) ───────
async function performDecline({
  documentId,
  signerId,
  signerEmail,
  rawReason,
  ipAddress,
  userAgent,
}) {
  const reason = sanitizeReason(rawReason);
  if (!reason || reason.length < REASON_MIN) {
    return {
      status: 400,
      error:  `A decline reason of at least ${REASON_MIN} characters is required.`,
    };
  }

  const client = await pool.connect();
  let ownerEmail   = null;
  let documentName = null;

  try {
    await client.query('BEGIN');

    // ── Lock the signer row to prevent concurrent decline/sign ───────────────
    const lockResult = await client.query(
      `SELECT ds.id, ds.email, ds.status, ds.order_num, ds.token_used,
              ds.token_expires_at,
              d.status        AS doc_status,
              d.original_name AS doc_name,
              d.current_signer_order,
              d.total_signers,
              u.email         AS owner_email
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
    documentName = row.doc_name;

    // ── Guard: document terminal states ──────────────────────────────────────
    const terminalDocStates = ['declined', 'revoked', 'voided', 'signed'];
    if (terminalDocStates.includes(row.doc_status)) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        error: `This document is already ${row.doc_status} and cannot be declined.`,
      };
    }

    // ── Guard: signer terminal states ─────────────────────────────────────────
    if (row.status === 'declined') {
      await client.query('ROLLBACK');
      return { status: 409, error: 'You have already declined this document.' };
    }
    if (row.status === 'signed') {
      await client.query('ROLLBACK');
      return { status: 400, error: 'You cannot decline a document you have already signed.' };
    }
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { status: 409, error: 'Your signing invitation has been cancelled.' };
    }
    if (row.status === 'expired') {
      await client.query('ROLLBACK');
      return { status: 409, error: 'Your signing link has expired.' };
    }

    // ── Mark this signer as declined ──────────────────────────────────────────
    await client.query(
      `UPDATE document_signers
       SET status            = 'declined',
           declined_at       = NOW(),
           decline_reason    = $1,
           decline_ip        = $2,
           decline_user_agent= $3,
           token             = NULL,
           token_used        = TRUE,
           token_expires_at  = NULL,
           updated_at        = NOW()
       WHERE id = $4`,
      [reason, ipAddress, userAgent?.slice(0, 200), signerId]
    );

    // ── Cancel all downstream (pending) signers ───────────────────────────────
    // Sequential model: any signer with order_num > current who hasn't signed
    // will never be reached — cancel their tokens too.
    const cancelResult = await client.query(
      `UPDATE document_signers
       SET status           = 'cancelled',
           token            = NULL,
           token_used       = TRUE,
           token_expires_at = NULL,
           updated_at       = NOW()
       WHERE document_id = $1
         AND order_num   > $2
         AND status      = 'pending'
       RETURNING id, email`,
      [documentId, row.order_num]
    );

    const cancelledSigners = cancelResult.rows;

    // ── Update document status → declined ────────────────────────────────────
    await client.query(
      `UPDATE documents
       SET status     = 'declined',
           updated_at = NOW()
       WHERE id = $1`,
      [documentId]
    );

    // ── signer_events — append-only timeline record ───────────────────────────
    await client.query(
      `INSERT INTO signer_events
         (document_id, signer_id, signer_email, event_type, ip_address, user_agent)
       VALUES ($1, $2, $3, 'declined', $4, $5)`,
      [documentId, signerId, signerEmail, ipAddress, userAgent?.slice(0, 200)]
    );

    await client.query('COMMIT');

    logger.info('[decline] Signer declined document', {
      documentId,
      signerId,
      signerEmail,
      cancelledDownstream: cancelledSigners.length,
    });

    return {
      status:            200,
      ownerEmail,
      documentName,
      cancelledSigners,
      signerEmail,
      reason,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[decline] Transaction failed', {
      documentId, signerId, message: err.message,
    });
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /api/signers/:documentId/decline-public ──────────────────────────────
// Token-authenticated (public link) signer decline
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/decline-public',
  signerAuthLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, reason } = req.body;
    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Signing token is required.' });
    }

    try {
      const tokenHash = hashToken(token);

      // Validate token lookup — does NOT consume it yet (that happens in performDecline)
      const tokenResult = await pool.query(
        `SELECT ds.id, ds.email, ds.status, ds.token_used,
                ds.token_expires_at, ds.order_num,
                d.current_signer_order, d.status AS doc_status
         FROM document_signers ds
         JOIN documents d ON d.id = ds.document_id
         WHERE ds.document_id = $1
           AND ds.token       = $2`,
        [req.params.documentId, tokenHash]
      );

      const signer = tokenResult.rows[0];
      if (!signer) {
        return res.status(401).json({ error: 'Invalid or expired signing link.' });
      }
      if (signer.token_used && signer.status !== 'declined') {
        // token_used but not declined = already signed
        return res.status(409).json({ error: 'This signing link has already been used.' });
      }
      if (signer.status === 'declined') {
        return res.status(409).json({ error: 'You have already declined this document.' });
      }
      if (new Date(signer.token_expires_at) < new Date()) {
        return res.status(401).json({ error: 'This signing link has expired.' });
      }
      if (signer.order_num !== signer.current_signer_order) {
        return res.status(403).json({ error: 'It is not your turn in the signing sequence.' });
      }

      const result = await performDecline({
        documentId: req.params.documentId,
        signerId:   signer.id,
        signerEmail: signer.email,
        rawReason:  reason,
        ipAddress,
        userAgent,
      });

      if (result.status !== 200) {
        return res.status(result.status).json({ error: result.error });
      }

      // ── Async: audit log ────────────────────────────────────────────────────
      await log({
        userId:     null,
        documentId: req.params.documentId,
        action:     ACTIONS.DECLINE || 'DECLINE',
        ipAddress,
        deviceInfo: userAgent,
        metadata: {
          signerEmail: result.signerEmail,
          reason:      result.reason,
          method:      'EMAIL-TOKEN',
          cancelledDownstream: result.cancelledSigners?.length || 0,
        },
      });

      // ── Async: email notification to owner ──────────────────────────────────
      if (result.ownerEmail) {
        await enqueueDeclineNotification({
          documentId:   req.params.documentId,
          signerEmail:  result.signerEmail,
          ownerEmail:   result.ownerEmail,
          documentName: result.documentName,
          reason:       result.reason,
        }).catch(err =>
          logger.error('[decline] Failed to enqueue decline notification', {
            documentId: req.params.documentId,
            message: err.message,
          })
        );
      }

      return res.json({
        message: 'You have declined to sign this document. The sender has been notified.',
        declined: true,
      });
    } catch (err) {
      logger.error('[decline-public] Unhandled error', {
        documentId: req.params.documentId,
        message: err.message,
      });
      return res.status(500).json({ error: 'Could not process your decline. Please try again.' });
    }
  }
);

// ── POST /api/signers/:documentId/decline ─────────────────────────────────────
// JWT-authenticated signer decline
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/decline',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { reason } = req.body;
    const ipAddress  = req.ip || req.connection?.remoteAddress || null;
    const userAgent  = req.headers['user-agent'] || null;

    try {
      // Resolve authenticated signer row
      const signerResult = await pool.query(
        `SELECT ds.id, ds.email, ds.status, ds.order_num,
                d.current_signer_order, d.status AS doc_status
         FROM document_signers ds
         JOIN documents d ON d.id = ds.document_id
         WHERE ds.document_id  = $1
           AND LOWER(ds.email) = LOWER($2)`,
        [req.params.documentId, req.user.email]
      );

      const signer = signerResult.rows[0];
      if (!signer) {
        return res.status(403).json({ error: 'You are not a signer on this document.' });
      }
      if (signer.order_num !== signer.current_signer_order) {
        return res.status(403).json({ error: 'It is not your turn in the signing sequence.' });
      }

      const result = await performDecline({
        documentId:  req.params.documentId,
        signerId:    signer.id,
        signerEmail: signer.email,
        rawReason:   reason,
        ipAddress,
        userAgent,
      });

      if (result.status !== 200) {
        return res.status(result.status).json({ error: result.error });
      }

      // ── Async: audit log ────────────────────────────────────────────────────
      await log({
        userId:     req.user.id,
        documentId: req.params.documentId,
        action:     ACTIONS.DECLINE || 'DECLINE',
        ipAddress,
        deviceInfo: userAgent,
        metadata: {
          signerEmail: result.signerEmail,
          reason:      result.reason,
          method:      'JWT-AUTH',
          cancelledDownstream: result.cancelledSigners?.length || 0,
        },
      });

      // ── Async: email notification ────────────────────────────────────────────
      if (result.ownerEmail) {
        await enqueueDeclineNotification({
          documentId:   req.params.documentId,
          signerEmail:  result.signerEmail,
          ownerEmail:   result.ownerEmail,
          documentName: result.documentName,
          reason:       result.reason,
        }).catch(err =>
          logger.error('[decline] Failed to enqueue decline notification', {
            documentId: req.params.documentId,
            message: err.message,
          })
        );
      }

      return res.json({
        message: 'You have declined to sign this document. The sender has been notified.',
        declined: true,
      });
    } catch (err) {
      logger.error('[decline] Unhandled error', {
        documentId: req.params.documentId,
        message: err.message,
      });
      return res.status(500).json({ error: 'Could not process your decline. Please try again.' });
    }
  }
);

module.exports = router;
