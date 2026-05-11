'use strict';

/**
 * auditService.js
 *
 * Centralised, append-only audit logging.
 *
 * Design principles:
 *
 *   1. APPEND-ONLY — no UPDATE or DELETE ever runs on audit_logs.
 *      The table has a DB-level trigger (installed by migration) that raises
 *      an exception if any UPDATE or DELETE is attempted, even by the app user.
 *
 *   2. STRUCTURED — every log entry carries a consistent set of fields.
 *      Downstream queries can filter, group and alert on them reliably.
 *
 *   3. NON-BLOCKING — log() never throws. If the DB write fails the action
 *      still completes — a failed audit write must not break user flow.
 *      Errors are written to stderr so they appear in server logs / alerts.
 *
 *   4. INTEGRITY HASH — each row stores a SHA-256 HMAC of its own content,
 *      keyed with AUDIT_HMAC_KEY. This lets you detect whether rows were
 *      modified at the DB level (outside the application).
 *      Verification: GET /api/audit/verify runs the check.
 *
 * Action constants — use these everywhere; never hardcode strings.
 */

const crypto = require('crypto');
const pool   = require('../config/database');

// ── Action constants ──────────────────────────────────────────────────────────
const ACTIONS = Object.freeze({
  // Auth
  SIGNUP:                   'SIGNUP',
  LOGIN:                    'LOGIN',
  LOGIN_FAILED:             'LOGIN_FAILED',
  LOGOUT:                   'LOGOUT',
  LOGOUT_ALL:               'LOGOUT_ALL',
  ACCOUNT_LOCKED:           'ACCOUNT_LOCKED',
  TOKEN_REFRESH:            'TOKEN_REFRESH',
  // Email verification (Phase 2)
  EMAIL_VERIFICATION_SENT:  'EMAIL_VERIFICATION_SENT',
  EMAIL_VERIFIED:           'EMAIL_VERIFIED',
  EMAIL_VERIFY_FAILED:      'EMAIL_VERIFY_FAILED',
  EMAIL_RESENT:             'EMAIL_RESENT',
  // Password reset (Phase 2)
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETE:  'PASSWORD_RESET_COMPLETE',
  PASSWORD_RESET_FAILED:    'PASSWORD_RESET_FAILED',
  // MFA
  MFA_ENABLED:              'MFA_ENABLED',
  MFA_DISABLED:             'MFA_DISABLED',
  MFA_AUTH:                 'MFA_AUTH',
  MFA_FAILED:               'MFA_FAILED',
  // Documents
  UPLOAD:                   'UPLOAD',
  VIEW:                     'VIEW',
  DOWNLOAD:                 'DOWNLOAD',
  DOWNLOAD_PUBLIC:          'DOWNLOAD_PUBLIC',
  SIGN:                     'SIGN',
  REVOKE:                   'REVOKE',
  // Verification
  VERIFY:                   'VERIFY',
  VERIFY_FAILED:            'VERIFY_FAILED',
  TAMPER_DETECTED:          'TAMPER_DETECTED',
  // Admin
  INTEGRITY_CHECK:          'INTEGRITY_CHECK',
});

// ── HMAC key ──────────────────────────────────────────────────────────────────
function getHmacKey() {
  const key = process.env.AUDIT_HMAC_KEY;
  if (!key || key.length < 32) {
    console.warn('[auditService] AUDIT_HMAC_KEY not set or too short. Row integrity hashing disabled.');
    return null;
  }
  return key;
}

/**
 * Computes HMAC-SHA256 over the canonical fields of a log entry.
 * Returns hex string, or null if key is not configured.
 */
