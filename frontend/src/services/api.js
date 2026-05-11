/**
 * api.js — HakikiSign Axios Instance
 *
 * COMPLETE IMPLEMENTATION:
 *   ✔ Access token from memory (AuthContext, never localStorage)
 *   ✔ CSRF token from signed cookie → X-CSRF-Token header
 *   ✔ Silent JWT refresh on 401 with request queuing (no duplicated refreshes)
 *   ✔ CSRF token rotation sync after refresh
 *   ✔ CSRF recovery on 403 CSRF_INVALID / CSRF_MISSING
 *   ✔ Graceful logout on refresh failure
 *   ✔ No infinite loops
 *   ✔ Multi-tab safe (cookie is shared across tabs)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * REQUEST FLOW
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   1. App loads → useCsrfBootstrap() calls GET /api/auth/csrf-token
 *      → server sets signed CSRF cookie + returns token in JSON
 *
 *   2. Every mutating request:
 *      request interceptor reads csrf_token cookie
 *      → injects into X-CSRF-Token header
 *      → also attaches Authorization: Bearer <access-token>
 *
 *   3. If response is 401 (expired access token):
 *      → POST /api/auth/refresh (HttpOnly cookie sent automatically)
 *      → server returns: { token, csrfToken, user }
 *      → update access token in memory
 *      → update CSRF token in memory (cookie already updated by server)
 *      → retry original request with new tokens
 *      → any other queued requests are flushed with the same new token
 *
 *   4. If response is 403 CSRF_INVALID or CSRF_MISSING:
 *      → re-bootstrap CSRF token (GET /api/auth/csrf-token)
 *      → retry original request once with fresh token
 *      → if this fails again, propagate error (don't loop)
 *
 *   5. If refresh fails (refresh token expired):
 *      → call onLogout() → clear state → redirect to /login
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * RACE CONDITION HANDLING
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Without queuing, if 3 requests fire simultaneously when the access token
 * has just expired, all 3 get 401 and all 3 try to refresh simultaneously.
 * The first refresh rotates the refresh token — the 2nd and 3rd refreshes
 * fail because their refresh tokens are now stale, causing false logouts.
 *
 * Solution: isRefreshing flag + waitingQueue.
 *   - First 401 sets isRefreshing = true and starts the refresh.
 *   - Subsequent 401s add themselves to waitingQueue and wait.
 *   - When refresh completes, processQueue() resolves all waiting promises
 *     with the new token.
 *   - All queued requests retry with the same new token.
 */

import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// ── Auth context bridge ──────────────────────────────────────────────────────
// AuthContext injects these callbacks at app startup via configureApiAuth().
// This avoids circular imports between api.js and AuthContext.jsx.
// Using a ref-like object (not module-level closures) so they can be updated.
const _auth = {
  getToken:    () => null,
  updateToken: () => {},
  onLogout:    () => {},
};

export function configureApiAuth({ getToken, updateToken, onLogout }) {
  _auth.getToken    = getToken;
  _auth.updateToken = updateToken;
  _auth.onLogout    = onLogout;
}

// ── In-memory CSRF token mirror ──────────────────────────────────────────────
// The CSRF token lives primarily in a signed cookie (authoritative source).
// We also keep a mirror in memory for cases where we need the value
// synchronously after a rotation (the Set-Cookie from /refresh may not
// yet be readable by document.cookie in the same micro-task tick).
let _csrfTokenMirror = null;

export function setCsrfToken(token) {
  _csrfTokenMirror = token;
}

export function getCsrfToken() {
  // Prefer in-memory mirror (freshest after rotation);
  // fall back to reading the cookie directly.
  if (_csrfTokenMirror) return _csrfTokenMirror;
  return getCsrfCookieValue();
}

function getCsrfCookieValue() {
  // The cookie value may be URL-encoded by the browser.
  // We use decodeURIComponent for safety.
  const match = document.cookie
    .split('; ')
    .find(row => row.startsWith('csrf_token='));
  if (!match) return null;
  try {
    return decodeURIComponent(match.split('=').slice(1).join('='));
  } catch {
    return match.split('=').slice(1).join('=');
  }
}

// ── Axios instance ────────────────────────────────────────────────────────────
const api = axios.create({
  baseURL:         API_BASE,
  withCredentials: true,   // REQUIRED: sends HttpOnly cookies (refresh token)
                           // AND the CSRF cookie (so server can read it)
  timeout:         30000,  // 30 second request timeout
});

