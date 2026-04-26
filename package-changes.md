# Dependency & Environment Changes
## secure-sign upgrade — production deployment notes

---

## 1. New npm packages (backend)

```bash
# Add to existing backend package.json
npm install \
  bull@^4.12.0 \         # Job queue (Redis-backed)
  twilio@^5.3.0 \        # SMS + WhatsApp notifications
  geoip-lite@^1.4.10 \   # IP geolocation for audit trail
  pdfkit@^0.15.0 \       # Audit PDF report generation
  bcryptjs \             # Already likely installed — verify
  express-rate-limit@^7.3.0  # Rate limiting for public /sign routes
```

## 2. New npm packages (frontend)

```bash
# Add to existing frontend package.json
npm install \
  react-pdf@^9.1.0 \          # PDF viewer in signing portal
  react-signature-canvas@^1.0.6  # Signature drawing pad
```

## 3. New environment variables

Add to your `.env` file (never commit these):

```env
# ── Redis (required for Bull queue) ──────────────────────────
REDIS_URL=redis://127.0.0.1:6379

# ── Twilio SMS + WhatsApp ──────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890        # Your Twilio number (SMS)
TWILIO_WHATSAPP_NUMBER=+1234567890     # WhatsApp-enabled Twilio number

# ── App URL (used in notification links) ─────────────────────
APP_URL=https://yourdomain.com         # No trailing slash

# ── Email (existing — verify these exist) ────────────────────
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxx
EMAIL_FROM=noreply@yourdomain.com
```

## 4. app.js changes — wire up new routes

```js
// In your existing app.js / server.js, ADD these lines:

const signRoutes = require('./routes/signRoutes');

// Public signing routes — no JWT, rate-limited inside signRoutes.js
// Add BEFORE your authenticated routes
app.use('/api/sign', signRoutes);

// Session middleware (needed for OTP state — add before routes)
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');

const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
  },
}));

// Also add: npm install connect-redis express-session
```

## 5. PM2 ecosystem — add worker process

```js
// ecosystem.config.js — add worker alongside your main app
module.exports = {
  apps: [
    {
      name: 'secure-sign-api',
      script: 'server.js',
      instances: 'max',
      exec_mode: 'cluster',
    },
    {
      name: 'secure-sign-worker',   // ← ADD THIS
      script: 'workers/reminderWorker.js',
      instances: 1,                 // Single worker instance
      exec_mode: 'fork',
      watch: false,
    },
  ],
};
```

## 6. Migration run order

```bash
# Run in order — each is idempotent (safe to re-run)
psql $DATABASE_URL -f backend/migrations/001_add_organizations.sql
psql $DATABASE_URL -f backend/migrations/002_workflow_audit_recipients.sql
psql $DATABASE_URL -f backend/migrations/003_add_templates.sql
```

## 7. Backward compatibility notes

| Concern | Status |
|---------|--------|
| Existing documents | Auto-assigned to default org (migration 001) |
| Existing users | Auto-assigned to default org (migration 001) |
| Existing recipients | `step_id` is nullable — existing rows unaffected |
| `documentService.create()` old callers | Still work — new params are optional |
| `documentService.list()` old callers | Still work — new filters are optional |
| `documentService.getById()` old callers | Returns same doc + new `workflowSteps` array |
| Existing document routes | Unchanged — new routes added only |
| JWT tokens in flight | `orgId` added to payload at next login only |

## 8. Existing authService — add orgId to JWT at login

```js
// In your existing authService.js login() function:

// BEFORE:
const token = jwt.sign(
  { id: user.id, email: user.email, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

// AFTER (add orgId):
const token = jwt.sign(
  { id: user.id, email: user.email, role: user.role, orgId: user.org_id },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);
```

Existing tokens remain valid — middleware only reads `orgId` if present.
Old tokens without `orgId` will fail the new `authenticate` middleware on
the first request after deploy. Users just need to re-login.
To avoid forced re-login: add a fallback in authMiddleware.js:

```js
// In authMiddleware.js, after jwt.verify():
const orgId = decoded.orgId ?? '00000000-0000-0000-0000-000000000001';
```
