'use strict';

/**
 * csrf.js — HakikiSign Enterprise CSRF Protection
 *
 * ARCHITECTURE: Signed Double-Submit Cookie Pattern
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS PATTERN?
 * -----------------
 * HakikiSign uses stateless JWT authentication — there is no server-side
 * session store. The classic "synchronizer token pattern" requires a session
 * to bind token-to-user, which we don't have.
 *
 * The Double-Submit Cookie pattern is the correct CSRF defence for stateless
 * JWT APIs:
 *   1. Server generates a random token and sets it in a NON-httpOnly cookie
 *      (JavaScript must be able to read it to copy it to a request header).
 *   2. Frontend reads the cookie and sends the value as X-CSRF-Token header.
 *   3. Server compares cookie value to header value using timing-safe equality.
 *   4. An attacker on another origin CANNOT read the cookie (SameSite + CORS),
 *      so they cannot forge the header, even if they can trigger the request.
 *
 * WHY SIGNED COOKIES?
 * -------------------
 * The cookie is signed with CSRF_COOKIE_SECRET using cookie-parser's built-in
 * HMAC. This prevents an attacker from injecting a known token value directly
 * into the cookie (cookie-stuffing / sub-domain cookie injection).
 * The signature check happens before the constant-time comparison.
 *
 * WHY NOT THE csurf PACKAGE?
 * --------------------------
 * csurf is deprecated (last release 2023-02-08, unfixed GHSA-cwfw-m4hm-frjm).
 * We implement the same algorithm manually — it's ~60 lines and fully auditable.
 *
 * EXEMPT ROUTES
 * -------------
 * Routes where CSRF is structurally impossible to attack are exempt:
 *   - Safe HTTP methods (GET, HEAD, OPTIONS) — no state change
 *   - /api/sign/* — recipient-flow, cookieless (token in URL, no session)
 *   - /api/auth/csrf-token — token issuance itself cannot be a CSRF attack
 *   - /api/health — monitoring probe, no state change
 *
 * NOTE: login, signup, logout, refresh, password-reset are NOT exempt.
 * Login CSRF is a real attack vector (login-CSRF → session fixation).
 * These routes must be CSRF-protected.
 *
 * TOKEN LIFECYCLE
 * ---------------
 *   Bootstrap : App loads → GET /api/auth/csrf-token → cookie + JSON token set
 *   Request   : Every mutating request reads cookie, sends in header
 *   Refresh   : On JWT refresh → server rotates the CSRF token simultaneously
 *   Logout    : Server clears CSRF cookie alongside refresh-token cookie
 *
 * MULTI-TAB COMPATIBILITY
 * ----------------------
 * The CSRF token is the same for all tabs (same cookie). A tab refreshing the
 * token will update the cookie, which all tabs can read. No race condition.
 * The only edge case is a tab that cached the token value in memory and is
 * mid-request when rotation happens — the retry interceptor handles this.
 */

const crypto = require('crypto');

const CSRF_COOKIE  = 'csrf_token';
const CSRF_HEADER  = 'x-csrf-token';   // must be lowercase for req.headers lookup
const TOKEN_BYTES  = 32;               // 256-bit entropy → 64 hex chars

// ── Environment-aware cookie options ─────────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production';

/**
 * cookieOptions()
 *
 * Returns cookie settings appropriate for the current environment.
 *
 * httpOnly: FALSE — JavaScript MUST be able to read this cookie to copy
 *           the value into the X-CSRF-Token header. This is by design.
 *           The refresh-token cookie (ssi_rt) is httpOnly; this one must not be.
 *
 * secure: TRUE in production — cookie only transmitted over HTTPS.
 *         Railway always provides HTTPS; this is safe.
 *         FALSE in development — localhost uses HTTP.
 *
 * sameSite: 'none' in production — required because frontend (Vercel) and
 *           backend (Railway) are different origins. SameSite=None requires
 *           Secure=true, which we set above. This is the correct setting for
 *           cross-origin SPAs with cookie-based CSRF.
 *           'lax' in development — sufficient for same-origin localhost.
 *
 * maxAge: 4 hours. Matches the intended session duration. After 4 hours the
 *         cookie expires; the next mutating request will get CSRF_MISSING and
 *         the frontend interceptor will bootstrap a new token automatically.
 *
 * path: '/' — cookie must be readable from all frontend routes.
 *
 * signed: TRUE — cookie-parser signs the value with CSRF_COOKIE_SECRET.
 *         Prevents cookie-stuffing attacks. The raw value in the cookie jar
 *         is 's:<token>.<hmac_signature>'. We verify the signature on read.
 */
