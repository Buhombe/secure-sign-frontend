# HakikiSign — Notification System Testing Checklist

## Pre-Test Setup

```bash
# 1. Run migration
psql $DATABASE_URL -f migrations/007_notification_system.sql

# 2. Verify tables created
psql $DATABASE_URL -c "\dt notification_logs notification_preferences notification_templates webhook_events otp_send_log"

# 3. Verify templates seeded
psql $DATABASE_URL -c "SELECT key, channel, language FROM notification_templates ORDER BY key;"

# 4. Verify document_signers columns added
psql $DATABASE_URL -c "\d document_signers" | grep -E "whatsapp_phone|notif_channel|reminders_sent"

# 5. Start worker with Twilio credentials
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_FROM=+14155238886 \
  node src/worker.js

# 6. Expose local server for Twilio webhooks (dev only)
npx ngrok http 5000
# Copy https URL → update TWILIO_WEBHOOK_BASE_URL
```

---

## A. WhatsApp Invitation Tests

### A1 — WhatsApp invite sent when signer has phone
```bash
# Add signer with WhatsApp phone
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/add \
  -H "Cookie: $SESSION" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{
    "signers": [{
      "email": "signer@example.com",
      "phone": "+255712345678",
      "notif_channel": "whatsapp"
    }]
  }'

# Expected: HTTP 200, message contains "via whatsapp"
# Verify in DB: notification_logs row with channel='whatsapp', status='sent'
psql $DATABASE_URL -c "SELECT channel, status, provider_id, sent_at FROM notification_logs ORDER BY created_at DESC LIMIT 1;"

# Expected: WhatsApp message received on +255712345678
```

### A2 — Email fallback when no phone provided
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/add \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"signers": ["emailonly@example.com"]}'

# Expected: notification_logs channel='email', is_fallback=true OR channel='email' (direct)
```

### A3 — Legacy string-array signers still work (no regression)
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/add \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"signers": ["alice@example.com", "bob@example.com"]}'

# Expected: HTTP 200, both signers created, email sent to alice (order 1)
```

---

## B. WhatsApp Reminder Tests

### B1 — Reminder delivered via WhatsApp
```bash
# Insert a reminder job directly into BullMQ (simulate scheduler)
node -e "
const { enqueueNotificationReminder } = require('./src/queues/producers');
enqueueNotificationReminder({
  documentId: '$DOCUMENT_ID',
  signerId: '$SIGNER_ID',
  signingLink: 'https://example.com/sign/test#token=abc',
  reminderNumber: 1
}).then(() => { console.log('queued'); process.exit(0); });
"

# Expected: WhatsApp message received, notification_logs status='sent'
```

### B2 — Anti-spam: second reminder within 24h suppressed
```bash
# Send two reminders back-to-back
node -e "
const { enqueueNotificationReminder } = require('./src/queues/producers');
Promise.all([
  enqueueNotificationReminder({ documentId: '$DOCUMENT_ID', signerId: '$SIGNER_ID', signingLink: '...', reminderNumber: 1 }),
  enqueueNotificationReminder({ documentId: '$DOCUMENT_ID', signerId: '$SIGNER_ID', signingLink: '...', reminderNumber: 2 }),
]).then(() => process.exit(0));
"

# Expected: First job sends, second job logs 'suppressed: too_soon'
# Check worker logs for: '[Orchestrator] Reminder suppressed { reason: too_soon }'
```

### B3 — Max reminder cap (3 by default)
```bash
# Set reminders_sent = 3 in DB
psql $DATABASE_URL -c "UPDATE document_signers SET reminders_sent = 3 WHERE id = '$SIGNER_ID';"

# Attempt to send another reminder
node -e "
const { enqueueNotificationReminder } = require('./src/queues/producers');
enqueueNotificationReminder({ documentId: '$DOCUMENT_ID', signerId: '$SIGNER_ID', signingLink: '...', reminderNumber: 4 })
  .then(() => process.exit(0));
"

# Expected: Worker logs 'max_reminders_reached', NO WhatsApp message sent
```

---

## C. OTP Tests

### C1 — OTP sent via WhatsApp
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/send-otp \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNING_TOKEN'"}'

# Expected: HTTP 200, { channel: 'whatsapp', expiresAt: '...' }
# Expected: WhatsApp message received with 6-digit code
```

### C2 — OTP verification correct code
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNING_TOKEN'", "otpCode": "123456"}'

# Expected (correct code): HTTP 200, { verified: true }
# Expected (wrong code):   HTTP 400, { error: 'Incorrect code. 2 attempt(s) remaining.' }
```

