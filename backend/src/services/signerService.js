'use strict';

/**
 * signerService.js — Multi-signer orchestration service
 *
 * KEY CHANGE FROM ORIGINAL:
 * ──────────────────────────
 * markSignedAndNotifyNext() previously called sendCompletionEmail() and
 * sendSigningEmailForOrder() synchronously inside the HTTP request.
 *
 * Now it enqueues those emails via BullMQ producers. The HTTP response is
 * returned immediately after the DB transaction commits. Email delivery
 * happens asynchronously in the email worker.
 *
 * This removes ~500-2000ms of email API latency from the signing response time.
 *
 * All other logic (token validation, DB updates, signer progression) is
 * UNCHANGED. The signing workflow and audit trail are identical.
 */

const pool   = require('../config/database');
const crypto = require('crypto');
const { hashToken } = require('./encryptionService');
const { buildSigningUrl } = require('./emailService');
const {
  enqueueSigningInvite,
  enqueueCompletionEmail,
} = require('../queues/producers');
const logger = require('../config/logger');

// ── Token issuance ────────────────────────────────────────────────────────────

async function issueSignerToken(documentId, signerEmail) {
  const rawToken   = crypto.randomBytes(48).toString('hex');
  const tokenHash  = hashToken(rawToken);
  const expiryHours = parseInt(process.env.RECIPIENT_TOKEN_EXPIRY_HOURS, 10) || 72;
  const expiresAt  = new Date(Date.now() + expiryHours * 3600 * 1000);

  await pool.query(
    `UPDATE document_signers
     SET token            = $1,
         token_used       = FALSE,
         token_expires_at = $2
     WHERE document_id = $3
       AND LOWER(email) = LOWER($4)`,
    [tokenHash, expiresAt, documentId, signerEmail]
  );

  return { rawToken, expiresAt };
}

// ── Signer validation ─────────────────────────────────────────────────────────

async function validateSignerToken(documentId, rawToken) {
  const tokenHash = hashToken(rawToken);

  const result = await pool.query(
    `SELECT ds.id, ds.email, ds.status, ds.token_used,
            ds.token_expires_at, ds.order_num,
            d.current_signer_order
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     WHERE ds.document_id = $1
       AND ds.token = $2`,
    [documentId, tokenHash]
  );

  const signer = result.rows[0];
  if (!signer)                              return { valid: false, error: 'Invalid signing link.' };
  if (signer.token_used)                    return { valid: false, error: 'This signing link has already been used.' };
  if (new Date(signer.token_expires_at) < new Date()) return { valid: false, error: 'This signing link has expired.' };
  if (signer.status === 'signed')           return { valid: false, error: 'You have already signed this document.' };
  if (signer.order_num !== signer.current_signer_order) {
    return { valid: false, error: 'It is not your turn to sign yet.' };
  }

  return { valid: true, signer };
}

async function validateAuthenticatedSigner(documentId, userEmail) {
  const result = await pool.query(
    `SELECT ds.id, ds.email, ds.status, ds.order_num,
            d.current_signer_order
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     WHERE ds.document_id = $1
       AND LOWER(ds.email) = LOWER($2)`,
    [documentId, userEmail]
  );

  const signer = result.rows[0];
  if (!signer)                       return { valid: false, error: 'You are not a signer on this document.' };
  if (signer.status === 'signed')    return { valid: false, error: 'You have already signed this document.' };
  if (signer.order_num !== signer.current_signer_order) {
    return { valid: false, error: 'It is not your turn to sign yet.' };
  }

  return { valid: true, signer };
}

// ── Email dispatch for a specific order ───────────────────────────────────────

/**
 * sendSigningEmailForOrder — issue a fresh token for the signer at orderNum
 * and enqueue the signing invite email.
 *
 * CHANGED: now uses enqueueSigningInvite() instead of calling emailService directly.
 */
async function sendSigningEmailForOrder(documentId, orderNum, documentName) {
  const result = await pool.query(
    `SELECT id, email FROM document_signers
     WHERE document_id = $1 AND order_num = $2`,
    [documentId, orderNum]
  );

  const signer = result.rows[0];
  if (!signer) throw new Error(`No signer found at order ${orderNum} for document ${documentId}`);

  const { rawToken } = await issueSignerToken(documentId, signer.email);
  const signingLink  = buildSigningUrl(documentId, rawToken);

  // ASYNC — email delivered by worker, not in-process
  await enqueueSigningInvite({
    documentId,
    recipientEmail: signer.email,
    documentName:   documentName || 'a document',
    signingLink,
  });

  logger.info('[signerService] Signing invite enqueued', {
    documentId, orderNum, email: signer.email,
  });
}

// ── Mark signed and advance workflow ──────────────────────────────────────────

