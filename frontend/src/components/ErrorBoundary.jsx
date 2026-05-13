/**
 * ErrorBoundary.jsx — HakikiSign Global Error Boundary
 *
 * Catches unhandled React rendering errors and displays a graceful fallback
 * instead of crashing the entire app. Provides a retry mechanism that
 * resets the boundary state without requiring a full page reload.
 *
 * USAGE:
 *   <ErrorBoundary>              — global boundary (catches everything)
 *   <ErrorBoundary fallback={...}> — custom fallback UI
 *   <ErrorBoundary resetKeys={[id]}> — auto-reset when key changes
 *
 * Note: Error boundaries must be class components (React limitation).
 * Async errors (rejected promises) are NOT caught by error boundaries —
 * those are handled by React Query's error state.
 */

import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // In production, send to error tracking service
    console.error('[ErrorBoundary] Unhandled render error:', error, info);
  }

  componentDidUpdate(prevProps) {
    // Auto-reset when resetKeys change (e.g., navigation to a new route/id)
    if (
      this.state.hasError &&
      this.props.resetKeys &&
      prevProps.resetKeys &&
      this.props.resetKeys.some((k, i) => k !== prevProps.resetKeys[i])
    ) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }
      return (
        <DefaultErrorFallback
          error={this.state.error}
          onReset={this.handleReset}
          level={this.props.level || 'page'}
        />
      );
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({ error, onReset, level }) {
  const isPage = level === 'page';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: isPage ? '4rem 2rem' : '2rem',
      textAlign: 'center',
      minHeight: isPage ? '60vh' : undefined,
    }}>
      <div style={{
        width: 56,
        height: 56,
        borderRadius: 16,
        background: '#FEF2F2',
        border: '1px solid #FECACA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '1.25rem',
      }}>
        <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#EF4444" strokeWidth="1.8">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
      </div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0F172A', marginBottom: '0.5rem' }}>
        Something went wrong
      </h2>
      <p style={{ fontSize: '0.875rem', color: '#64748B', maxWidth: 320, marginBottom: '1.5rem', lineHeight: 1.5 }}>
        An unexpected error occurred. Your data is safe — this is a display issue only.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <button
          onClick={onReset}
          style={{
            padding: '0.5rem 1.25rem',
            background: '#2563EB',
            color: 'white',
            border: 'none',
            borderRadius: 9,
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.5rem 1.25rem',
            background: 'white',
            color: '#374151',
            border: '1px solid #E2E8F0',
            borderRadius: 9,
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Reload page
        </button>
      </div>
      {import.meta.env.DEV && error && (
        <details style={{ marginTop: '1.5rem', textAlign: 'left', maxWidth: 500 }}>
          <summary style={{ fontSize: '0.78rem', color: '#94A3B8', cursor: 'pointer' }}>
            Error details (dev only)
          </summary>
          <pre style={{ fontSize: '0.72rem', color: '#EF4444', marginTop: '0.5rem', overflow: 'auto', maxHeight: 200 }}>
            {error?.toString()}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * RouteErrorBoundary — wraps individual routes for isolated error containment.
 * Resets when the URL changes (so navigating away and back starts fresh).
 */
export function RouteErrorBoundary({ children, routeKey }) {
  return (
    <ErrorBoundary resetKeys={[routeKey]} level="page">
      {children}
    </ErrorBoundary>
  );
}
