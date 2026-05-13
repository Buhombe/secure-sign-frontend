'use strict';

/**
 * routes/notificationPreferences.js — User notification preference management
 *
 * Endpoints:
 *   GET  /api/notifications/preferences       — get current user's prefs
 *   PUT  /api/notifications/preferences       — update current user's prefs
 *   GET  /api/notifications/logs              — delivery history for user's documents
 *   GET  /api/notifications/logs/:documentId  — delivery history for one document
 *
 * All routes require authenticated session (auth middleware).
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const pool    = require('../config/database');
const logger  = require('../config/logger');
const auth    = require('../middleware/auth');

const router = express.Router();
router.use(auth);  // all routes require authentication

// ── GET /api/notifications/preferences ───────────────────────────────────────

router.get('/preferences', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT primary_channel, fallback_channel, reminders_enabled,
              reminder_delay_hours, completion_enabled, language, updated_at
       FROM notification_preferences
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      // Return defaults if no row exists yet
      return res.json({
        primary_channel:      'whatsapp',
        fallback_channel:     'email',
        reminders_enabled:    true,
        reminder_delay_hours: 24,
        completion_enabled:   true,
        language:             'en',
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('[NotifPrefs] GET failed', { userId: req.user.id, message: err.message });
    res.status(500).json({ error: 'Failed to load notification preferences' });
  }
});

// ── PUT /api/notifications/preferences ───────────────────────────────────────

const prefsValidation = [
  body('primary_channel')
    .optional()
    .isIn(['whatsapp', 'email'])
    .withMessage('primary_channel must be whatsapp or email'),

  body('fallback_channel')
    .optional()
    .isIn(['whatsapp', 'email', 'none'])
    .withMessage('fallback_channel must be whatsapp, email, or none'),

  body('reminders_enabled')
    .optional()
    .isBoolean()
    .withMessage('reminders_enabled must be a boolean'),

  body('reminder_delay_hours')
    .optional()
    .isInt({ min: 1, max: 168 })
    .withMessage('reminder_delay_hours must be between 1 and 168'),

  body('completion_enabled')
    .optional()
    .isBoolean()
    .withMessage('completion_enabled must be a boolean'),

  body('language')
    .optional()
    .isIn(['en', 'sw'])
    .withMessage('language must be en or sw'),
];

router.put('/preferences', prefsValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    primary_channel,
    fallback_channel,
    reminders_enabled,
    reminder_delay_hours,
    completion_enabled,
    language,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO notification_preferences
         (user_id, primary_channel, fallback_channel, reminders_enabled,
          reminder_delay_hours, completion_enabled, language)
       VALUES ($1,
         COALESCE($2, 'whatsapp'),
         COALESCE($3, 'email'),
         COALESCE($4, true),
         COALESCE($5, 24),
         COALESCE($6, true),
         COALESCE($7, 'en'))
       ON CONFLICT (user_id) DO UPDATE SET
         primary_channel      = COALESCE($2, notification_preferences.primary_channel),
         fallback_channel     = COALESCE($3, notification_preferences.fallback_channel),
         reminders_enabled    = COALESCE($4, notification_preferences.reminders_enabled),
         reminder_delay_hours = COALESCE($5, notification_preferences.reminder_delay_hours),
         completion_enabled   = COALESCE($6, notification_preferences.completion_enabled),
         language             = COALESCE($7, notification_preferences.language),
         updated_at           = NOW()
       RETURNING primary_channel, fallback_channel, reminders_enabled,
                 reminder_delay_hours, completion_enabled, language, updated_at`,
      [req.user.id, primary_channel, fallback_channel, reminders_enabled, reminder_delay_hours, completion_enabled, language]
    );

    logger.info('[NotifPrefs] Updated', { userId: req.user.id });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('[NotifPrefs] PUT failed', { userId: req.user.id, message: err.message });
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

// ── GET /api/notifications/logs — delivery history for user's documents ───────

router.get('/logs', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      `SELECT nl.id, nl.document_id, nl.notification_type, nl.channel,
              nl.recipient, nl.status, nl.provider_id, nl.is_fallback,
              nl.error_code, nl.queued_at, nl.sent_at, nl.delivered_at,
              nl.read_at, nl.failed_at, nl.attempt_number,
              d.original_name AS document_name
       FROM notification_logs nl
       JOIN documents d ON d.id = nl.document_id
       WHERE d.user_id = $1
       ORDER BY nl.queued_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    // Mask phone numbers in response
    const rows = result.rows.map(row => ({
      ...row,
      recipient: row.channel === 'whatsapp'
        ? maskPhone(row.recipient)
        : maskEmail(row.recipient),
    }));

    res.json({ logs: rows, page, limit });
  } catch (err) {
    logger.error('[NotifLogs] GET failed', { userId: req.user.id, message: err.message });
    res.status(500).json({ error: 'Failed to load notification logs' });
  }
});

// ── GET /api/notifications/logs/:documentId ───────────────────────────────────

router.get('/logs/:documentId', async (req, res) => {
  const { documentId } = req.params;

  try {
    // Verify document belongs to user
    const ownership = await pool.query(
      `SELECT id FROM documents WHERE id = $1 AND user_id = $2`,
      [documentId, req.user.id]
    );
    if (ownership.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const result = await pool.query(
      `SELECT nl.id, nl.notification_type, nl.channel, nl.recipient,
              nl.status, nl.provider_id, nl.is_fallback, nl.error_code,
              nl.queued_at, nl.sent_at, nl.delivered_at, nl.read_at,
              nl.failed_at, nl.attempt_number,
              ds.email AS signer_email, ds.name AS signer_name
       FROM notification_logs nl
       LEFT JOIN document_signers ds ON ds.id = nl.signer_id
       WHERE nl.document_id = $1
       ORDER BY nl.queued_at DESC`,
      [documentId]
    );

    const rows = result.rows.map(row => ({
      ...row,
      recipient: row.channel === 'whatsapp'
        ? maskPhone(row.recipient)
        : maskEmail(row.recipient),
    }));

    res.json({ documentId, logs: rows });
  } catch (err) {
    logger.error('[NotifLogs] Document logs failed', {
      userId: req.user.id, documentId, message: err.message,
    });
    res.status(500).json({ error: 'Failed to load notification logs' });
  }
});

// ── Masking helpers ───────────────────────────────────────────────────────────

function maskPhone(phone) {
  if (!phone) return phone;
  return phone.slice(0, -4) + '****';
}

function maskEmail(email) {
  if (!email) return email;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return local.slice(0, 2) + '***@' + domain;
}

module.exports = router;
