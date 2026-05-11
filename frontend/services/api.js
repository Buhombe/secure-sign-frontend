/**
 * api.js — FIX P1
 *
 * Access token is NEVER stored in localStorage.
 * It is retrieved from AuthContext (memory) on every request.
 *
 * Silent refresh flow:
 *   1. Request fails with 401
 *   2. We call /auth/refresh (HttpOnly cookie is sent automatically)
 *   3. New access token stored in memory via AuthContext.updateToken()
 *   4. Original request retried with new token
 */
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// AuthContext injects itself here at app startup (see main.jsx)
// This pattern avoids circular imports between api.js and AuthContext.jsx
let _getToken  = () => null;
let _updateToken = () => {};
let _onLogout  = () => {};

export function configureApiAuth({ getToken, updateToken, onLogout }) {
  _getToken    = getToken;
  _updateToken = updateToken;
  _onLogout    = onLogout;
}

const api = axios.create({
  baseURL:         API_BASE,
  withCredentials: true,   // always send HttpOnly cookie
});

// ── Request interceptor — attach access token + CSRF token ──────────────────
api.interceptors.request.use((config) => {
  // FIX P1: access token from memory
  const token = _getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;

  // FIX P2: read CSRF token from cookie and add as header
  // Server validates that cookie value === X-CSRF-Token header (Double Submit)
  const csrfCookie = document.cookie
    .split('; ')
    .find(row => row.startsWith('csrf_token='));
  if (csrfCookie) {
    config.headers['X-CSRF-Token'] = csrfCookie.split('=')[1];
  }

  return config;
});

// ── Response interceptor — silent refresh on 401 ─────────────────────────────
let isRefreshing = false;
let waitingQueue = [];  // requests waiting for the refresh to complete

function processQueue(error, token = null) {
  waitingQueue.forEach(({ resolve, reject }) =>
    error ? reject(error) : resolve(token)
  );
  waitingQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;

      if (isRefreshing) {
        // Queue the request until refresh completes
        return new Promise((resolve, reject) => {
          waitingQueue.push({ resolve, reject });
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      isRefreshing = true;

      try {
        const { data } = await axios.post(
          `${API_BASE}/auth/refresh`,
          {},
          { withCredentials: true }
        );
        const newToken = data.token;
        _updateToken(newToken, data.user);         // store in memory
        processQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        _onLogout();                               // clear state, redirect to /login
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
