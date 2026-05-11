/**
 * main.jsx — HakikiSign App Entry Point
 *
 * WIRING ORDER:
 *   1. AuthProvider: provides auth state and token management
 *   2. ApiConfigurer: connects AuthContext callbacks to Axios interceptors
 *   3. CsrfBootstrapper: fetches initial CSRF token before first mutation
 *   4. App: renders routes
 *
 * WHY SEPARATE ApiConfigurer AND CsrfBootstrapper?
 * ══════════════════════════════════════════════════════════════════════════════
 * ApiConfigurer must run first (before any API calls) to wire up the
 * interceptors. It uses useAuth() and must be inside AuthProvider.
 *
 * CsrfBootstrapper runs after ApiConfigurer is mounted — it will use the
 * now-configured axios instance. Keeping them separate avoids a single
 * component doing too much and makes each concern testable independently.
 *
 * WHY NOT FETCH CSRF IN AuthProvider?
 * ══════════════════════════════════════════════════════════════════════════════
 * AuthProvider must be side-effect-free to avoid circular dependency.
 * AuthProvider → api.js → AuthProvider would create a dependency cycle.
 * The hook approach breaks this cycle: AuthProvider exports callbacks,
 * api.js consumes them, and the hook calls api.js after both are wired.
 */

import { StrictMode } from 'react';
import { createRoot }  from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { configureApiAuth } from './services/api.js';
import { useCsrfBootstrap } from './hooks/useCsrfBootstrap.js';

/**
 * ApiConfigurer
 *
 * Mounts inside AuthProvider. On first render, wires the AuthContext
 * callbacks into the Axios interceptors via configureApiAuth().
 *
 * This component renders its children immediately — it does not delay
 * rendering for CSRF initialization. If a user triggers an action before
 * CSRF is bootstrapped, the interceptor's recovery path handles it.
 */
function ApiConfigurer({ children }) {
  const { getToken, updateToken, logout } = useAuth();

  // Wire once — these callbacks are stable (wrapped in useCallback in AuthContext).
  // configureApiAuth() is idempotent; calling it again overwrites the previous
  // callbacks. In StrictMode this runs twice in dev — that's fine.
  configureApiAuth({
    getToken,
    updateToken,
    onLogout: () => {
      // logout() clears auth state server-side + locally.
      // Then redirect to login page.
      logout().finally(() => {
        window.location.href = '/login';
      });
    },
  });

  return children;
}

/**
 * CsrfBootstrapper
 *
 * Fetches the CSRF token once on app mount. Must be inside ApiConfigurer
 * (so interceptors are wired) and AuthProvider (so csrfBootstrapped ref
 * is accessible).
 *
 * Renders children immediately — does not gate rendering on CSRF readiness.
 */
function CsrfBootstrapper({ children }) {
  useCsrfBootstrap();
  return children;
}

// ── Render tree ───────────────────────────────────────────────────────────────
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <ApiConfigurer>
        <CsrfBootstrapper>
          <App />
        </CsrfBootstrapper>
      </ApiConfigurer>
    </AuthProvider>
  </StrictMode>
);