### C3 — OTP rate limit (3 per 10 minutes)
```bash
# Send 4 OTPs in quick succession
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/send-otp \
    -H "Content-Type: application/json" \
    -d '{"token": "'$SIGNING_TOKEN'"}' | jq .
done

# Expected: first 3 succeed (HTTP 200), 4th returns HTTP 429
```

### C4 — OTP expires after 10 minutes
```bash
# Expire the OTP artificially
psql $DATABASE_URL -c "UPDATE document_signers SET otp_expires_at = NOW() - INTERVAL '1 second' WHERE id = '$SIGNER_ID';"

curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNING_TOKEN'", "otpCode": "000000"}'

# Expected: HTTP 400, { error: 'Verification code expired. Request a new one.' }
```

---

## D. Completion & Decline Tests

### D1 — Completion notification when all sign
```bash
# Sign as last signer — triggers completion
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/sign-public \
  -H "Content-Type: application/json" \
  -d '{"token": "'$LAST_SIGNER_TOKEN'", "signatureData": "data:image/png;base64,...", ...}'

# Expected: notification_logs row with type='completion', channel='whatsapp' OR 'email'
psql $DATABASE_URL -c "SELECT type, channel, status FROM notification_logs WHERE document_id = '$DOCUMENT_ID' AND notification_type = 'completion';"
```

### D2 — Decline notification (WhatsApp if owner has phone)
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/decline-public \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNER_TOKEN'", "reason": "I do not agree with the terms of this contract."}'

# Expected: notification_logs type='decline', owner notified
```

---

## E. Webhook Tests

### E1 — Valid Twilio status webhook
```bash
# Simulate Twilio delivered callback (use actual Twilio test credentials in dev)
# Twilio sandbox sends real callbacks when you send to sandbox number

# Check DB updated after delivery
psql $DATABASE_URL -c "SELECT status, delivered_at FROM notification_logs WHERE provider_id = '$MESSAGE_SID';"
# Expected: status='delivered', delivered_at IS NOT NULL
```

### E2 — Replay attack prevention
```bash
# Send same webhook payload twice
PAYLOAD='MessageSid=SM123&MessageStatus=delivered&To=whatsapp%3A%2B255712345678'
SIG=$(node -e "
const twilio = require('twilio');
console.log(twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, 'https://your-backend/api/webhooks/twilio/status', {MessageSid:'SM123',MessageStatus:'delivered',To:'whatsapp:+255712345678'}));
")

curl -X POST http://localhost:5000/api/webhooks/twilio/status \
  -H "X-Twilio-Signature: $SIG" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "$PAYLOAD"

curl -X POST http://localhost:5000/api/webhooks/twilio/status \
  -H "X-Twilio-Signature: $SIG" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "$PAYLOAD"

# Expected: first returns 200 OK, second returns 200 OK (idempotent, not processed twice)
# Check: only ONE row in webhook_events for that payload_hash
psql $DATABASE_URL -c "SELECT COUNT(*) FROM webhook_events WHERE payload_hash = (SELECT encode(digest('$PAYLOAD', 'sha256'), 'hex'));"
```

### E3 — Invalid webhook signature rejected
```bash
curl -X POST http://localhost:5000/api/webhooks/twilio/status \
  -H "X-Twilio-Signature: invalidsignature" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "MessageSid=SM999&MessageStatus=delivered"

# Expected: HTTP 403 Forbidden
```

---

## F. Notification Preferences Tests

### F1 — Get default preferences
```bash
curl http://localhost:5000/api/notifications/preferences \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF"

# Expected: { primary_channel: 'whatsapp', fallback_channel: 'email', language: 'en', ... }
```

### F2 — Update to Kiswahili + email primary
```bash
curl -X PUT http://localhost:5000/api/notifications/preferences \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"language": "sw", "primary_channel": "email"}'

# Expected: HTTP 200 with updated prefs
# Next invite to this user's signers should use Kiswahili template
```

### F3 — Invalid channel rejected
```bash
curl -X PUT http://localhost:5000/api/notifications/preferences \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"primary_channel": "sms"}'

# Expected: HTTP 422, { errors: [{ msg: 'primary_channel must be whatsapp or email' }] }
```

---

## G. Failure & Recovery Tests

### G1 — Twilio outage simulation (permanent error → email fallback)
```bash
# Temporarily set an invalid Twilio number to trigger permanent error
TWILIO_WHATSAPP_FROM=+10000000000 node src/worker.js &

# Enqueue an invite for a WhatsApp signer
node -e "
const { enqueueNotificationInvite } = require('./src/queues/producers');
enqueueNotificationInvite({ documentId: '$DOCUMENT_ID', signerId: '$WA_SIGNER_ID', signingLink: '...' })
  .then(() => process.exit(0));
"

