// /backend/workers/reminderWorker.js
//
// NEW WORKER — runs as a separate process (or alongside main app).
// Scans for documents with pending recipients past 24h and fires reminders.
// Schedule: every hour (configurable).
//
// Start with: node workers/reminderWorker.js
// Or add to PM2 ecosystem: { name: 'reminder-worker', script: 'workers/reminderWorker.js' }

const Queue = require('bull');
const { query } = require('../db');
const workflowService = require('../services/workflowService');

const reminderQueue = new Queue('reminders', {
  redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

// ─── Schedule recurring job ────────────────────────────────────
// Runs every hour. Bull deduplicates — safe to restart process.
reminderQueue.add(
  'scan',
  {},
  {
    repeat: { cron: '0 * * * *' }, // every hour at :00
    jobId: 'hourly-reminder-scan', // prevents duplicate jobs
  }
);

// ─── Job processor ─────────────────────────────────────────────
reminderQueue.process('scan', async (job) => {
  console.log('[ReminderWorker] Starting scan at', new Date().toISOString());

  // Find all documents where:
  // - status is in_progress
  // - not expired
  // - has recipients in pending/viewed state
  // - last notification was sent > 24h ago (checks notifications table)
  const result = await query(`
    SELECT DISTINCT d.id AS document_id
    FROM documents d
    JOIN recipients r ON r.document_id = d.id
    WHERE d.status = 'in_progress'
      AND (d.expires_at IS NULL OR d.expires_at > NOW())
      AND r.status IN ('pending', 'viewed')
      AND r.role IN ('signer', 'approver')
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.document_id = d.id
          AND n.recipient_id = r.id
          AND n.type IN ('invitation', 'reminder')
          AND n.status = 'sent'
          AND n.sent_at > NOW() - INTERVAL '24 hours'
      )
  `);

  console.log(`[ReminderWorker] Found ${result.rows.length} documents needing reminders`);

  let sent = 0;
  let errors = 0;

  for (const row of result.rows) {
    try {
      // Use system user id (null = automated system action)
      await workflowService.sendReminders(row.document_id, null);
      sent++;
    } catch (err) {
      errors++;
      console.error(`[ReminderWorker] Failed for doc ${row.document_id}:`, err.message);
    }
  }

  console.log(`[ReminderWorker] Done. Sent: ${sent}, Errors: ${errors}`);
  return { sent, errors };
});

// ─── Expiry scanner — runs every 15 minutes ───────────────────
// Marks expired documents and revokes their tokens
const expiryQueue = new Queue('expiry-scanner', {
  redis: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
});

expiryQueue.add({}, {
  repeat: { cron: '*/15 * * * *' },
  jobId: 'expiry-scanner',
});

expiryQueue.process(async (job) => {
  const tokenService = require('../services/tokenService');
  const notificationService = require('../services/notificationService');
  const auditService = require('../services/auditService');

  const result = await query(`
    UPDATE documents
    SET status = 'expired', updated_at = NOW()
    WHERE status IN ('draft', 'in_progress', 'sent')
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
    RETURNING id
  `);

  for (const row of result.rows) {
    // Revoke all tokens for expired documents
    const tokens = await query(
      'SELECT id FROM recipients WHERE document_id = $1 AND token IS NOT NULL',
      [row.id]
    );
    await Promise.all(tokens.rows.map(r => tokenService.revoke(r.id)));

    await auditService.log('document_expired', { documentId: row.id });
    console.log(`[ExpiryScanner] Expired document ${row.id}`);
  }

  return { expired: result.rows.length };
});

// ─── Graceful shutdown ─────────────────────────────────────────
const shutdown = async () => {
  console.log('[Workers] Shutting down gracefully...');
  await reminderQueue.close();
  await expiryQueue.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('[ReminderWorker] Started — waiting for scheduled jobs...');
