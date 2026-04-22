import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

/**
 * VerifyEmail — handles the one-click link from the verification email.
 *
 * URL format: /verify-email?token=<64-char-hex>
 *
 * Note: unlike signing links (which use #fragment), verification links use
 * ?token= in the query string. This is intentional — the browser must navigate
 * to this page (not a SPA sign page), and the token is consumed exactly once
 * by the server with no risk of log exposure on the API server (the frontend
 * server only sees the path, not the API server).
 */
export default function VerifyEmail() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('verifying'); // 'verifying' | 'success' | 'error' | 'expired'
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get('token');

    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Please use the link from your email.');
      return;
    }

    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(({ data }) => {
        setStatus('success');
        setMessage(data.message || 'Email verified successfully.');
      })
      .catch((err) => {
        const code = err.response?.data?.code;
        if (code === 'TOKEN_EXPIRED') {
          setStatus('expired');
          setMessage('This verification link has expired.');
        } else {
          setStatus('error');
          setMessage(err.response?.data?.error || 'Verification failed. The link may have already been used.');
        }
      });
  }, []);

  const handleResend = async () => {
    // Redirect to login page where they can use the "Resend verification" option
    navigate('/login?resend=1');
  };

  const icon = {
    verifying: '⏳',
    success:   '✅',
    error:     '❌',
    expired:   '⌛',
  }[status];

  const bgColor = {
    verifying: '#f8fafc',
    success:   '#f0fdf4',
    error:     '#fef2f2',
    expired:   '#fffbeb',
  }[status];

  const titleColor = {
    verifying: '#475569',
    success:   '#15803d',
    error:     '#b91c1c',
    expired:   '#92400e',
  }[status];

  return (
    <div style={s.page}>
      <div style={{ ...s.card, background: bgColor }}>
        <div style={s.icon}>{icon}</div>

        <h1 style={{ ...s.title, color: titleColor }}>
          {status === 'verifying' && 'Verifying your email...'}
          {status === 'success'   && 'Email verified!'}
          {status === 'error'     && 'Verification failed'}
          {status === 'expired'   && 'Link expired'}
        </h1>

        <p style={s.body}>{message}</p>

        {status === 'success' && (
          <button onClick={() => navigate('/dashboard')} style={s.btnPrimary}>
            Go to dashboard →
          </button>
        )}

        {(status === 'error' || status === 'expired') && (
          <div style={s.actions}>
            <button onClick={handleResend} style={s.btnPrimary}>
              Resend verification email
            </button>
            <button onClick={() => navigate('/login')} style={s.btnSecondary}>
              Back to login
            </button>
          </div>
        )}
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
    borderRadius: 16,
    border: '1px solid #e5e7eb',
    padding: '2.5rem 2rem',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
  },
  icon: {
    fontSize: '3.5rem',
    marginBottom: '1rem',
  },
  title: {
    fontSize: '1.3rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  body: {
    fontSize: '0.95rem',
    color: '#475569',
    lineHeight: 1.6,
    marginBottom: '1.5rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  btnPrimary: {
    padding: '0.75rem 1.5rem',
    background: '#2563eb',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontWeight: 700,
    fontSize: '0.95rem',
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '0.75rem 1.5rem',
    background: 'white',
    color: '#374151',
    border: '1.5px solid #d1d5db',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: '0.95rem',
    cursor: 'pointer',
  },
};
