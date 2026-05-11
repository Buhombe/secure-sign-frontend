/**
 * AuthContext.jsx — FIX P1
 *
 * Access token is stored in React state (memory) ONLY — never localStorage.
 * On app start we silently call /auth/refresh (HttpOnly cookie) to restore session.
 * XSS cannot steal the access token from memory.
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [accessToken, setAccessToken] = useState(null);  // ← memory only, no localStorage
  const [user, setUser]               = useState(null);
  const [loading, setLoading]         = useState(true);  // true while we attempt silent refresh

  // Stable ref so api.js interceptor can always get the latest token
  const tokenRef = useRef(null);
  tokenRef.current = accessToken;

  // ── Silent refresh on mount ───────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.post(
          `${API}/auth/refresh`,
          {},
          { withCredentials: true }
        );
        setAccessToken(data.token);
        setUser(data.user);
      } catch {
        // No valid refresh token cookie — user must log in
        setAccessToken(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Login ─────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    const { data } = await axios.post(
      `${API}/auth/login`,
      { email, password },
      { withCredentials: true }   // receives HttpOnly refresh cookie
    );
    setAccessToken(data.token);   // access token lives in memory
    setUser(data.user);
    return data;
  }, []);

  // ── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try {
      await axios.post(`${API}/auth/logout`, {}, { withCredentials: true });
    } catch { /* best-effort */ }
    setAccessToken(null);
    setUser(null);
  }, []);

  // ── Token getter for api.js interceptor ───────────────────────────────────
  const getToken = useCallback(() => tokenRef.current, []);

  // ── Token setter used by api.js after silent refresh in interceptor ───────
  const updateToken = useCallback((token, updatedUser) => {
    setAccessToken(token);
    if (updatedUser) setUser(updatedUser);
  }, []);

  return (
    <AuthContext.Provider value={{ accessToken, user, loading, login, logout, getToken, updateToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
