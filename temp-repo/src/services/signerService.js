'use strict';

/**
 * signerService.js
 *
 * Multi-signer workflow for documents.
 *
 * Phase 1 security hardening:
 *   - Signer identity is resolved SERVER-SIDE by hashing a one-time raw token
 *     against document_signers.token (stored as SHA-256 hash).
 *   - Client-supplied signerEmail values are never trusted for identity.
 *   - Raw tokens are generated just-in-time (JIT) when a signer is about to
 *     be notified, and are never stored in plaintext. Re-issuing a token
 *     rotates the hash and invalidates any prior link for that signer.
 *   - After a signer completes their turn, their token hash is cleared
 *     (token = NULL) and token_used = TRUE so the row cannot be replayed.
 */

const { v4: uuidv4 } = require('uuid');
const pool           = require('../config/database');
const { hashToken }  = require('./encryptionService');
const { sendSigningEmail, sendCompletionEmail, buildSigningUrl } = require('./emailService');

const TOKEN_EXPIRY_HOURS =
  parseInt(process.env.RECIPIENT_TOKEN_EXPIRY_HOURS, 10) || 72;

// ─────────────────────────────────────────────────────────────────────────────
// Token issuance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a fresh raw token for a specific signer (documentId, orderNum),
 * stores its SHA-256 hash in document_signers.token, and returns the raw value.
 *
 * The raw token is returned EXACTLY ONCE — callers must email it to the signer
 * and then discard the value. Any prior token for this row is invalidated
 * automatically (hash is overwritten).
 *
 * Accepts an optional pg client for transactional use.
 */
