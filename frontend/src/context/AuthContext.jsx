/**
 * AuthContext.jsx — HakikiSign Authentication State
 *
 * SECURITY ARCHITECTURE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Access token storage: IN-MEMORY ONLY (React state)
 * ────────────────────────────────────────────────────
 * The original code stored the access token in localStorage, which is
 * accessible to any JavaScript running on the page (XSS attack vector).
 * We now store it exclusively in React state (memory).
 *
 * On page refresh, the access token is lost from memory. This is intentional:
 * the silent refresh flow (see api.js) will automatically call /auth/refresh
 * on the first 401 response, obtaining a new access token from the HttpOnly
 * refresh-token cookie without user interaction.
 *
 * User profile: localStorage (safe for non-sensitive data)
 * ──────────────────────────────────────────────────────────
 * The user object (id, email, mfa_enabled) is not sensitive — it contains
 * no credentials and cannot be used to authenticate. Storing it in
 * localStorage allows the UI to render the correct state on page refresh
 * without an extra API call. We re-validate from the server lazily.
 *
 * CSRF token: NOT stored here
 * ────────────────────────────
 * The CSRF token lives in a signed cookie set by the server. The Axios
 * interceptor in api.js reads it from document.cookie on each request.
 * AuthContext does NOT need to track it — the cookie is authoritative.
 *
 * However, when /auth/refresh returns a new csrfToken, we update the
 * in-memory reference in api.js so that the immediately-retried request
 * uses the fresh token without needing to re-read the cookie. (The cookie
 * is also updated in the Set-Cookie header of the refresh response.)
 *
 * MULTI-TAB BEHAVIOR
 * ══════════════════════════════════════════════════════════════════════════════
 * When one tab logs out, it calls /auth/logout (server clears refresh token
 * + CSRF cookie). Other tabs that subsequently make requests will get 401
 * (refresh token gone) → their api.js interceptor calls onLogout() → they
 * navigate to /login. This is safe and correct.
 *
 * The StorageEvent listener detects when localStorage is cleared in another
 * tab (our logout removes 'user') and immediately clears local state.
 * This is UX-only (the tab was already auth-blocked at the API level).
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // ── Access token: in-memory ONLY ────────────────────────────────────────
  // useState(null) — never initialized from localStorage.
  // On refresh, the first 401 triggers silent re-auth via the refresh cookie.
  const accessTokenRef = useRef(null);
  const [, forceRender] = useState(0);  // used only to trigger re-renders when needed

  // ── User profile: localStorage (non-sensitive) ───────────────────────────
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('hakikisign_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  // ── CSRF bootstrap status ────────────────────────────────────────────────
  // Tracks whether the initial CSRF token has been fetched this session.
  // On page refresh, the cookie may still be present (if within 4h), but
  // we bootstrap anyway to ensure the signed cookie is fresh and valid.
  const csrfBootstrapped = useRef(false);

  // ── getToken: called by api.js interceptor on every request ─────────────
  const getToken = useCallback(() => accessTokenRef.current, []);

  // ── updateToken: called by api.js after silent refresh ──────────────────
  const updateToken = useCallback((token, updatedUser) => {
    if (token) {
      accessTokenRef.current = token;
    }
    if (updatedUser) {
      const userToStore = {
        id:           updatedUser.id,
        email:        updatedUser.email,
        mfa_enabled:  updatedUser.mfa_enabled,
        // Intentionally omit: any sensitive fields
      };
      localStorage.setItem('hakikisign_user', JSON.stringify(userToStore));
      setUser(userToStore);
    }
  }, []);

  // ── updateUser: partial user state update (profile changes, MFA toggle) ──
  const updateUser = useCallback((partial) => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      localStorage.setItem('hakikisign_user', JSON.stringify(next));
      return next;
    });
  }, []);

  // ── logout: clears all auth state ────────────────────────────────────────
  // Calls /auth/logout to revoke refresh token and clear CSRF cookie server-side.
  // Clears in-memory token and localStorage user profile.
  const logout = useCallback(async () => {
    try {
      // Fire-and-forget: even if this fails, we clear local state.
      // Server-side: refresh token revoked, CSRF cookie cleared.
      await axios.post(
        `${API}/auth/logout`,
        {},
        {
          withCredentials: true,
          headers: {
            // Read current CSRF token from cookie for the logout request itself.
            // After this call the CSRF cookie will be cleared by the server.
            'X-CSRF-Token': getCsrfCookieValue(),
          },
        }
      );
    } catch {
      // Ignore logout API failures — we always clear local state.
    } finally {
      accessTokenRef.current = null;
      csrfBootstrapped.current = false;
      localStorage.removeItem('hakikisign_user');
      setUser(null);
    }
  }, []);

  // ── Multi-tab logout detection ───────────────────────────────────────────
  // If another tab removes 'hakikisign_user' from localStorage (via logout),
  // this event fires and we immediately clear our state too.
  // The user will need to log in again — correct behavior.
  useEffect(() => {
    function handleStorageEvent(event) {
      if (event.key === 'hakikisign_user' && event.newValue === null) {
        // Another tab logged out. Clear our state.
        accessTokenRef.current = null;
        csrfBootstrapped.current = false;
        setUser(null);
      }
    }

    window.addEventListener('storage', handleStorageEvent);
    return () => window.removeEventListener('storage', handleStorageEvent);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      getToken,
      updateToken,
      updateUser,
      logout,
      csrfBootstrapped,
      isAuthenticated: !!user,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

// ── Utility: read CSRF cookie value ─────────────────────────────────────────
// Used internally for the logout call where we need the token before the
// Axios interceptor handles it. Exported so api.js can also use it.
export function getCsrfCookieValue() {
  const match = document.cookie
    .split('; ')
    .find(row => row.startsWith('csrf_token='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}