# Expected:
#   - WhatsApp attempt logs error in notification_logs (channel='whatsapp', status='failed')
#   - Email fallback is triggered (channel='email', is_fallback=true, status='sent')
#   - Signer receives email invite
```

### G2 — Transient error retry
```bash
# Observe BullMQ retry in worker logs
# Worker logs should show:
#   '[NotifWorker] Job failed { attempt: 1, isFinalFailure: false }'
#   '[NotifWorker] Job failed { attempt: 2, isFinalFailure: false }'
#   '[NotifWorker] send-signing-invite completed'  ← on recovery
```

### G3 — Dead letter after 5 failed attempts
```bash
# Check dead-lettered job logs
# Worker logs show:
#   '[NotifWorker] DEAD LETTER — notification permanently failed'
# DB row:
psql $DATABASE_URL -c "SELECT status FROM notification_logs WHERE job_id = '$FAILED_JOB_ID';"
# Expected: status = 'undeliverable'
```

### G4 — Duplicate BullMQ job (idempotent)
```bash
# Enqueue same job ID twice
node -e "
const { notificationQueue } = require('./src/queues/index');
Promise.all([
  notificationQueue.add('send-signing-invite', { documentId: '$D', signerId: '$S', signingLink: '...' }, { jobId: 'notif:invite:$D:$S' }),
  notificationQueue.add('send-signing-invite', { documentId: '$D', signerId: '$S', signingLink: '...' }, { jobId: 'notif:invite:$D:$S' }),
]).then(() => process.exit(0));
"

# Expected: BullMQ deduplicates — only ONE job executes
# notification_logs UNIQUE constraint on idempotency_key prevents duplicate rows
```

### G5 — Railway restart recovery
```bash
# Kill worker process mid-job
kill -9 $(pgrep -f "node src/worker.js")

# Restart worker
node src/worker.js

# Expected: BullMQ 'stalled' event detected, job requeued and completed
# Worker logs: '[NotifWorker] Job stalled (lock expired)'
```

---

## H. Channel Update Tests

### H1 — Signer updates their channel to WhatsApp
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/update-channel \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNER_TOKEN'", "phone": "+255712345678", "notif_channel": "whatsapp"}'

# Expected: HTTP 200, { notif_channel: 'whatsapp', whatsapp_phone: '+25571234****' }
# Next reminder to this signer goes via WhatsApp
```

### H2 — Invalid E.164 phone rejected
```bash
curl -X POST http://localhost:5000/api/signers/$DOCUMENT_ID/update-channel \
  -H "Content-Type: application/json" \
  -d '{"token": "'$SIGNER_TOKEN'", "phone": "0712345678", "notif_channel": "whatsapp"}'

# Expected: HTTP 400, { error: 'Invalid phone number. Use format: +255712345678' }
```

---

## I. Delivery Log Tests

### I1 — View notification logs for a document
```bash
curl http://localhost:5000/api/notifications/logs/$DOCUMENT_ID \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF"

# Expected: JSON with logs array, phone numbers masked (last 4 digits replaced with ****)
```

### I2 — Unauthorized user cannot see another's logs
```bash
curl http://localhost:5000/api/notifications/logs/$OTHER_USER_DOCUMENT_ID \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF"

# Expected: HTTP 404
```

---

## J. Template Tests

### J1 — Kiswahili template used when prefs set to 'sw'
```bash
# Set language to Kiswahili
curl -X PUT http://localhost:5000/api/notifications/preferences \
  -H "Cookie: $SESSION" -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"language": "sw"}'

# Add signer with WhatsApp — verify Kiswahili message received
# Expected WhatsApp: "Ombi la Saini" (Kiswahili header)
```

### J2 — Template override in DB takes effect without restart
```bash
# Update template in DB
psql $DATABASE_URL -c "
UPDATE notification_templates
SET body = E'NEW TEMPLATE: Please sign {{document_title}}\n{{signing_link}}'
WHERE key = 'signing_invite_whatsapp_en';
"

# Reload templates without restart (worker auto-reloads on next job or you can call loadTemplatesFromDb)
# Send an invite and verify new template text appears
```

---

## K. Performance Verification

```bash
# Enqueue 50 simultaneous invite notifications
node -e "
const { enqueueNotificationInvite } = require('./src/queues/producers');
const jobs = Array.from({ length: 50 }, (_, i) =>
  enqueueNotificationInvite({
    documentId: 'doc-' + i,
    signerId: 'signer-' + i,
    signingLink: 'https://example.com/sign/doc-' + i + '#token=test'
  })
);
Promise.all(jobs).then(() => { console.log('50 jobs queued'); process.exit(0); });
"

# Monitor throughput in worker logs
# Expected: ~5 concurrent deliveries, all complete within 30 seconds
# Check Redis queue depth: redis-cli LLEN bull:notification-delivery:wait
```