// ── Request interceptor ───────────────────────────────────────────────────────
api.interceptors.request.use(
  (config) => {
    // Attach access token from memory
    const accessToken = _auth.getToken();
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }

    // Attach CSRF token from cookie/mirror for all state-changing methods.
    // GET/HEAD/OPTIONS don't need it but it doesn't hurt to send it.
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor ──────────────────────────────────────────────────────

// Refresh-token refresh state (prevents concurrent refresh races)
let isRefreshing    = false;
let waitingQueue    = [];   // [{resolve, reject}]

// CSRF re-bootstrap state (prevents concurrent CSRF-fetch races)
let isFetchingCsrf  = false;
let csrfQueue       = [];   // [{resolve, reject}]

function processQueue(queue, error, value = null) {
  queue.forEach(({ resolve, reject }) =>
    error ? reject(error) : resolve(value)
  );
  // In-place clear (not reassign) so we can push to the same reference
  queue.splice(0, queue.length);
}

api.interceptors.response.use(
  // ── Success: pass through ────────────────────────────────────────────────
  (response) => response,

  // ── Error handling ───────────────────────────────────────────────────────
  async (error) => {
    const original = error.config;
    const status   = error.response?.status;
    const code     = error.response?.data?.code;

    // ── 401: Access token expired — attempt silent refresh ─────────────────
    if (status === 401 && !original._retryAfterRefresh) {
      original._retryAfterRefresh = true;

      // If a refresh is already in-flight, queue this request
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          waitingQueue.push({ resolve, reject });
        }).then((newAccessToken) => {
          original.headers.Authorization = `Bearer ${newAccessToken}`;
          original.headers['X-CSRF-Token'] = getCsrfToken();
          return api(original);
        });
      }

      isRefreshing = true;

      try {
        // /auth/refresh uses the HttpOnly ssi_rt cookie automatically.
        // withCredentials is inherited from the instance but we set it
        // explicitly here as documentation that this call requires the cookie.
        const { data } = await axios.post(
          `${API_BASE}/auth/refresh`,
          {},
          {
            withCredentials: true,
            // Attach current CSRF token for the refresh request itself.
            // /auth/refresh is a POST and IS CSRF-protected.
            headers: { 'X-CSRF-Token': getCsrfToken() },
          }
        );

        const newAccessToken = data.token;

        // Update access token in memory via AuthContext
        _auth.updateToken(newAccessToken, data.user);

        // Sync new CSRF token (server rotates it on refresh)
        if (data.csrfToken) {
          setCsrfToken(data.csrfToken);
        }

        // Flush waiting queue with new token
        processQueue(waitingQueue, null, newAccessToken);

        // Retry the original request
        original.headers.Authorization   = `Bearer ${newAccessToken}`;
        original.headers['X-CSRF-Token'] = getCsrfToken();
        return api(original);

      } catch (refreshError) {
        // Refresh token is gone/expired — user must re-authenticate
        processQueue(waitingQueue, refreshError, null);
        _csrfTokenMirror = null;
        _auth.onLogout();   // clears state + redirects to /login
        return Promise.reject(refreshError);

      } finally {
        isRefreshing = false;
      }
    }

    // ── 403 CSRF error — re-bootstrap CSRF token ───────────────────────────
    // This handles:
    //   - CSRF_MISSING:  Cookie expired, was blocked by browser, or cleared
    //   - CSRF_INVALID:  Token rotated in another tab, stale mirror
    //   - Any other 403 from CSRF middleware
    if (
      status === 403 &&
      (code === 'CSRF_MISSING' || code === 'CSRF_INVALID' || code === 'CSRF_HEADER_MISSING') &&
      !original._retryAfterCsrf
    ) {
      original._retryAfterCsrf = true;

      // If a CSRF bootstrap is already in-flight, queue this request
      if (isFetchingCsrf) {
        return new Promise((resolve, reject) => {
          csrfQueue.push({ resolve, reject });
        }).then(() => {
          original.headers['X-CSRF-Token'] = getCsrfToken();
          return api(original);
        });
      }

      isFetchingCsrf = true;

      try {
        // Fetch fresh CSRF token. This is a GET request — no CSRF needed.
        const { data } = await axios.get(
          `${API_BASE}/auth/csrf-token`,
          { withCredentials: true }
        );

        setCsrfToken(data.csrfToken);
        processQueue(csrfQueue, null);

        // Retry the original request with the fresh token
        original.headers['X-CSRF-Token'] = data.csrfToken;
        return api(original);

      } catch (csrfError) {
        // Failed to bootstrap CSRF — very unusual. Propagate error.
        // This could happen if the backend is down or CORS is misconfigured.
        processQueue(csrfQueue, csrfError);
        return Promise.reject(csrfError);

      } finally {
        isFetchingCsrf = false;
      }
    }

    // ── All other errors — propagate ──────────────────────────────────────
    return Promise.reject(error);
  }
);

export default api;
