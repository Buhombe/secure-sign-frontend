# SecureSign — Security Fixes Applied
**Date:** 2026-04-27  
**Status:** All P0–P10 critical/high fixes applied

---

## ⚠️ ONE THING YOU MUST DO MANUALLY (cannot be automated)

**Rotate these secrets RIGHT NOW before deploying:**

```bash
# 1. Generate new secrets
openssl rand -hex 64   # → new JWT_SECRET
openssl rand -hex 32   # → new FIELD_ENCRYPTION_KEY  
openssl rand -hex 32   # → new AUDIT_HMAC_KEY
```

Then:
- **Cloudinary**: cloudinary.com → Settings → Access Keys → regenerate
- **Resend**: resend.com → API Keys → delete old → create new
- Update all values in Railway environment variables (NOT in .env file)

---

## Files Changed

### NEW Files Added
| File | Purpose |
|------|---------|
| `backend/src/middleware/csrf.js` | CSRF Double-Submit Cookie protection |
| `backend/src/services/otpHelper.js` | OTP hash/verify (never store plaintext OTPs) |
| `backend/migrations/004_otp_hashing.sql` | DB migration: rename otp_code → otp_code_hash + constraint |
| `backend/.env.example` | Safe template — no real secrets |
| `backend/.gitignore` | Updated: blocks .env, .DS_Store, uploads/ |
| `frontend/.gitignore` | Updated: blocks .env, .DS_Store |

### Modified Files
| File | What Changed |
|------|-------------|
| `backend/src/index.js` | + CSRF middleware wired; + TRUST_PROXY warning; removed `global._logger` |
| `backend/src/routes/documents.js` | Hardcoded org_id → reads from `users.org_id` in DB |
| `backend/src/routes/signatures.js` | Rate limiter (10 req/15min) added to both verify endpoints |
| `frontend/src/context/AuthContext.jsx` | **Full rewrite**: token in memory only, silent refresh on load |
| `frontend/src/services/api.js` | **Full rewrite**: no localStorage; sends X-CSRF-Token header; queued refresh |
| `frontend/src/main.jsx` | Wires AuthContext → api.js to avoid circular imports |
| `frontend/src/App.jsx` | Fetches CSRF token on app load |
| `frontend/src/pages/Login.jsx` | Uses `updateToken()` from new AuthContext |
| `frontend/src/pages/SignDocument.jsx` | `localStorage.getItem('token')` → `getToken()` from AuthContext |
| `frontend/src/pages/Manage.jsx` | Same localStorage fix |
| `frontend/src/pages/PlaceFields.jsx` | Same localStorage fix |
| `frontend/src/pages/ViewDocument.jsx` | Same localStorage fix |

---

## What Each Fix Prevents

| Fix | Attack Prevented |
|-----|----------------|
| Token in memory | XSS steals access token from localStorage |
| CSRF middleware | Cross-site forged requests using your cookie |
| TRUST_PROXY | Audit logs showing proxy IP instead of real attacker IP |
| org_id from DB | User A seeing/uploading docs to User B's organization |
| OTP hashing | DB read gives attacker valid OTP codes |
| Verify rate limit | Cloudinary bandwidth abuse / cost amplification attack |
| .gitignore | Secrets accidentally committed to git |

---

## Run Migration After Deploying

```bash
psql $DATABASE_URL -f backend/migrations/004_otp_hashing.sql
```

---

## Remaining Work (Next Sprint)

1. **Test suite** — Jest + Supertest for auth flow, upload, signing
2. **Redis** — connect Bull queue for reminder worker
3. **Streaming uploads** — direct browser → Cloudinary (skip Node.js RAM)
4. **CA chain** — integrate CA for legally binding signatures
5. **Complete org isolation** — add `AND org_id = $N` to all queries