async function issueSignerToken(documentId, orderNum, client = pool) {
  const rawToken  = uuidv4();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  const result = await client.query(
    `UPDATE document_signers
     SET token = $1, token_expires_at = $2, token_used = FALSE
     WHERE document_id = $3 AND order_num = $4
     RETURNING email`,
    [tokenHash, expiresAt, documentId, orderNum]
  );
  if (!result.rows[0]) {
    throw new Error(`Signer row not found (doc=${documentId}, order=${orderNum}).`);
  }
  return { rawToken, email: result.rows[0].email, expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Add signers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds signers to a document. Rows are inserted WITHOUT tokens — tokens are
 * issued just-in-time when each signer needs to be notified (via
 * sendSigningEmailForOrder or issueSignerToken).
 *
 * Inserts are duplicated order numbers are prevented by a unique constraint
 * on (document_id, order_num). Idempotency at the API layer is the caller's
 * responsibility (Phase 5 addresses idempotency keys).
 */
async function addSigners(documentId, signerEmails) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < signerEmails.length; i++) {
      const email = signerEmails[i].trim().toLowerCase();
      await client.query(
        `INSERT INTO document_signers (document_id, email, order_num)
         VALUES ($1, $2, $3)`,
        [documentId, email, i + 1]
      );
    }

    await client.query(
      `UPDATE documents
       SET total_signers = $1, current_signer_order = 1
       WHERE id = $2`,
      [signerEmails.length, documentId]
    );

    await client.query('COMMIT');
    console.log(`[signerService] Added ${signerEmails.length} signers to document ${documentId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Send signing notification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issues a fresh token for the signer at `orderNum` and emails them the link.
 * Safe to retry — each call rotates the token, invalidating any prior link.
 *
 * Returns { email, sent: boolean, error? } so callers can decide how to
 * surface delivery failures without short-circuiting the signing workflow.
 */
async function sendSigningEmailForOrder(documentId, orderNum, documentName) {
  const { rawToken, email } = await issueSignerToken(documentId, orderNum);
  const signingLink = buildSigningUrl(documentId, rawToken);

  try {
    await sendSigningEmail(email, signingLink, documentName);
    console.log(`[signerService] Email sent to signer #${orderNum}: ${email}`);
    return { email, sent: true };
  } catch (err) {
    console.error(`[signerService] Email send failed for ${email}:`, err.message);
    return { email, sent: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token-based identity resolution for the /sign-public endpoint.
 *
 * Input: raw token from the request body.
 * Output: the document_signers row (whose email is the authoritative identity)
 *         or a rejection reason.
 *
 * IMPORTANT: this function never accepts an email from the caller. The email
 * is always read from the DB row matched by the token hash.
 */
async function validateSignerToken(documentId, rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, error: 'Signing token is required.' };
  }

  const tokenHash = hashToken(rawToken);

  const result = await pool.query(
    `SELECT ds.*, d.current_signer_order
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     WHERE ds.document_id = $1 AND ds.token = $2`,
    [documentId, tokenHash]
  );
  if (!result.rows[0]) {
    return { valid: false, error: 'Invalid or unknown signing link.' };
  }

  const signer = result.rows[0];

  if (signer.token_used) {
    return { valid: false, error: 'This signing link has already been used.' };
  }
  if (signer.status === 'signed') {
    return { valid: false, error: 'This signer has already signed.' };
  }
  if (signer.order_num !== signer.current_signer_order) {
    return {
      valid: false,
      error: `Not this signer's turn yet. Waiting for signer #${signer.current_signer_order}.`,
    };
  }
  if (signer.token_expires_at && new Date() > new Date(signer.token_expires_at)) {
    return { valid: false, error: 'Signing link has expired.' };
  }

  return { valid: true, signer };
}

/**
 * Identity validation for authenticated users signing via /sign.
 *
 * Identity comes from the JWT (req.user.email) — never from the request body.
 * We look up the document_signers row by (documentId, email) and verify it
 * is this signer's turn. No token exchange is required because the JWT
 * itself is the credential.
 */
async function validateAuthenticatedSigner(documentId, userEmail) {
  const result = await pool.query(
    `SELECT ds.*, d.current_signer_order
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     WHERE ds.document_id = $1 AND ds.email = $2`,
    [documentId, userEmail.toLowerCase()]
  );
  if (!result.rows[0]) {
    return { valid: false, error: 'You are not a signer on this document.' };
  }

  const signer = result.rows[0];

  if (signer.status === 'signed') {
    return { valid: false, error: 'You have already signed.' };
  }
  if (signer.order_num !== signer.current_signer_order) {
    return {
      valid: false,
      error: `Not your turn yet. Waiting for signer #${signer.current_signer_order}.`,
    };
  }

  return { valid: true, signer };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark signed + notify next
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transitions a signer to 'signed' state and, if more signers remain in
 * the queue, issues a fresh token for the next one and emails them.
 *
 * Uses a DB transaction for the state change. Email dispatch happens AFTER
 * commit so a transient email failure cannot leave the document in an
 * inconsistent state. Email failures are logged and surfaced via the
 * return shape.
 */
async function markSignedAndNotifyNext(documentId, signerEmail, documentName) {
  const client = await pool.connect();
  let nextOrder = null;
  let complete  = false;

  try {
    await client.query('BEGIN');

    // Mark current signer as signed and wipe their token so it cannot be replayed.
    await client.query(
      `UPDATE document_signers
       SET status = 'signed',
           signed_at = NOW(),
           token_used = TRUE,
           token = NULL,
           token_expires_at = NULL
       WHERE document_id = $1 AND email = $2`,
      [documentId, signerEmail.toLowerCase()]
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
         SET status = 'signed',
             signing_complete = TRUE,
             signed_at = NOW(),
             signed_by = $1
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
    console.log(`[signerService] Document ${documentId} fully signed.`);

    // Notify owner — fetch owner email + all signer emails for the summary
    try {
      const ownerResult = await pool.query(
        `SELECT u.email AS owner_email, d.original_name,
                array_agg(ds.email ORDER BY ds.order_num) AS signer_emails
         FROM documents d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN document_signers ds ON ds.document_id = d.id
         WHERE d.id = $1
         GROUP BY u.email, d.original_name`,
        [documentId]
      );
      if (ownerResult.rows[0]) {
        const { owner_email, original_name, signer_emails } = ownerResult.rows[0];
        await sendCompletionEmail(owner_email, original_name, signer_emails || []);
      }
    } catch (emailErr) {
      console.error('[signerService] Completion email failed:', emailErr.message);
    }

    return { complete: true };
  }

  // Post-commit: email next signer. Failure does NOT roll back the sign
  // event — owner can trigger a fresh link via /regenerate-link if needed.
  await sendSigningEmailForOrder(documentId, nextOrder, documentName).catch(err =>
    console.error(`[signerService] Failed to notify next signer:`, err.message)
  );

  return { complete: false, nextOrder };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

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

module.exports = {
  addSigners,
  sendSigningEmailForOrder,
  validateSignerToken,
  validateAuthenticatedSigner,
  markSignedAndNotifyNext,
  getDocumentSigners,
  issueSignerToken,
};
