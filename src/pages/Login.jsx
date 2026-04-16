import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

function Login() {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    if (mode === 'signup' && password !== confirm) return setError('Passwords do not match.');
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/signup';
      const { data } = await api.post(endpoint, { email, password });
      login(data.user, data.token);
      setSuccess(data.message);
      setTimeout(() => navigate('/dashboard'), 800);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'signup' : 'login');
    setError(''); setSuccess(''); setEmail(''); setPassword(''); setConfirm('');
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <span style={styles.logo}>✍️</span>
          <h1 style={styles.title}>SecureSign</h1>
          <p style={styles.subtitle}>{mode === 'login' ? 'Welcome back' : 'Create your account'}</p>
        </div>
        {error && <div style={styles.error}>{error}</div>}
        {success && <div style={styles.success}>{success}</div>}
        <form onSubmit={handleSubmit}>
          <div style={styles.group}>
            <label style={styles.label}>Email address</label>
            <input style={styles.input} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div style={styles.group}>
            <label style={styles.label}>Password</label>
            <input style={styles.input} type="password" placeholder="At least 6 characters" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {mode === 'signup' && (
            <div style={styles.group}>
              <label style={styles.label}>Confirm Password</label>
              <input style={styles.input} type="password" placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
          )}
          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? '...' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>
        <p style={styles.toggle}>
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button onClick={switchMode} style={styles.toggleBtn}>
            {mode === 'login' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,rgb(155, 180, 186) 0%, #764ba2 100%)', padding: '1rem' },
  card: { background: 'white', borderRadius: '16px', padding: '2.5rem', width: '100%', maxWidth: '420px', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' },
  header: { textAlign: 'center', marginBottom: '2rem' },
  logo: { fontSize: '3rem', display: 'block', marginBottom: '0.5rem' },
  title: { fontSize: '1.8rem', fontWeight: '800', color: '#1a1a2e', marginBottom: '0.25rem' },
  subtitle: { color: '#6b7280', fontSize: '0.95rem' },
  error: { background: '#fee2e2', color: '#b91c1c', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.9rem' },
  success: { background: '#d1fae5', color: '#065f46', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.9rem' },
  group: { display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '1.2rem' },
  label: { fontSize: '0.875rem', fontWeight: '600', color: '#374151' },
  input: { padding: '0.65rem 0.9rem', border: '1.5px solid #d1d5db', borderRadius: '8px', fontSize: '0.95rem', outline: 'none' },
  button: { width: '100%', padding: '0.75rem', background: '#4f46e5', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem', fontWeight: '700', cursor: 'pointer', marginTop: '0.5rem' },
  toggle: { textAlign: 'center', marginTop: '1.5rem', fontSize: '0.9rem', color: '#6b7280' },
  toggleBtn: { background: 'none', border: 'none', color: '#4f46e5', fontWeight: '700', cursor: 'pointer', fontSize: '0.9rem' },
};

export default Login;
