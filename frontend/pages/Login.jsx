import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import HakikiLogo from '../components/HakikiLogo';

/**
 * Login.jsx — Phase 2 update.
 *
 * Modes:
 *   'login'   — standard login form
 *   'signup'  — create account form
 *   'forgot'  — forgot password form (sends reset email)
 *   'resend'  — resend verification email form
 *   'pending' — shown after signup: "check your email"
 *   'sent'    — shown after forgot/resend request: "email sent"
 */
export default function Login() {
  const [searchParams]    = useSearchParams();
  const [mode, setMode]   = useState(
    searchParams.get('resend') === '1' ? 'resend' : 'login'
  );
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [sentMode, setSentMode] = useState(''); // 'forgot' | 'resend' — to show correct expiry
  const [sentTo,   setSentTo]   = useState('');   // email address we just sent to

  const { updateToken } = useAuth();
  const [unverifiedEmail, setUnverifiedEmail] = useState(null);
  const [resendSent, setResendSent] = useState(false);

  async function handleResend() {
    try {
      await api.post('/auth/resend-verification', { email: unverifiedEmail });
      setResendSent(true);
    } catch {
      setResendSent(false);
    }
  } // FIX P1: updateToken stores token in memory
  const navigate  = useNavigate();

  // Reset state when switching modes
  const switchMode = (next) => {
    setMode(next);
    setError('');
    setEmail('');
    setPassword('');
    setConfirm('');
  };

  // ── Submit handler ──────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (mode === 'signup' && password !== confirm) {
      return setError('Passwords do not match.');
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        const { data } = await api.post('/auth/login', { email, password });

        if (data.mfa_required) {
          // Store pre-MFA token and redirect to MFA step
          updateToken(data.token, data.user); // FIX P1
          return navigate('/mfa');
        }

        updateToken(data.token, data.user); // FIX P1

        // Show banner if email not yet verified, but let them in
        if (data.email_verified === false) {
          navigate('/dashboard?unverified=1');
        } else {
          navigate('/dashboard');
        }

      } else if (mode === 'signup') {
        const { data } = await api.post('/auth/signup', { email, password });
        // DocuSign-style: no token issued on signup — account is Pending until activated
        setSentTo(email);
        setMode('pending');

      } else if (mode === 'forgot') {
        await api.post('/auth/forgot-password', { email });
        setSentTo(email);
        setSentMode('forgot');
        setMode('sent');

      } else if (mode === 'resend') {
        await api.post('/auth/resend-verification', { email });
        setSentTo(email);
        setSentMode('resend');
        setMode('sent');
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'EMAIL_NOT_VERIFIED') {
        // DocuSign-style: show dedicated activation screen with resend button
        setUnverifiedEmail(data.email || email);
        setMode('activation_required');
      } else {
        setError(data?.error || 'Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── "Activation required" screen — shown when user tries to login before activating ──
  if (mode === 'activation_required') {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, textAlign: 'center', background: '#fffbeb' }}>
          <div style={s.bigIcon}>✉️</div>
          <h1 style={{ ...s.title, color: '#92400e' }}>Activate your account</h1>
          <p style={s.body}>
            Your account for <strong>{unverifiedEmail}</strong> has not been activated yet.
            Please check your inbox for the activation email we sent when you signed up.
          </p>
          <p style={{ ...s.body, fontSize: '0.85rem', color: '#6b7280' }}>
            Don't forget to check your spam or junk folder.
            The activation link expires in <strong>24 hours</strong>.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem' }}>
            {!resendSent ? (
              <button
                onClick={async () => {
                  try {
                    await api.post('/auth/resend-verification', { email: unverifiedEmail });
                    setResendSent(true);
                  } catch {
                    setResendSent(false);
                  }
                }}
                style={s.btnPrimary}
              >
                Resend activation email
              </button>
            ) : (
              <div style={{ padding: '0.75rem', background: '#f0fdf4', borderRadius: 8, color: '#15803d', fontSize: '0.9rem', fontWeight: 600 }}>
                ✅ Activation email sent! Check your inbox.
              </div>
            )}
            <button onClick={() => { setMode('login'); setResendSent(false); setUnverifiedEmail(null); }} style={s.btnSecondary}>
              Back to login
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── "Check your email" screen — shown after signup ──────────────────────────
  if (mode === 'pending') {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>📬</div>
          <h1 style={{ ...s.title, color: '#111827', fontSize: '1.4rem' }}>Check your email</h1>
          <p style={{ ...s.body, marginBottom: '0.5rem' }}>
            We sent an activation link to
          </p>
          <p style={{ fontWeight: 700, color: '#1a56b0', fontSize: '1rem', marginBottom: '1.5rem' }}>
            {sentTo}
          </p>
          <p style={{ ...s.body, fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.5rem' }}>
            Click the link in the email to activate your account.
            The link expires in <strong>24 hours</strong>.
          </p>
          <p style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: '1.5rem' }}>
            Don't see it? Check your spam or junk folder.
          </p>
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '1.25rem' }}>
            <p style={{ fontSize: '0.875rem', color: '#6b7280', marginBottom: '0.75rem' }}>
              Didn't receive the email?
            </p>
            <button onClick={() => switchMode('resend')} style={{ ...s.btnSecondary, width: '100%' }}>
              Resend activation email
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── "Email sent" screen — shown after forgot-password or resend-verification ──
  if (mode === 'sent') {
    const isForgot = !sentTo || mode === 'sent';
    return (
      <div style={s.page}>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={s.bigIcon}>✉️</div>
          <h1 style={s.title}>Email sent</h1>
          <p style={s.body}>
            If <strong>{sentTo}</strong> has an account, we've sent an email
            with further instructions. Check your spam folder if it doesn't arrive.
          </p>
          <p style={{ ...s.body, fontSize: '0.85rem', color: '#6b7280' }}>
            The link expires in {sentMode === 'forgot' ? '1 hour' : '24 hours'}.
          </p>
          <button onClick={() => switchMode('login')} style={{ ...s.btnPrimary, marginTop: '1rem' }}>
            Back to login
          </button>
        </div>
      </div>
    );
  }

  // ── Title / subtitle per mode ───────────────────────────────────────────────
  const titles = {
    login:  { h: 'Welcome back',         sub: 'Sign in to your account'            },
    signup: { h: 'Create your account',  sub: 'Start signing documents for free'   },
    forgot: { h: 'Forgot your password', sub: 'Enter your email to get a reset link' },
    resend: { h: 'Resend verification',  sub: 'We\'ll send you a new link'          },
  };
  const { h, sub } = titles[mode];

  return (
    <div style={s.page}>
      <div style={s.card}>

        {/* Header */}
        <div style={s.header}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
            <div style={{ filter: 'drop-shadow(0 4px 16px rgba(26,86,176,0.35))' }}>
              <HakikiLogo size={64} />
            </div>
          </div>
          <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', marginBottom: 2 }}>HakikiSign</div>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#1a56b0', letterSpacing: '0.15em', marginBottom: '0.75rem' }}>AFRICA</div>
          <h1 style={s.title}>{h}</h1>
          <p style={s.subtitle}>{sub}</p>
        </div>

        {/* Error banner */}
        {error && <div style={s.errorBox}>{error}</div>}
        {unverifiedEmail && !resendSent && (
          <div style={{ textAlign: 'center', marginTop: '0.5rem' }}>
            <button
              onClick={handleResend}
              style={{ background: 'none', border: 'none', color: '#4F46E5', cursor: 'pointer', textDecoration: 'underline', fontSize: '0.9rem' }}
            >
              Resend verification email
            </button>
          </div>
        )}
        {resendSent && (
          <div style={{ textAlign: 'center', marginTop: '0.5rem', color: 'green', fontSize: '0.9rem' }}>
            ✅ Verification email sent! Check your inbox.
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>

          {/* Email — shown in all modes */}
          <div style={s.group}>
            <label style={s.label}>Email address</label>
            <input
              style={s.input}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          {/* Password — login + signup only */}
          {(mode === 'login' || mode === 'signup') && (
            <div style={s.group}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <label style={s.label}>Password</label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    style={s.forgotLink}
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                style={s.input}
                type="password"
                placeholder={mode === 'signup' ? 'At least 10 characters' : '••••••••'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
          )}

          {/* Confirm password — signup only */}
          {mode === 'signup' && (
            <div style={s.group}>
              <label style={s.label}>Confirm password</label>
              <input
                style={{
                  ...s.input,
                  borderColor: confirm && confirm !== password ? '#fca5a5' : '#d1d5db',
                }}
                type="password"
                placeholder="Repeat your password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
              />
              {confirm && confirm !== password && (
                <p style={{ fontSize: 12, color: '#ef4444', marginTop: 3 }}>Passwords do not match.</p>
              )}
            </div>
          )}

          {/* Submit button */}
          <button type="submit" disabled={loading} style={{ ...s.btnPrimary, width: '100%', marginTop: '0.5rem' }}>
            {loading ? '...' : {
              login:  'Log in',
              signup: 'Create account',
              forgot: 'Send reset link',
              resend: 'Resend verification',
            }[mode]}
          </button>
        </form>

        {/* Footer links */}
        <div style={s.footer}>
          {(mode === 'login' || mode === 'signup') && (
            <p style={s.toggle}>
              {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
              <button
                onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
                style={s.toggleBtn}
              >
                {mode === 'login' ? 'Sign up' : 'Log in'}
              </button>
            </p>
          )}

          {mode === 'login' && (
            <p style={s.toggle}>
              Didn't get a verification email?{' '}
              <button onClick={() => switchMode('resend')} style={s.toggleBtn}>
                Resend it
              </button>
            </p>
          )}

          {(mode === 'forgot' || mode === 'resend') && (
            <p style={s.toggle}>
              <button onClick={() => switchMode('login')} style={s.toggleBtn}>
                ← Back to login
              </button>
            </p>
          )}
        </div>

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
    background: 'linear-gradient(145deg, #0f2461 0%, #1e3a7b 50%, #1a56b0 100%)',
    padding: '1rem',
  },
  card: {
    background: 'white',
    borderRadius: 16,
    padding: '2.5rem',
    width: '100%',
    maxWidth: 420,
    boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
  },
  header: { textAlign: 'center', marginBottom: '2rem' },
  bigIcon: { fontSize: '3rem', marginBottom: '0.75rem' },
  logo: { fontSize: '3rem', display: 'block', marginBottom: '0.5rem' },
  title: { fontSize: '1.5rem', fontWeight: 800, color: '#1a1a2e', marginBottom: '0.25rem' },
  subtitle: { color: '#6b7280', fontSize: '0.95rem' },
  body: { color: '#374151', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: '0.75rem' },
  errorBox: {
    background: '#fee2e2', color: '#b91c1c',
    padding: '0.75rem', borderRadius: 8,
    marginBottom: '1rem', fontSize: '0.875rem',
  },
  group: { display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1.2rem' },
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
  forgotLink: {
    background: 'none', border: 'none',
    color: '#1a56b0', fontSize: '0.8rem',
    fontWeight: 600, cursor: 'pointer',
  },
  btnPrimary: {
    padding: '0.75rem',
    background: '#1a56b0',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontSize: '1rem',
    fontWeight: 700,
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '0.75rem',
    background: 'white',
    color: '#374151',
    border: '1.5px solid #d1d5db',
    borderRadius: 8,
    fontSize: '0.95rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  footer: { marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  toggle: { textAlign: 'center', fontSize: '0.9rem', color: '#6b7280', margin: 0 },
  toggleBtn: {
    background: 'none', border: 'none',
    color: '#1a56b0', fontWeight: 700,
    cursor: 'pointer', fontSize: '0.9rem',
  },
};