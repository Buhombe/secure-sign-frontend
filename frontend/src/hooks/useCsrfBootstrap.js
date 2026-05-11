/**
 * useCsrfBootstrap.js — CSRF Token Initialization Hook
 *
 * This hook fetches the initial CSRF token when the app loads.
 *
 * WHEN IS THIS NEEDED?
 * ══════════════════════════════════════════════════════════════════════════════
 * The CSRF cookie is set by the server and has a 4-hour maxAge. On first
 * load (or after the cookie expires), the cookie doesn't exist yet.
 * Without bootstrapping, the first mutating request (e.g., login) would get
 * a 403 CSRF_MISSING — recovered by the interceptor, but causes an extra
 * round-trip that degrades UX.
 *
 * Bootstrapping on app load ensures the cookie is present before any user
 * action triggers a mutation.
 *
 * IDEMPOTENCY
 * ══════════════════════════════════════════════════════════════════════════════
 * The bootstrap only runs once per app session (guarded by csrfBootstrapped ref
 * from AuthContext). Even in React StrictMode (which double-invokes effects in
 * dev), the second invocation is a no-op.
 *
 * If the cookie already exists (page refresh within 4h), the server still
 * issues a fresh signed cookie — this is intentional. The signed cookie is
 * cheap to reissue and ensures the signature is valid for our current secret.
 *
 * PAGE REFRESH BEHAVIOR
 * ══════════════════════════════════════════════════════════════════════════════
 * On page refresh:
 *   1. React re-mounts → useCsrfBootstrap runs
 *   2. GET /api/auth/csrf-token → new signed cookie set
 *   3. In-memory mirror updated
 *   4. App renders normally
 *
 * Meanwhile, if the user had an active session:
 *   1. Any API call with the access token (lost from memory) gets 401
 *   2. Silent refresh fires → new access token from refresh cookie
 *   3. Request retried
 *
 * These are independent — CSRF bootstrap and JWT refresh don't race because
 * the bootstrap is a GET (CSRF-exempt) and the first auth-required request
 * triggers refresh on its own 401.
 *
 * ERROR HANDLING
 * ══════════════════════════════════════════════════════════════════════════════
 * If bootstrap fails (network error, server down), we log the error but
 * don't block the app. The interceptor's CSRF recovery path handles the
 * subsequent 403 gracefully. The app degrades to: "first mutation triggers
 * bootstrap retry."
 */

import { useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { setCsrfToken } from '../services/api';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export function useCsrfBootstrap() {
  const { csrfBootstrapped } = useAuth();

  useEffect(() => {
    // Guard: only bootstrap once per mount cycle
    if (csrfBootstrapped.current) return;

    let cancelled = false;

    async function bootstrap() {
      try {
        const { data } = await axios.get(
          `${API_BASE}/auth/csrf-token`,
          {
            withCredentials: true,
            // Use a short timeout for the bootstrap — we don't want the
            // app to hang waiting for this non-critical initialization.
            timeout: 8000,
          }
        );

        if (!cancelled) {
          setCsrfToken(data.csrfToken);
          csrfBootstrapped.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          // Non-fatal: the interceptor will recover on the first CSRF error.
          // Log for debugging but don't throw or show UI error.
          console.warn('[CSRF Bootstrap] Failed to fetch initial CSRF token:', err?.message);
          // Don't set csrfBootstrapped.current = true here.
          // The next call to this effect (e.g., after reconnect) will retry.
        }
      }
    }

    bootstrap();

    return () => { cancelled = true; };
  }, [csrfBootstrapped]);
}
