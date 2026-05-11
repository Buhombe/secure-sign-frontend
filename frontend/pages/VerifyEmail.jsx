import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [status,  setStatus]  = useState('verifying');
  const [message, setMessage] = useState('');
  const [email,   setEmail]   = useState('');
  const [resent,  setResent]  = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token');
    const emailParam = params.get('email');
    if (emailParam) setEmail(decodeURIComponent(emailParam));

    if (!token) {
      setStatus('error');
      setMessage('No activation token found. Please use the link from your email.');
      return;
    }

    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(({ data }) => {
        setStatus('success');
        setMessage(data.message || 'Account activated successfully.');
      })
      .catch((err) => {
        const code = err.response?.data?.code;
        if (code === 'TOKEN_EXPIRED') {
          setStatus('expired');
        } else {
          setStatus('error');
          setMessage(err.response?.data?.error || 'Activation failed. The link may have already been used.');
        }
      });
  }, []);

  const handleResend = async () => {
    if (!email) { navigate('/login?resend=1'); return; }
    setResending(true);
    try {
      await api.post('/auth/resend-verification', { email });
      setResent(true);
    } catch {
      navigate('/login?resend=1');
    } finally {
      setResending(false);
    }
  };

  // ── Success ────────────────────────────────────────────────────────────────
  if (status === 'success') {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={{ ...s.iconWrap, background: '#dcfce7' }}>
            <span style={{ fontSize: 28, lineHeight: 1 }}>✓</span>
          </div>
          <h1 style={{ ...s.title, color: '#15803d' }}>Account activated!</h1>
          <p style={s.body}>
            Your account is now active. You can sign in and start using HakikiSign.
          </p>
          <button onClick={() => navigate('/login')} style={s.btnPrimary}>
            Sign in to your account
          </button>
        </div>
      </div>
    );
  }

  // ── Verifying ──────────────────────────────────────────────────────────────
  if (status === 'verifying') {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⏳</div>
          <p style={{ color: '#6b7280', fontSize: '0.95rem' }}>Activating your account...</p>
        </div>
      </div>
    );
  }

  // ── Expired ────────────────────────────────────────────────────────────────
  if (status === 'expired') {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={{ ...s.iconWrap, background: '#fef3c7' }}>
            <span style={{ fontSize: 28, lineHeight: 1 }}>⌛</span>
          </div>
          <h1 style={{ ...s.title, color: '#92400e' }}>Link expired</h1>
          <p style={s.body}>
            This activation link has expired. Activation links are valid for 24 hours.
            Please request a new one.
          </p>
          {!resent ? (
            <button onClick={handleResend} disabled={resending} style={s.btnPrimary}>
              {resending ? 'Sending...' : 'Send new activation email'}
            </button>
          ) : (
            <div style={s.successBox}>
              ✅ New activation email sent! Check your inbox.
            </div>
          )}
          <button onClick={() => navigate('/login')} style={{ ...s.btnSecondary, marginTop: '0.75rem' }}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={{ ...s.iconWrap, background: '#fee2e2' }}>
          <span style={{ fontSize: 28, lineHeight: 1 }}>✕</span>
        </div>
        <h1 style={{ ...s.title, color: '#b91c1c' }}>Activation failed</h1>
        <p style={s.body}>
          {message || 'This activation link is invalid or has already been used.'}
        </p>
        {!resent ? (
          <button onClick={handleResend} disabled={resending} style={s.btnPrimary}>
            {resending ? 'Sending...' : 'Send new activation email'}
          </button>
        ) : (
          <div style={s.successBox}>
            ✅ New activation email sent! Check your inbox.
          </div>
        )}
        <button onClick={() => navigate('/login')} style={{ ...s.btnSecondary, marginTop: '0.75rem' }}>
          Back to sign in
        </button>
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
    padding: '2.5rem 2rem',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1.25rem',
  },
  title: {
    fontSize: '1.35rem',
    fontWeight: 800,
    marginBottom: '0.75rem',
    letterSpacing: '-0.02em',
  },
  body: {
    fontSize: '0.95rem',
    color: '#4b5563',
    lineHeight: 1.6,
    marginBottom: '1.5rem',
  },
  successBox: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: '0.75rem',
    color: '#15803d',
    fontSize: '0.875rem',
    fontWeight: 600,
    marginBottom: '0.5rem',
  },
  btnPrimary: {
    width: '100%',
    padding: '0.8rem',
    background: '#1a56b0',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: '0.95rem',
    cursor: 'pointer',
  },
  btnSecondary: {
    width: '100%',
    padding: '0.8rem',
    background: 'white',
    color: '#374151',
    border: '1.5px solid #d1d5db',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
};