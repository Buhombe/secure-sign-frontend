# SecureSign — Phase 8 Upgrade (DocuSign-style multi-field signing)

## Deployment steps

1. **Backup DB**: `pg_dump -U <user> -d <db> > backup_before_phase8.sql`

2. **Run migration** (on Railway Postgres):
   ```
   railway connect Postgres
   \i /path/to/migrate_phase8.sql
   ```

3. **Backend**: replace files under `backend/src/` with the matching paths here, then redeploy.

4. **Frontend**: replace files under `frontend/src/` with the matching paths here, then redeploy.

5. **Verify**: upload a PDF → add signers → place fields → Save & Send → receive email → sign.

## What changed

### Backend
- `migrate_phase8.sql` — `document_fields`, `signer_events`, +cert columns on `documents`.
- `src/services/fieldService.js` **(NEW)** — CRUD for fields.
- `src/services/certificateService.js` **(NEW)** — Certificate of Completion PDF.
- `src/services/signerService.js` — adds `recordSignerEvent`, `getSignerById`; emits events.
- `src/routes/fields.js` **(NEW)** — field placement + certificate download.
- `src/routes/signers.js` — new `/submit-public` and `/submit` multi-field endpoints; legacy `/sign-public` and `/sign` preserved.
- `src/middleware/sanitize.js` — validators for `placeFields` and `submitFields`.
- `src/index.js` — registers `/api/fields` routes; bumps JSON body limit to 5MB (for PNG field values).

### Frontend
- `src/App.jsx` — registers `/place-fields/:id` route.
- `src/pages/Upload.jsx` — after upload with signers, redirects to `/place-fields/:id` (emails deferred until fields saved).
- `src/pages/PlaceFields.jsx` **(NEW)** — click-to-place + drag field UI on PDF.
- `src/pages/SignDocument.jsx` — multi-field signing flow with legacy fallback when no fields exist.
- `src/pages/Manage.jsx` — adds "📜 Certificate" download button for completed envelopes.

## Backward compatibility

- Existing documents without fields keep working through the legacy `/sign-public` / `/sign` endpoints.
- Old single-signature flow UI still triggers if `/fields/:id/my` returns an empty set.
- No existing endpoints were renamed or removed.

## Endpoints reference (new)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/fields/:documentId` | Owner saves field set | JWT |
| GET | `/api/fields/:documentId` | Owner lists fields | JWT |
| GET | `/api/fields/:documentId/my?token=…` | Signer fetches their fields | Token |
| POST | `/api/fields/:documentId/view-event` | Log VIEWED event | Token |
| GET | `/api/fields/:documentId/certificate` | Download Certificate of Completion | JWT |
| POST | `/api/fields/:documentId/regenerate-certificate` | Force regen | JWT |
| POST | `/api/signers/:documentId/dispatch` | Send first-signer email after fields saved | JWT |
| POST | `/api/signers/:documentId/submit-public` | Public multi-field submit | Token |
| POST | `/api/signers/:documentId/submit` | Authenticated multi-field submit | JWT |