/**
 * markSignedAndNotifyNext — DB transaction to advance the multi-signer workflow.
 *
 * CHANGED from original:
 *   - Completion email now enqueued via BullMQ (was: inline await)
 *   - Next-signer invite now enqueued via BullMQ (was: inline await)
 *   - HTTP response returns BEFORE email delivery — removes ~500ms latency
 *
 * UNCHANGED:
 *   - DB transaction logic (BEGIN/COMMIT/ROLLBACK)
 *   - Signer status updates
 *   - Document completion marking
 *   - Return value shape { complete, nextOrder }
 */
async function markSignedAndNotifyNext(documentId, signerEmail, documentName) {
  const client = await pool.connect();
  let nextOrder = null;
  let complete  = false;

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE document_signers
       SET status           = 'signed',
           signed_at        = NOW(),
           token_used       = TRUE,
           token            = NULL,
           token_expires_at = NULL
       WHERE document_id = $1 AND LOWER(email) = LOWER($2)`,
      [documentId, signerEmail]
    );

    const docResult = await client.query(
      `SELECT current_signer_order, total_signers FROM documents WHERE id = $1`,
      [documentId]
    );
    const { current_signer_order, total_signers } = docResult.rows[0];
    nextOrder = current_signer_order + 1;

    if (nextOrder > total_signers) {
      await client.query(
        `UPDATE documents
         SET status           = 'signed',
             signing_complete = TRUE,
             signed_at        = NOW(),
             signed_by        = $1
         WHERE id = $2`,
        [signerEmail, documentId]
      );
      complete = true;
    } else {
      await client.query(
        `UPDATE documents SET current_signer_order = $1 WHERE id = $2`,
        [nextOrder, documentId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (complete) {
    logger.info('[signerService] Document fully signed — enqueuing post-completion jobs', {
      documentId, signerEmail,
    });

    // Fetch owner + signer emails for completion notification
    try {
      const ownerResult = await pool.query(
        `SELECT u.email AS owner_email,
                array_agg(ds.email ORDER BY ds.order_num) AS signer_emails
         FROM documents d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN document_signers ds ON ds.document_id = d.id
         WHERE d.id = $1
         GROUP BY u.email`,
        [documentId]
      );

      if (ownerResult.rows[0]) {
        const { owner_email, signer_emails } = ownerResult.rows[0];

        // Enqueue completion email — ASYNC, does not block response
        await enqueueCompletionEmail({
          documentId,
          ownerEmail:   owner_email,
          documentName: documentName || 'document',
          signerEmails: signer_emails || [],
        }).catch(err =>
          logger.error('[signerService] Failed to enqueue completion email', {
            documentId, message: err.message,
          })
        );
      }
    } catch (err) {
      // Non-fatal — signing is complete, email is best-effort
      logger.error('[signerService] Could not fetch owner for completion email', {
        documentId, message: err.message,
      });
    }

    return { complete: true };
  }

  // Enqueue next-signer invite — ASYNC, does not block response
  sendSigningEmailForOrder(documentId, nextOrder, documentName).catch(err =>
    logger.error('[signerService] Failed to enqueue next-signer invite', {
      documentId, nextOrder, message: err.message,
    })
  );

  return { complete: false, nextOrder };
}

// ── Signer management ─────────────────────────────────────────────────────────

async function addSigners(documentId, signers) {
  if (!Array.isArray(signers) || signers.length === 0) return;

  const values = signers.map((s, i) => {
    const offset = i * 3;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  }).join(', ');

  const params = signers.flatMap((s, i) => [documentId, s.email.toLowerCase(), i + 1]);

  await pool.query(
    `INSERT INTO document_signers (document_id, email, order_num)
     VALUES ${values}
     ON CONFLICT (document_id, email) DO NOTHING`,
    params
  );
}

async function getDocumentSigners(documentId) {
  const result = await pool.query(
    `SELECT id, email, order_num, status, signed_at, token_expires_at
     FROM document_signers
     WHERE document_id = $1
     ORDER BY order_num ASC`,
    [documentId]
  );
  return result.rows;
}

async function recordSignerEvent(documentId, signerId, signerEmail, eventType, ipAddress, userAgent) {
  await pool.query(
    `INSERT INTO signer_events
       (document_id, signer_id, signer_email, event_type, ip_address, user_agent, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [documentId, signerId, signerEmail, eventType, ipAddress, userAgent?.slice(0, 200)]
  );
}

module.exports = {
  addSigners,
  sendSigningEmailForOrder,
  validateSignerToken,
  validateAuthenticatedSigner,
  markSignedAndNotifyNext,
  getDocumentSigners,
  issueSignerToken,
  recordSignerEvent,
};