function cookieOptions() {
  return {
    httpOnly: false,
    secure:   isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge:   4 * 60 * 60 * 1000,   // 4 hours in milliseconds
    path:     '/',
    signed:   true,                  // uses CSRF_COOKIE_SECRET via cookie-parser
  };
}

// ── Token generation ──────────────────────────────────────────────────────────

/**
 * generateToken()
 *
 * Returns a 32-byte (256-bit) cryptographically secure random token as
 * a 64-character hex string.
 *
 * crypto.randomBytes is sourced from the OS CSPRNG and is safe for tokens.
 * We use hex (not base64) to avoid URL-encoding issues and to keep the
 * character set simple for header transmission.
 */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * setTokenCookie(res, token)
 *
 * Writes the CSRF token into a signed cookie on the response.
 * Called by csrfTokenRoute (bootstrap) and csrfRotate (after JWT refresh).
 *
 * Returns the token so callers can also embed it in JSON responses.
 */
function setTokenCookie(res, token) {
  res.cookie(CSRF_COOKIE, token, cookieOptions());
  return token;
}

/**
 * clearTokenCookie(res)
 *
 * Expires the CSRF cookie. Called during logout.
 * Must match path/sameSite/secure of the original Set-Cookie or browsers
 * will silently ignore the clear request.
 */
function clearTokenCookie(res) {
  res.cookie(CSRF_COOKIE, '', {
    ...cookieOptions(),
    maxAge: 0,
  });
}

// ── Route: GET /api/auth/csrf-token ──────────────────────────────────────────

/**
 * csrfTokenRoute
 *
 * Bootstrap endpoint. Frontend calls this once on app load (and after
 * full page refreshes) to obtain a CSRF token.
 *
 * Response includes the token in JSON so the frontend can confirm receipt.
 * The cookie is the authoritative value; JSON is a convenience for logging.
 *
 * No authentication required — this endpoint is always public.
 * An attacker who can read this response is already same-origin.
 */
function csrfTokenRoute(req, res) {
  const token = generateToken();
  setTokenCookie(res, token);

  return res.status(200).json({
    csrfToken: token,
    expiresIn: 4 * 60 * 60,   // seconds — informational for the frontend
  });
}

// ── Middleware: validate CSRF on mutating requests ────────────────────────────

/**
 * PATHS STRUCTURALLY EXEMPT from CSRF validation.
 *
 * These are exact path segments checked via startsWith.
 * Do NOT add authenticated state-changing routes here.
 *
 * /api/sign/ is exempt because signer recipients are identified by a
 * one-time token in the URL (not a session cookie). An attacker who can
 * forge a signing request already has the signing token — CSRF protection
 * at the network layer provides no additional security here.
 */
const CSRF_EXEMPT_PREFIXES = [
  '/auth/csrf-token',   // token issuance — cannot be a CSRF target
  '/health',            // monitoring — no state change
  '/sign/',
  '/signers/',             // recipient signer flow — cookieless, token-URL auth
];

/**
 * isExempt(path)
 *
 * Returns true if the request path is exempt from CSRF validation.
 * Path here is req.path relative to the /api mount point.
 */
