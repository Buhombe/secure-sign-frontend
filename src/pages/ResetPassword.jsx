import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * ResetPassword — form to set a new password after clicking the reset link.
 *
 * URL format: /reset-password?token=<64-char-hex>
 *
 * The token is read from the query string on mount and sent in the POST body
 * to /api/auth/reset-password. It is NOT kept in state beyond the submit call.
 */
export default function ResetPassword() {
  const navigate    = useNavigate();
  const params      = new URLSearchParams(window.location.search);
  const resetToken  = params.get('token');

  const [password,  setPassword]  = useState('');
  const [confirm,   setConfirm]   = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [success,   setSuccess]   = useState(false);

  // Password strength indicator
  const checks = {
    length:    password.length >= 10,
    upper:     /[A-Z]/.test(password),
    lower:     /[a-z]/.test(password),
    number:    /\d/.test(password),
    special:   /[^A-Za-z0-9]/.test(password),
  };
  const strength = Object.values(checks).filter(Boolean).length;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!resetToken) {
      setError('Invalid reset link. Please request a new password reset.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (strength < 5) {
      setError('Password does not meet all requirements.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token: resetToken, password });
      setSuccess(true);
      // Auto-redirect to login after 3 seconds
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'TOKEN_EXPIRED') {
        setError('This reset link has expired. Please request a new one from the login page.');
      } else if (code === 'TOKEN_INVALID') {
        setError('Invalid or already-used reset link. Please request a new one.');
      } else {
        setError(err.response?.data?.error || 'Could not reset password. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (!resetToken) {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={s.icon}>⚠️</div>
          <h1 style={{ ...s.title, color: '#b91c1c' }}>Invalid reset link</h1>
          <p style={s.body}>This link is missing a reset token. Please use the link from your email or request a new one.</p>
          <button onClick={() => navigate('/login')} style={s.btnPrimary}>Back to login</button>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, background: '#f0fdf4', textAlign: 'center' }}>
          <div style={s.icon}>✅</div>
          <h1 style={{ ...s.title, color: '#15803d' }}>Password updated!</h1>
          <p style={s.body}>Your password has been changed. All existing sessions have been signed out. Redirecting to login...</p>
          <button onClick={() => navigate('/login')} style={s.btnPrimary}>Go to login →</button>
        </div>
      </div>
    );
  }

  const strengthLabel = ['', 'Weak', 'Weak', 'Fair', 'Good', 'Strong'][strength];
  const strengthColor = ['', '#ef4444', '#ef4444', '#f59e0b', '#3b82f6', '#16a34a'][strength];

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
          <div style={s.icon}>🔑</div>
          <h1 style={s.title}>Set a new password</h1>
          <p style={{ fontSize: '0.9rem', color: '#6b7280' }}>
            Choose a strong password for your SecureSign account.
          </p>
        </div>

        {error && <div style={s.errorBox}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={s.group}>
            <label style={s.label}>New password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 10 characters"
              style={s.input}
              required
              autoFocus
            />
            {password && (
              <div style={{ marginTop: 6 }}>
                {/* Strength bar */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex: 1, height: 4, borderRadius: 2,
                      background: i <= strength ? strengthColor : '#e5e7eb',
                      transition: 'background 0.2s',
                    }} />
                  ))}
                </div>
                <span style={{ fontSize: 12, color: strengthColor, fontWeight: 600 }}>{strengthLabel}</span>
              </div>
            )}
          </div>

          {/* Requirements checklist */}
          {password && (
            <div style={s.checklist}>
              {[
                ['length',  'At least 10 characters'],
                ['upper',   'Uppercase letter'],
                ['lower',   'Lowercase letter'],
                ['number',  'Number'],
                ['special', 'Special character'],
              ].map(([key, label]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ color: checks[key] ? '#16a34a' : '#d1d5db', fontSize: 14 }}>
                    {checks[key] ? '✓' : '○'}
                  </span>
                  <span style={{ color: checks[key] ? '#15803d' : '#9ca3af' }}>{label}</span>
                </div>
              ))}
            </div>
          )}

          <div style={s.group}>
            <label style={s.label}>Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="Repeat your new password"
              style={{
                ...s.input,
                borderColor: confirm && confirm !== password ? '#fca5a5' : '#d1d5db',
              }}
              required
            />
            {confirm && confirm !== password && (
              <p style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>Passwords do not match.</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || strength < 5 || password !== confirm}
            style={{
              ...s.btnPrimary,
              width: '100%',
              opacity: (loading || strength < 5 || password !== confirm) ? 0.6 : 1,
              cursor:  (loading || strength < 5 || password !== confirm) ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Updating...' : 'Update password →'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.875rem', color: '#6b7280' }}>
          <button onClick={() => navigate('/login')} style={s.link}>
            Back to login
          </button>
        </p>
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f1f5f9',
    padding: '1rem',
  },
  card: {
    background: 'white',
    borderRadius: 16,
    border: '1px solid #e5e7eb',
    padding: '2rem',
    width: '100%',
    maxWidth: 420,
    boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
  },
  icon: { fontSize: '2.5rem', marginBottom: '0.5rem' },
  title: { fontSize: '1.3rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.25rem' },
  body: { fontSize: '0.9rem', color: '#6b7280', lineHeight: 1.6, marginBottom: '1.5rem' },
  errorBox: {
    background: '#fee2e2', color: '#b91c1c',
    padding: '0.75rem', borderRadius: 8,
    marginBottom: '1rem', fontSize: '0.875rem',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1.1rem' },
  label: { fontSize: '0.875rem', fontWeight: 600, color: '#374151' },
  input: {
    padding: '0.65rem 0.9rem',
    border: '1.5px solid #d1d5db',
    borderRadius: 8,
    fontSize: '0.95rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  checklist: {
    display: 'flex', flexDirection: 'column', gap: 5,
    background: '#f8fafc', borderRadius: 8,
    padding: '0.75rem', marginBottom: '1.1rem',
  },
  btnPrimary: {
    padding: '0.75rem 1.5rem',
    background: '#2563eb',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: '0.95rem',
  },
  link: {
    background: 'none', border: 'none',
    color: '#2563eb', fontWeight: 600,
    fontSize: '0.875rem', cursor: 'pointer',
  },
};
