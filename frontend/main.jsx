/**
 * main.jsx — FIX P1
 * Wires AuthContext into api.js so the interceptor can read/update
 * the in-memory access token without a circular import.
 */
import { StrictMode } from 'react';
import { createRoot }  from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { configureApiAuth } from './services/api.js';

function ApiConfigurer({ children }) {
  const { getToken, updateToken, logout } = useAuth();

  // Wire once on mount — stable callbacks from AuthContext
  configureApiAuth({
    getToken,
    updateToken,
    onLogout: () => {
      logout();
      window.location.href = '/login';
    },
  });

  return children;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <ApiConfigurer>
        <App />
      </ApiConfigurer>
    </AuthProvider>
  </StrictMode>
);