function computeRowHmac({ user_id, document_id, action, ip_address, timestamp }) {
  const key = getHmacKey();
  if (!key) return null;
  const ts = timestamp instanceof Date
    ? timestamp.toISOString()
    : new Date(timestamp).toISOString();
  const payload = `${user_id || ''}|${document_id || ''}|${action}|${ip_address || ''}|${ts}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

// ── Core log function ─────────────────────────────────────────────────────────

/**
 * Appends a structured entry to audit_logs.
 *
 * @param {object} entry
 * @param {string|null} entry.userId
 * @param {string|null} entry.documentId
 * @param {string}      entry.action       — use ACTIONS constants
 * @param {string|null} entry.ipAddress
 * @param {string|null} entry.deviceInfo   — truncated to 200 chars
 * @param {object|null} entry.metadata     — arbitrary JSON (stored in metadata col)
 */
async function log({
  userId      = null,
  documentId  = null,
  action,
  ipAddress   = null,
  deviceInfo  = null,
  metadata    = null,
}) {
  try {
    const timestamp = new Date().toISOString();
    const rowHmac   = computeRowHmac({
      user_id:     userId,
      document_id: documentId,
      action,
      ip_address:  ipAddress,
      timestamp,
    });

    await pool.query(
      `INSERT INTO audit_logs
         (user_id, document_id, action, ip_address, device_info, metadata, timestamp, row_hmac)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        documentId,
        action,
        ipAddress,
        deviceInfo?.slice(0, 200) || null,
        metadata ? JSON.stringify(metadata) : null,
        timestamp,
        rowHmac,
      ]
    );
  } catch (err) {
    console.error('[auditService] Failed to write audit log:', err.message, { action, userId });
  }
}

// ── Integrity verification ────────────────────────────────────────────────────

/**
 * Verifies HMAC integrity of all audit log rows.
 * Returns { total, valid, invalid, missing, details[] }
 */
async function verifyIntegrity({ limit = 1000, offset = 0 } = {}) {
  const key = getHmacKey();
  if (!key) {
    return { error: 'AUDIT_HMAC_KEY not configured. Integrity verification unavailable.' };
  }

  const result = await pool.query(
    `SELECT id, user_id, document_id, action, ip_address, timestamp, row_hmac
     FROM audit_logs
     ORDER BY timestamp ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  let valid = 0, invalid = 0, missing = 0;
  const details = [];

  for (const row of result.rows) {
    if (!row.row_hmac) {
      missing++;
      continue;
    }
    const expected = computeRowHmac(row);
    if (expected === row.row_hmac) {
      valid++;
    } else {
      invalid++;
      details.push({
        id:        row.id,
        action:    row.action,
        timestamp: row.timestamp,
        issue:     'HMAC mismatch — row may have been modified',
      });
    }
  }

  return {
    total:   result.rows.length,
    valid,
    invalid,
    missing,
    tampered: invalid > 0,
    details,
  };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

async function getUserLogs({ userId, action = null, limit = 50, offset = 0 }) {
  const params = [userId];
  let where = 'WHERE al.user_id = $1';
  if (action) {
    params.push(action);
    where += ` AND al.action = $${params.length}`;
  }
  params.push(limit, offset);
  const limitPos  = params.length - 1;
  const offsetPos = params.length;

  const result = await pool.query(
    `SELECT
       al.id, al.action, al.timestamp, al.ip_address, al.device_info, al.metadata,
       d.original_name AS document_name
     FROM audit_logs al
     LEFT JOIN documents d ON d.id = al.document_id
     ${where}
     ORDER BY al.timestamp DESC
     LIMIT $${limitPos} OFFSET $${offsetPos}`,
    params
  );
  return result.rows;
}

async function getDocumentLogs({ documentId, limit = 100 }) {
  const result = await pool.query(
    `SELECT
       al.id, al.action, al.timestamp, al.ip_address,
       u.email AS user_email
     FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.document_id = $1
     ORDER BY al.timestamp ASC
     LIMIT $2`,
    [documentId, limit]
  );
  return result.rows;
}

module.exports = { log, verifyIntegrity, getUserLogs, getDocumentLogs, ACTIONS };
