'use strict';

/**
 * certificateService.js
 *
 * Generates a Certificate of Completion PDF — the audit-trail deliverable
 * that accompanies a fully signed envelope.
 *
 * Contents:
 *   - Envelope (document) ID and name
 *   - Sender email
 *   - Final document hash (SHA-256)
 *   - Per-signer timeline (sent / viewed / signed) with IP + device info
 *
 * The PDF is uploaded to Cloudinary under the same "raw" resource type as
 * signed documents and its URL + public_id are written back onto documents
 * (certificate_path, certificate_public_id).
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { uploadDocument } = require('./storageService');

// ── Layout constants ─────────────────────────────────────────────────────────
const PAGE_W = 612;                // 8.5"
const PAGE_H = 792;                // 11"
const MARGIN = 54;                 // .75"
const LINE_GAP = 14;
const SECTION_GAP = 22;

const COLOR = {
  dark:   rgb(0.067, 0.094, 0.153),  // #111827
  body:   rgb(0.2,   0.247, 0.333),  // #334155
  muted:  rgb(0.416, 0.455, 0.525),  // #6B7280
  accent: rgb(0.149, 0.388, 0.922),  // #2563EB
  divide: rgb(0.898, 0.906, 0.922),  // #E5E7EB
  bgCard: rgb(0.976, 0.98,  0.984),  // #F9FAFB
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—';
  const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  // 2026-04-22 15:08:56 UTC
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function shorten(s, max = 80) {
  if (!s) return '—';
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// Breaks a long string into chunks that fit within maxWidth at fontSize.
function wrapText(text, font, fontSize, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the PDF bytes and uploads to Cloudinary.
 * Also writes certificate_path / certificate_public_id onto the documents row.
 *
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function generateAndStoreCertificate(documentId) {
  // ── 1. Gather data ───────────────────────────────────────────────────────
  const docRes = await pool.query(
    `SELECT d.id, d.original_name, d.created_at, d.signed_at,
            d.file_hash, d.final_hash,
            u.email AS owner_email
     FROM documents d
     JOIN users u ON u.id = d.user_id
     WHERE d.id = $1`,
    [documentId]
  );
  if (!docRes.rows[0]) throw new Error('Document not found for certificate generation.');
  const doc = docRes.rows[0];

  const signersRes = await pool.query(
    `SELECT id, email, order_num, status, signed_at
     FROM document_signers
     WHERE document_id = $1
     ORDER BY order_num ASC`,
    [documentId]
  );
  const signers = signersRes.rows;

  const eventsRes = await pool.query(
    `SELECT signer_id, signer_email, event_type, ip_address, user_agent, timestamp
     FROM signer_events
     WHERE document_id = $1
     ORDER BY timestamp ASC`,
    [documentId]
  );
  const events = eventsRes.rows;

  // Group events per signer
  const eventsBySignerId = new Map();
  for (const s of signers) eventsBySignerId.set(s.id, []);
  for (const e of events) {
    if (e.signer_id && eventsBySignerId.has(e.signer_id)) {
      eventsBySignerId.get(e.signer_id).push(e);
    }
  }

  // ── 2. Build PDF ─────────────────────────────────────────────────────────
  const pdf = await PDFDocument.create();
  const font  = await pdf.embedFont(StandardFonts.Helvetica);
  const bold  = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const drawText = (text, opts = {}) => {
    const f = opts.bold ? bold : font;
    const size = opts.size || 10;
    page.drawText(String(text), {
      x: opts.x != null ? opts.x : MARGIN,
      y,
      size,
      font: f,
      color: opts.color || COLOR.body,
    });
  };

  const drawKV = (label, value, opts = {}) => {
    const labelWidth = 130;
    const size = 10;
    page.drawText(label, { x: MARGIN, y, size, font: bold, color: COLOR.dark });
    const valStr = String(value || '—');
    const maxWidth = PAGE_W - MARGIN - (MARGIN + labelWidth);
    const wrapped = wrapText(valStr, font, size, maxWidth);
    wrapped.forEach((ln, i) => {
      page.drawText(ln, {
        x: MARGIN + labelWidth,
        y: y - i * (size + 3),
        size,
        font: opts.mono ? font : font,
        color: COLOR.body,
      });
    });
    const consumed = (wrapped.length - 1) * (size + 3);
    y -= (LINE_GAP + consumed);
  };

  // Header band
  page.drawRectangle({
    x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70,
    color: COLOR.dark,
  });
  page.drawText('SecureSign', {
    x: MARGIN, y: PAGE_H - 32, size: 14, font: bold, color: rgb(1, 1, 1),
  });
  page.drawText('Certificate of Completion', {
    x: MARGIN, y: PAGE_H - 54, size: 18, font: bold, color: rgb(1, 1, 1),
  });
  y = PAGE_H - 100;

  // Envelope summary
  drawText('ENVELOPE SUMMARY', { bold: true, size: 9, color: COLOR.muted });
  y -= LINE_GAP;
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end:   { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 0.5, color: COLOR.divide,
  });
  y -= 8;

  drawKV('Envelope ID',    doc.id);
  drawKV('Document',       shorten(doc.original_name, 70));
  drawKV('Sender',         doc.owner_email);
  drawKV('Created',        fmtDate(doc.created_at));
  drawKV('Completed',      fmtDate(doc.signed_at));
  drawKV('Signers',        String(signers.length));

  y -= SECTION_GAP;

  // Document hash
  ensureSpace(80);
  drawText('DOCUMENT INTEGRITY', { bold: true, size: 9, color: COLOR.muted });
  y -= LINE_GAP;
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end:   { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 0.5, color: COLOR.divide,
  });
  y -= 8;

  drawKV('Original SHA-256', doc.file_hash || '—', { mono: true });
  drawKV('Final SHA-256',    doc.final_hash || '—', { mono: true });

  y -= SECTION_GAP;

  // Recipient timeline
  ensureSpace(40);
  drawText('RECIPIENT TIMELINE', { bold: true, size: 9, color: COLOR.muted });
  y -= LINE_GAP;
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end:   { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 0.5, color: COLOR.divide,
  });
  y -= 10;

  for (const signer of signers) {
    ensureSpace(90);

    // Signer header card
    const cardHeight = 18;
    page.drawRectangle({
      x: MARGIN, y: y - cardHeight + 4,
      width: PAGE_W - 2 * MARGIN, height: cardHeight,
      color: COLOR.bgCard,
    });
    page.drawText(`#${signer.order_num}  ${signer.email}`, {
      x: MARGIN + 8, y: y - 9, size: 10, font: bold, color: COLOR.dark,
    });
    const statusLabel = signer.status === 'signed' ? 'SIGNED' : signer.status.toUpperCase();
    const statusColor = signer.status === 'signed' ? rgb(0.09, 0.64, 0.29) : COLOR.muted;
    const statusWidth = bold.widthOfTextAtSize(statusLabel, 9);
    page.drawText(statusLabel, {
      x: PAGE_W - MARGIN - statusWidth - 8,
      y: y - 9, size: 9, font: bold, color: statusColor,
    });
    y -= (cardHeight + 6);

    const sEvents = eventsBySignerId.get(signer.id) || [];
    if (sEvents.length === 0) {
      drawText('No recorded events.', { size: 9, color: COLOR.muted, x: MARGIN + 16 });
      y -= LINE_GAP;
    } else {
      for (const ev of sEvents) {
        ensureSpace(24);
        const evLabel = ev.event_type.charAt(0).toUpperCase() + ev.event_type.slice(1);
        page.drawText(`• ${evLabel}`, {
          x: MARGIN + 16, y, size: 9, font: bold, color: COLOR.body,
        });
        page.drawText(fmtDate(ev.timestamp), {
          x: MARGIN + 90, y, size: 9, font, color: COLOR.body,
        });
        y -= 12;
        if (ev.ip_address || ev.user_agent) {
          const meta = `IP: ${ev.ip_address || '—'}   •   ${shorten(ev.user_agent || '—', 80)}`;
          page.drawText(meta, {
            x: MARGIN + 30, y, size: 8, font, color: COLOR.muted,
          });
          y -= 12;
        }
      }
    }
    y -= 8;
  }

  // Footer on final page
  ensureSpace(40);
  y = Math.max(y, MARGIN + 30);
  page.drawLine({
    start: { x: MARGIN, y: MARGIN + 24 },
    end:   { x: PAGE_W - MARGIN, y: MARGIN + 24 },
    thickness: 0.5, color: COLOR.divide,
  });
  page.drawText(
    'This certificate is an electronic record of the envelope activity recorded by SecureSign.',
    { x: MARGIN, y: MARGIN + 10, size: 8, font, color: COLOR.muted }
  );
  page.drawText(
    `Generated ${fmtDate(new Date())}`,
    { x: MARGIN, y: MARGIN, size: 8, font, color: COLOR.muted }
  );

  // ── 3. Save + upload ─────────────────────────────────────────────────────
  const pdfBytes = await pdf.save();
  const publicIdHint = `certificate-${uuidv4()}`;
  const uploaded = await uploadDocument(Buffer.from(pdfBytes), publicIdHint);

  await pool.query(
    `UPDATE documents
       SET certificate_path      = $1,
           certificate_public_id = $2
     WHERE id = $3`,
    [uploaded.url, uploaded.publicId, documentId]
  );

  return uploaded;
}

module.exports = { generateAndStoreCertificate };
