'use strict';

/**
 * fieldService.js
 *
 * CRUD helpers for document_fields — the drag-and-drop fields a sender
 * places on a document before dispatching it to recipients.
 *
 * Field value shapes (when filled):
 *   signature, initials  → PNG data URL ('data:image/png;base64,...')
 *   date                 → ISO 8601 timestamp
 *   text                 → free text (length capped by application)
 *   checkbox             → 'true' | 'false'
 */

const pool = require('../config/database');

const FIELD_TYPES = Object.freeze(['signature', 'initials', 'date', 'text', 'checkbox']);

// ─────────────────────────────────────────────────────────────────────────────
// Write: replace the full field set for a document (owner UI save)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces the entire set of fields for a document in a single transaction.
 * Fields that were previously present but are not in the new list are deleted.
 * Also flips documents.uses_fields = TRUE so downstream code knows this doc
 * is on the multi-field flow (legacy single-signature flow is left untouched
 * for documents where this routine has never been called).
 *
 * @param {string} documentId
 * @param {Array<{
 *   signer_id: string,
 *   field_type: string,
 *   page_number: number,
 *   x_pct: number, y_pct: number, width_pct: number, height_pct: number,
 *   required?: boolean, label?: string|null
 * }>} fields
 */
async function replaceFields(documentId, fields) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validate signer_id references before wiping the old set
    const validSigners = await client.query(
      `SELECT id FROM document_signers WHERE document_id = $1`,
      [documentId]
    );
    const validSignerIds = new Set(validSigners.rows.map(r => r.id));

    for (const f of fields) {
      if (!validSignerIds.has(f.signer_id)) {
        throw new Error(`Signer ${f.signer_id} not on document ${documentId}.`);
      }
      if (!FIELD_TYPES.includes(f.field_type)) {
        throw new Error(`Invalid field_type: ${f.field_type}`);
      }
    }

    // Wipe existing field set (no filled values retained — saving = redesign).
    await client.query(
      `DELETE FROM document_fields WHERE document_id = $1`,
      [documentId]
    );

    for (const f of fields) {
      await client.query(
        `INSERT INTO document_fields
           (document_id, signer_id, field_type, page_number,
            x_pct, y_pct, width_pct, height_pct, required, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          documentId, f.signer_id, f.field_type, f.page_number || 1,
          f.x_pct, f.y_pct, f.width_pct, f.height_pct,
          f.required !== false,
          f.label || null,
        ]
      );
    }

    await client.query(
      `UPDATE documents SET uses_fields = TRUE WHERE id = $1`,
      [documentId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

async function getFieldsForDocument(documentId) {
  const result = await pool.query(
    `SELECT f.id, f.signer_id, f.field_type, f.page_number,
            f.x_pct, f.y_pct, f.width_pct, f.height_pct,
            f.required, f.label, f.value, f.filled_at,
            s.email AS signer_email, s.order_num AS signer_order
     FROM document_fields f
     JOIN document_signers s ON s.id = f.signer_id
     WHERE f.document_id = $1
     ORDER BY f.page_number, f.y_pct, f.x_pct`,
    [documentId]
  );
  return result.rows;
}

async function getFieldsForSigner(documentId, signerId) {
  const result = await pool.query(
    `SELECT id, signer_id, field_type, page_number,
            x_pct, y_pct, width_pct, height_pct,
            required, label, value, filled_at
     FROM document_fields
     WHERE document_id = $1 AND signer_id = $2
     ORDER BY page_number, y_pct, x_pct`,
    [documentId, signerId]
  );
  return result.rows;
}

async function countFieldsForSigner(documentId, signerId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM document_fields
     WHERE document_id = $1 AND signer_id = $2`,
    [documentId, signerId]
  );
  return result.rows[0].n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fill values (signer submitting their fields)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persists filled values for a signer's fields inside a transaction.
 * Ensures every field submitted belongs to (documentId, signerId) — any
 * stray field_id in the payload triggers a rollback.
 *
 * Caller must validate value formats before calling this (signatures are
 * PNG-magic checked in the route layer to match the legacy flow).
 *
 * @param {object} client — pg client (inside an active transaction)
 * @param {string} documentId
 * @param {string} signerId
 * @param {Array<{ field_id: string, value: string }>} values
 */
async function fillFieldValues(client, documentId, signerId, values) {
  const ownedRes = await client.query(
    `SELECT id, field_type, required FROM document_fields
     WHERE document_id = $1 AND signer_id = $2`,
    [documentId, signerId]
  );
  const ownedMap = new Map(ownedRes.rows.map(r => [r.id, r]));

  // Auto-fill date fields
  for (const owned of ownedRes.rows) {
    if (owned.field_type === 'date') {
      const already = values.find(v => v.field_id === owned.id);
      if (!already) {
        values.push({ field_id: owned.id, value: new Date().toISOString().split("T")[0] });
      }
    }
  }

  for (const v of values) {
    const field = ownedMap.get(v.field_id);
    if (!field) {
      throw new Error(`Field ${v.field_id} does not belong to signer.`);
    }
    await client.query(
      `UPDATE document_fields
         SET value = $1, filled_at = NOW()
       WHERE id = $2`,
      [v.value, v.field_id]
    );
  }

  // Required-field completeness check
  const requiredIds = ownedRes.rows.filter(r => r.required).map(r => r.id);
  const submittedIds = new Set(values.map(v => v.field_id));
  const missing = requiredIds.filter(id => !submittedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Missing required field value(s): ${missing.length}.`);
  }
}

module.exports = {
  FIELD_TYPES,
  replaceFields,
  getFieldsForDocument,
  getFieldsForSigner,
  countFieldsForSigner,
  fillFieldValues,
};
