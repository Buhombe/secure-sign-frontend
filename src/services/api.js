import axios from 'axios';

// ── In-memory token store ─────────────────────────────────────────────────────
// Access token lives ONLY in module memory — never written to localStorage.
// This eliminates the XSS-to-token-theft attack vector entirely.
// Persistence across page reloads is handled by the HttpOnly refresh cookie
// (silently refreshed in AuthContext on mount).
let _token = null;

export function setAccessToken(token) { _token = token; }
export function clearAccessToken()    { _token = null;  }

// ─────────────────────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  withCredentials: true,
});

// Attach token from memory — never from localStorage
api.interceptors.request.use((config) => {
  if (_token) config.headers.Authorization = `Bearer ${_token}`;
  return config;
});

let isRefreshing = false;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;

      if (!isRefreshing) {
        isRefreshing = true;
        try {
          const { data } = await axios.post(
            `${import.meta.env.VITE_API_URL || 'http://localhost:5000/api'}/auth/refresh`,
            {},
            { withCredentials: true }
          );
          // Store new token in memory only — no localStorage
          setAccessToken(data.token);
          isRefreshing = false;
          original.headers.Authorization = `Bearer ${data.token}`;
          return api(original);
        } catch (refreshErr) {
          isRefreshing = false;
          clearAccessToken();
          localStorage.removeItem('user');
          window.location.href = '/login';
          return Promise.reject(refreshErr);
        }
      }
    }

    return Promise.reject(error);
  }
);

export default api;
