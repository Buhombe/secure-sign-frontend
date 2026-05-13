/**
 * App.jsx — HakikiSign Router
 *
 * PERFORMANCE OPTIMIZATIONS:
 *   1. Route-level code splitting via React.lazy — each page is a separate
 *      chunk loaded on demand. Initial bundle contains only the entry point.
 *      SignDocument (~48KB) and PlaceFields (~21KB) are the heaviest pages;
 *      lazy-loading them saves ~70KB from the initial parse.
 *
 *   2. Suspense fallback shows a lightweight spinner (no layout shift).
 *
 *   3. RouteErrorBoundary per route — an error in one route doesn't crash
 *      the entire app. Resets when navigating to a different route.
 *
 * REMOVED: The duplicate CSRF fetch in useEffect — this is now handled
 *   centrally by CsrfBootstrapper in main.jsx. One fetch, not two.
 */

import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import SplashScreen from './components/SplashScreen';
import { RouteErrorBoundary } from './components/ErrorBoundary';

// ── Eagerly-loaded (small, needed immediately) ──────────────────────────────
import Login from './pages/Login';

// ── Lazily-loaded (loaded only when route is visited) ──────────────────────
const Dashboard    = lazy(() => import('./pages/Dashboard'));
const Manage       = lazy(() => import('./pages/Manage'));
const Upload       = lazy(() => import('./pages/Upload'));
const ViewDocument = lazy(() => import('./pages/ViewDocument'));
const SignDocument  = lazy(() => import('./pages/SignDocument'));
const PlaceFields   = lazy(() => import('./pages/PlaceFields'));
const AuditLog      = lazy(() => import('./pages/AuditLog'));
const Settings      = lazy(() => import('./pages/Settings'));
const VerifyEmail   = lazy(() => import('./pages/VerifyEmail'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Pricing       = lazy(() => import('./pages/Pricing'));

// ── Lightweight Suspense fallback ──────────────────────────────────────────
function PageLoader() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
    }}>
      <svg
        width="32" height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#2563EB"
        strokeWidth="2.5"
        style={{ animation: 'spin 0.9s linear infinite' }}
      >
        <path strokeLinecap="round" d="M12 2a10 10 0 1 0 10 10"/>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </svg>
    </div>
  );
}

// ── Route wrapper: adds per-route ErrorBoundary with key-based auto-reset ──
function GuardedRoute({ children }) {
  const location = useLocation();
  return (
    <RouteErrorBoundary routeKey={location.pathname}>
      {children}
    </RouteErrorBoundary>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login"          element={<GuardedRoute><Login /></GuardedRoute>} />
        <Route path="/pricing"        element={<GuardedRoute><Pricing /></GuardedRoute>} />
        <Route path="/sign/:id"       element={<GuardedRoute><SignDocument /></GuardedRoute>} />
        <Route path="/verify-email"   element={<GuardedRoute><VerifyEmail /></GuardedRoute>} />
        <Route path="/reset-password" element={<GuardedRoute><ResetPassword /></GuardedRoute>} />

        <Route path="/dashboard"      element={<ProtectedRoute><GuardedRoute><Dashboard /></GuardedRoute></ProtectedRoute>} />
        <Route path="/manage"         element={<ProtectedRoute><GuardedRoute><Manage /></GuardedRoute></ProtectedRoute>} />
        <Route path="/upload"         element={<ProtectedRoute><GuardedRoute><Upload /></GuardedRoute></ProtectedRoute>} />
        <Route path="/place-fields/:id" element={<ProtectedRoute><GuardedRoute><PlaceFields /></GuardedRoute></ProtectedRoute>} />
        <Route path="/document/:id"   element={<ProtectedRoute><GuardedRoute><ViewDocument /></GuardedRoute></ProtectedRoute>} />
        <Route path="/audit"          element={<ProtectedRoute><GuardedRoute><AuditLog /></GuardedRoute></ProtectedRoute>} />
        <Route path="/settings"       element={<ProtectedRoute><GuardedRoute><Settings /></GuardedRoute></ProtectedRoute>} />
        <Route path="/"               element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false);

  return (
    <>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </>
  );
}
