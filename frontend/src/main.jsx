/**
 * main.jsx — HakikiSign App Entry Point
 *
 * PROVIDER WIRING ORDER (innermost dependencies first):
 *   1. AuthProvider          — auth state + token management (no deps)
 *   2. ApiConfigurer         — wires AuthContext → Axios interceptors
 *   3. CsrfBootstrapper      — fetches initial CSRF token
 *   4. QueryClientProvider   — TanStack Query: server-state management
 *   5. ToastProvider         — global notification system
 *   6. App                   — router + pages
 *
 * WHY QueryClientProvider WRAPS App (not inside it):
 *   All pages and hooks use useQuery/useMutation. They must be inside the
 *   QueryClientProvider tree. Placing it here ensures the queryClient is
 *   available to every route, including lazily-loaded ones.
 *
 * QUERY CLIENT LIFECYCLE:
 *   On logout, queryClient.clear() is called (in ApiConfigurer's onLogout)
 *   to wipe all cached server state. This prevents data leakage between
 *   different user sessions on shared devices.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import './index.css';
import App from './App.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { configureApiAuth } from './services/api.js';
import { useCsrfBootstrap } from './hooks/useCsrfBootstrap.js';
import { queryClient } from './lib/queryClient.js';
import { ToastProvider } from './context/ToastContext.jsx';

/**
 * ApiConfigurer — wires AuthContext callbacks into the Axios interceptors.
 * Must be inside AuthProvider. Runs synchronously on first render.
 */
function ApiConfigurer({ children }) {
  const { getToken, updateToken, logout } = useAuth();

  configureApiAuth({
    getToken,
    updateToken,
    onLogout: () => {
      // Clear all server-state caches on logout — no stale data for next user
      queryClient.clear();
      logout().finally(() => {
        window.location.href = '/login';
      });
    },
  });

  return children;
}

/**
 * CsrfBootstrapper — fetches the initial CSRF token on app mount.
 * Must be inside ApiConfigurer (interceptors wired) and AuthProvider.
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
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <App />
            </ToastProvider>
            {/* DevTools: zero-cost in production (tree-shaken) */}
            {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
          </QueryClientProvider>
        </CsrfBootstrapper>
      </ApiConfigurer>
    </AuthProvider>
  </StrictMode>
);