function isExempt(path) {
  return CSRF_EXEMPT_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * csrfProtect(req, res, next)
 *
 * Core validation middleware. Applied to all /api routes.
 *
 * Algorithm:
 *   1. Skip safe HTTP methods (GET, HEAD, OPTIONS).
 *   2. Skip structurally exempt paths.
 *   3. Read the signed cookie (cookie-parser verifies HMAC signature).
 *   4. Read the X-CSRF-Token request header.
 *   5. Reject if either is missing.
 *   6. Reject if lengths differ (fast path before timing-safe comparison).
 *   7. Timing-safe byte comparison to prevent timing side-channel.
 *
 * WHY TIMING-SAFE COMPARISON?
 * ----------------------------
 * A naive === comparison exits early on the first differing byte.
 * An attacker sending many requests with slightly different token values
 * could statistically infer the correct token by measuring response times.
 * crypto.timingSafeEqual runs in constant time regardless of where the
 * first difference occurs.
 *
 * WHY CHECK LENGTHS SEPARATELY FIRST?
 * ------------------------------------
 * crypto.timingSafeEqual throws if buffers have different lengths.
 * We must handle mismatched lengths explicitly — and we do so with a
 * constant-time branch that doesn't reveal which byte differed.
 */
function csrfProtect(req, res, next) {
  // ── 1. Safe methods ──────────────────────────────────────────────────────
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // ── 2. Exempt paths ──────────────────────────────────────────────────────
  const path = req.path || '';
  if (isExempt(path)) {
    return next();
  }

  // ── 3. Read signed cookie ────────────────────────────────────────────────
  // req.signedCookies is populated by cookie-parser when secret is provided.
  // Returns false if signature is invalid — treat as missing.
  const cookieToken = req.signedCookies[CSRF_COOKIE];

  // ── 4. Read request header ───────────────────────────────────────────────
  const headerToken = req.headers[CSRF_HEADER];

  // ── 5. Missing token check ───────────────────────────────────────────────
  if (!cookieToken || cookieToken === false) {
    return res.status(403).json({
      error:   'CSRF cookie missing or tampered. Re-initialize CSRF by calling GET /api/auth/csrf-token.',
      code:    'CSRF_MISSING',
    });
  }

  if (!headerToken) {
    return res.status(403).json({
      error:   'X-CSRF-Token header missing. Ensure the frontend sends the CSRF token on all state-changing requests.',
      code:    'CSRF_HEADER_MISSING',
    });
  }

  // ── 6 & 7. Timing-safe comparison ────────────────────────────────────────
  const cookieBuf = Buffer.from(cookieToken, 'utf8');
  const headerBuf = Buffer.from(headerToken,  'utf8');

  const lengthMatch = cookieBuf.length === headerBuf.length;

  // Even if lengths differ we run a dummy comparison on equal-length buffers
  // to avoid leaking length information via timing.
  const dummyBuf    = Buffer.alloc(cookieBuf.length, 0);
  const valueMatch  = crypto.timingSafeEqual(
    cookieBuf,
    lengthMatch ? headerBuf : dummyBuf
  );

  if (!lengthMatch || !valueMatch) {
    return res.status(403).json({
      error:   'CSRF token mismatch. The token may have rotated. Re-fetch from GET /api/auth/csrf-token.',
      code:    'CSRF_INVALID',
    });
  }

  // ── Valid ─────────────────────────────────────────────────────────────────
  next();
}

// ── Token rotation (called by auth routes) ────────────────────────────────────

/**
 * csrfRotate(res)
 *
 * Issues a fresh CSRF token and sets the cookie.
 * Called inside the refresh-token route AFTER successfully rotating the JWT
 * refresh token. Returns the new token value (embedded in the refresh JSON
 * response so the frontend can update its in-memory copy immediately without
 * a separate round-trip).
 *
 * WHY ROTATE ON JWT REFRESH?
 * --------------------------
 * If an attacker somehow captured the old CSRF token, rotating it on JWT
 * refresh limits the window during which the stale token is useful. The
 * frontend always reads the fresh cookie value from the response.
 */
function csrfRotate(res) {
  const token = generateToken();
  setTokenCookie(res, token);
  return token;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  csrfProtect,
  csrfTokenRoute,
  csrfRotate,
  clearTokenCookie,
  setTokenCookie,
  generateToken,
};
