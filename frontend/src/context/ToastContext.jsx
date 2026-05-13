/**
 * ToastContext.jsx — HakikiSign Global Notification System
 *
 * Provides a centralized, queue-based toast system that:
 *   - Supports success, error, warning, info types
 *   - Auto-dismisses after configurable duration
 *   - Shows retry actions for recoverable errors
 *   - Deduplicates identical messages within 500ms (prevents double-toast)
 *   - Pauses auto-dismiss on hover (mobile: touch)
 *   - Limits to 4 visible toasts (oldest dismissed first)
 *   - Accessible: uses role="alert" for screen readers
 *
 * USAGE:
 *   const { toast } = useToast();
 *   toast.success('Document sent!');
 *   toast.error('Failed to upload', { retry: () => handleUpload() });
 *   toast.info('Loading document...');
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
} from 'react';

const ToastContext = createContext(null);

const MAX_TOASTS = 4;
const DEFAULT_DURATION = {
  success: 4000,
  error: 7000,
  warning: 5000,
  info: 3500,
};

const COLORS = {
  success: { bg: '#ECFDF5', border: '#6EE7B7', icon: '#10B981', text: '#065F46' },
  error:   { bg: '#FEF2F2', border: '#FECACA', icon: '#EF4444', text: '#991B1B' },
  warning: { bg: '#FFFBEB', border: '#FDE68A', icon: '#F59E0B', text: '#92400E' },
  info:    { bg: '#EFF6FF', border: '#BFDBFE', icon: '#3B82F6', text: '#1E40AF' },
};

const ICONS = {
  success: (color) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  ),
  error: (color) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  ),
  warning: (color) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
    </svg>
  ),
  info: (color) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>
  ),
};

let _toastId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const recentMessages = useRef(new Map()); // deduplication
  const timers = useRef(new Map()); // auto-dismiss timers

  const dismiss = useCallback((id) => {
    // Fade out then remove
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      const timer = timers.current.get(id);
      if (timer) { clearTimeout(timer); timers.current.delete(id); }
    }, 300); // matches CSS transition
  }, []);

  const addToast = useCallback((type, message, options = {}) => {
    // Deduplicate: don't show the same message twice within 500ms
    const key = `${type}:${message}`;
    if (recentMessages.current.has(key)) return;
    recentMessages.current.set(key, true);
    setTimeout(() => recentMessages.current.delete(key), 500);

    const id = ++_toastId;
    const duration = options.duration ?? DEFAULT_DURATION[type];

    const newToast = { id, type, message, retry: options.retry, action: options.action };

    setToasts(prev => {
      // Evict oldest if at max capacity
      const next = prev.length >= MAX_TOASTS ? prev.slice(1) : prev;
      return [...next, newToast];
    });

    // Auto-dismiss
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, timer);
    }

    return id;
  }, [dismiss]);

  // Cleanup on unmount
  useEffect(() => {
    const timerMap = timers.current;
    return () => timerMap.forEach(t => clearTimeout(t));
  }, []);

  const toast = {
    success: (msg, opts) => addToast('success', msg, opts),
    error:   (msg, opts) => addToast('error',   msg, opts),
    warning: (msg, opts) => addToast('warning', msg, opts),
    info:    (msg, opts) => addToast('info',     msg, opts),
    dismiss,
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} timers={timers} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

// ── Toast Container ──────────────────────────────────────────────────────────
function ToastContainer({ toasts, onDismiss, timers }) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.25rem',
        right: '1.25rem',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
        maxWidth: 'calc(100vw - 2.5rem)',
        width: 380,
        pointerEvents: 'none',
      }}
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map(t => (
        <Toast
          key={t.id}
          toast={t}
          onDismiss={onDismiss}
          timers={timers}
        />
      ))}
    </div>
  );
}

// ── Individual Toast ─────────────────────────────────────────────────────────
function Toast({ toast: t, onDismiss, timers }) {
  const c = COLORS[t.type];
  const pauseTimerRef = useRef(null);

  // Pause auto-dismiss on hover
  const handleMouseEnter = () => {
    const timer = timers.current.get(t.id);
    if (timer) { clearTimeout(timer); timers.current.delete(t.id); }
  };

  const handleMouseLeave = () => {
    // Resume with a shorter duration after hover
    const timer = setTimeout(() => onDismiss(t.id), 2000);
    timers.current.set(t.id, timer);
  };

  return (
    <div
      role="alert"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 12,
        padding: '0.85rem 1rem',
        boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.7rem',
        pointerEvents: 'auto',
        opacity: t.exiting ? 0 : 1,
        transform: t.exiting ? 'translateX(20px)' : 'translateX(0)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
        animation: t.exiting ? undefined : 'toastIn 0.25s ease',
      }}
    >
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Icon */}
      <div style={{ flexShrink: 0, marginTop: 1 }}>
        {ICONS[t.type](c.icon)}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.875rem', fontWeight: 500, color: c.text, lineHeight: 1.4 }}>
          {t.message}
        </div>
        {/* Retry action */}
        {t.retry && (
          <button
            onClick={() => { t.retry(); onDismiss(t.id); }}
            style={{
              marginTop: '0.4rem',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: c.icon,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Try again
          </button>
        )}
        {/* Custom action */}
        {t.action && (
          <button
            onClick={() => { t.action.fn(); onDismiss(t.id); }}
            style={{
              marginTop: '0.4rem',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: c.icon,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {t.action.label}
          </button>
        )}
      </div>

      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss notification"
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: c.text,
          opacity: 0.5,
          padding: '0 0 0 0.25rem',
          lineHeight: 1,
          fontSize: '1rem',
        }}
      >
        ×
      </button>
    </div>
  );
}
