import { createContext, useContext, useState, useEffect } from 'react';
import api, { setAccessToken, clearAccessToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount: if there's a saved user, silently call /auth/refresh to get a
  // fresh access token using the HttpOnly cookie. This replaces the old pattern
  // of reading the token from localStorage (which is XSS-vulnerable).
  // If the cookie has expired or is absent, the refresh fails and we clear state.
  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (!savedUser) {
      setLoading(false);
      return;
    }

    api.post('/auth/refresh')
      .then(({ data }) => {
        setAccessToken(data.token);
        setUser(JSON.parse(savedUser));
      })
      .catch(() => {
        // Refresh failed — session expired or cookie missing. Clear saved user.
        localStorage.removeItem('user');
        clearAccessToken();
      })
      .finally(() => setLoading(false));
  }, []);

  // Token goes to memory only. User data (non-sensitive) goes to localStorage
  // so the UI can show the user's name/email on the next page load while the
  // silent refresh is in progress.
  const login = (userData, token) => {
    setAccessToken(token);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
  };

  const logout = () => {
    clearAccessToken();
    localStorage.removeItem('user');
    setUser(null);
  };

  const updateUser = (updates) => {
    const updated = { ...user, ...updates };
    localStorage.setItem('user', JSON.stringify(updated));
    setUser(updated);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
