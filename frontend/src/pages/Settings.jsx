// Settings.jsx — Modernized settings page
import { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import AppShell from '../components/AppShell';

/* ─── Section Card ───────────────────────────────────────────── */
function SectionCard({ title, subtitle, children }) {
  return (
    <div style={{ background: 'white', borderRadius: 16, border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)', marginBottom: '1.25rem' }}>
      <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #F1F5F9' }}>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0F172A' }}>{title}</h2>
        {subtitle && <p style={{ fontSize: '0.82rem', color: '#94A3B8', marginTop: 3 }}>{subtitle}</p>}
      </div>
      <div style={{ padding: '1.25rem 1.5rem' }}>{children}</div>
    </div>
  );
}

/* ─── Field ──────────────────────────────────────────────────── */
function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#374151', marginBottom: '0.4rem' }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: '0.72rem', color: '#94A3B8', marginTop: '0.25rem' }}>{hint}</p>}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '0.6rem 0.9rem',
  border: '1px solid #E2E8F0', borderRadius: 9,
  fontSize: '0.875rem', color: '#0F172A', background: 'white',
  outline: 'none', transition: 'border-color 0.15s',
};

/* ─── Toggle ─────────────────────────────────────────────────── */
function Toggle({ on, onChange, label, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.85rem 0', borderBottom: '1px solid #F8FAFC' }}>
      <div style={{ flex: 1, paddingRight: '1rem' }}>
        <div style={{ fontSize: '0.875rem', fontWeight: 500, color: '#0F172A' }}>{label}</div>
        {sub && <div style={{ fontSize: '0.75rem', color: '#94A3B8', marginTop: 2 }}>{sub}</div>}
      </div>
      <div
        onClick={onChange}
        style={{
          width: 44, height: 24, borderRadius: 12, position: 'relative', cursor: 'pointer',
          background: on ? '#2563EB' : '#E2E8F0',
          transition: 'background 0.2s ease', flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute', top: 3, left: on ? 23 : 3,
          width: 18, height: 18, borderRadius: '50%', background: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          transition: 'left 0.2s ease',
        }} />
      </div>
    </div>
  );
}

/* ─── Tab Navigation ─────────────────────────────────────────── */
const TABS = [
  { id: 'profile',   label: 'Profile',       icon: (
    <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
  )},
  { id: 'notifications', label: 'Notifications', icon: (
    <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
  )},
  { id: 'security',  label: 'Security',      icon: (
    <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
  )},
];

/* ─── Main Settings ──────────────────────────────────────────── */
export default function Settings() {
  const { user, updateUser } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');
  const [uploading,  setUploading]  = useState(false);
  const [saved,      setSaved]      = useState('');
  const [error,      setError]      = useState('');
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [notifs, setNotifs] = useState({ signed: true, received: true, viewed: false, reminders: true });
  const photoRef = useRef();

  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
  const photoFilename = user?.profile_photo?.split('/').pop();
  const photoSrc = user?.profile_photo
    ? user.profile_photo.startsWith('http')
      ? user.profile_photo
      : `${API_BASE}/auth/photo/${photoFilename}`
    : null;

  const notify = (msg, isError = false) => {
    if (isError) { setError(msg); setTimeout(() => setError(''), 4000); }
    else { setSaved(msg); setTimeout(() => setSaved(''), 3000); }
  };

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('photo', file);
      const { data } = await api.post('/auth/profile-photo', form);
      updateUser?.({ profile_photo: data.profile_photo });
      notify('Profile photo updated!');
    } catch { notify('Failed to upload photo.', true); }
    finally { setUploading(false); }
  };

  const handlePasswordUpdate = async () => {
    if (pwForm.newPw !== pwForm.confirm) { notify('Passwords do not match.', true); return; }
    if (pwForm.newPw.length < 8) { notify('Password must be at least 8 characters.', true); return; }
    try {
      await api.post('/auth/change-password', { current: pwForm.current, newPassword: pwForm.newPw });
      notify('Password updated successfully!');
      setPwForm({ current: '', newPw: '', confirm: '' });
    } catch (err) { notify(err?.response?.data?.error || 'Failed to update password.', true); }
  };

  const displayName = user?.name || user?.email?.split('@')[0] || '';

  return (
    <AppShell>
      <div className="fade-in" style={{ flex: 1 }}>
        <div style={{ padding: 'clamp(1.25rem,4vw,2rem) clamp(1rem,4vw,2rem)', maxWidth: 860, margin: '0 auto' }}>

          {/* Page header */}
          <div style={{ marginBottom: '1.5rem' }}>
            <h1 style={{ fontSize: 'clamp(1.1rem,3vw,1.4rem)', fontWeight: 800, color: '#0F172A', letterSpacing: '-0.02em' }}>Settings</h1>
            <p style={{ fontSize: '0.875rem', color: '#64748B', marginTop: 2 }}>Manage your account and preferences</p>
          </div>

          {/* Toast notifications */}
          {saved && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: '#DCFCE7', color: '#16A34A', padding: '0.7rem 1rem', borderRadius: 10, marginBottom: '1rem', fontSize: '0.875rem', fontWeight: 600, border: '1px solid #BBF7D0' }}>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              {saved}
            </div>
          )}
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', background: '#FEE2E2', color: '#DC2626', padding: '0.7rem 1rem', borderRadius: 10, marginBottom: '1rem', fontSize: '0.875rem', fontWeight: 600, border: '1px solid #FECACA' }}>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12" strokeLinecap="round"/><line x1="12" y1="16" x2="12.01" y2="16" strokeLinecap="round"/></svg>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* Tab sidebar */}
            <div style={{ width: 200, flexShrink: 0 }}>
              <div style={{ background: 'white', borderRadius: 14, border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                {TABS.map((t, i) => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: '0.65rem',
                      padding: '0.8rem 1rem',
                      background: activeTab === t.id ? '#EFF6FF' : 'white',
                      color: activeTab === t.id ? '#2563EB' : '#374151',
                      border: 'none', borderBottom: i < TABS.length - 1 ? '1px solid #F1F5F9' : 'none',
                      fontSize: '0.875rem', fontWeight: activeTab === t.id ? 600 : 400,
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (activeTab !== t.id) e.currentTarget.style.background = '#F8FAFC'; }}
                    onMouseLeave={e => { if (activeTab !== t.id) e.currentTarget.style.background = 'white'; }}
                  >
                    <span style={{ color: activeTab === t.id ? '#2563EB' : '#94A3B8' }}>{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, minWidth: 0 }}>

              {/* Profile Tab */}
              {activeTab === 'profile' && (
                <>
                  <SectionCard title="Profile Photo" subtitle="Your avatar shown across the platform">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                      <div style={{ position: 'relative' }}>
                        {photoSrc ? (
                          <img src={photoSrc} alt="profile"
                            style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', border: '3px solid #E2E8F0' }} />
                        ) : (
                          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, #3B82F6, #1D4ED8)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '1.75rem', border: '3px solid #E2E8F0' }}>
                            {user?.email?.[0]?.toUpperCase()}
                          </div>
                        )}
                        {uploading && (
                          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <div className="pulse" style={{ width: 20, height: 20, border: '2px solid white', borderTop: '2px solid transparent', borderRadius: '50%' }} />
                          </div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, color: '#0F172A', fontSize: '0.95rem', marginBottom: '0.4rem' }}>{displayName}</div>
                        <input ref={photoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
                        <button onClick={() => photoRef.current?.click()}
                          style={{ padding: '0.45rem 1rem', background: 'white', border: '1px solid #E2E8F0', borderRadius: 8, cursor: 'pointer', fontSize: '0.82rem', color: '#374151', fontWeight: 500 }}>
                          {uploading ? 'Uploading...' : 'Change Photo'}
                        </button>
                      </div>
                    </div>
                  </SectionCard>

                  <SectionCard title="Account Information" subtitle="Your account details">
                    <Field label="Email Address">
                      <div style={{ ...inputStyle, background: '#F8FAFC', color: '#64748B', cursor: 'default' }}>
                        {user?.email}
                      </div>
                    </Field>
                    <Field label="Member Since">
                      <div style={{ ...inputStyle, background: '#F8FAFC', color: '#64748B', cursor: 'default' }}>
                        {user?.created_at
                          ? new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                          : '—'}
                      </div>
                    </Field>
                  </SectionCard>
                </>
              )}

              {/* Notifications Tab */}
              {activeTab === 'notifications' && (
                <SectionCard title="Notification Preferences" subtitle="Control when and how you're notified">
                  <Toggle
                    on={notifs.signed} onChange={() => setNotifs(n => ({ ...n, signed: !n.signed }))}
                    label="Document signed" sub="Get notified when someone signs your document"
                  />
                  <Toggle
                    on={notifs.received} onChange={() => setNotifs(n => ({ ...n, received: !n.received }))}
                    label="Signature request received" sub="Get notified when you receive a signing request"
                  />
                  <Toggle
                    on={notifs.viewed} onChange={() => setNotifs(n => ({ ...n, viewed: !n.viewed }))}
                    label="Document viewed" sub="Get notified when your document is opened"
                  />
                  <Toggle
                    on={notifs.reminders} onChange={() => setNotifs(n => ({ ...n, reminders: !n.reminders }))}
                    label="Signing reminders" sub="Send automatic reminders for pending documents"
                  />
                  <div style={{ marginTop: '1.25rem' }}>
                    <button onClick={() => notify('Notification preferences saved!')}
                      style={{ padding: '0.6rem 1.4rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700, fontSize: '0.875rem' }}>
                      Save Preferences
                    </button>
                  </div>
                </SectionCard>
              )}

              {/* Security Tab */}
              {activeTab === 'security' && (
                <SectionCard title="Change Password" subtitle="Update your account password">
                  <div style={{ maxWidth: 420 }}>
                    <Field label="Current Password">
                      <input type="password" value={pwForm.current}
                        onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))}
                        style={inputStyle} placeholder="Enter current password"
                        onFocus={e => e.target.style.borderColor = '#93C5FD'}
                        onBlur={e => e.target.style.borderColor = '#E2E8F0'}
                      />
                    </Field>
                    <Field label="New Password" hint="Minimum 8 characters">
                      <input type="password" value={pwForm.newPw}
                        onChange={e => setPwForm(p => ({ ...p, newPw: e.target.value }))}
                        style={inputStyle} placeholder="Enter new password"
                        onFocus={e => e.target.style.borderColor = '#93C5FD'}
                        onBlur={e => e.target.style.borderColor = '#E2E8F0'}
                      />
                    </Field>
                    <Field label="Confirm New Password">
                      <input type="password" value={pwForm.confirm}
                        onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))}
                        style={inputStyle} placeholder="Confirm new password"
                        onFocus={e => e.target.style.borderColor = '#93C5FD'}
                        onBlur={e => e.target.style.borderColor = '#E2E8F0'}
                      />
                    </Field>
                    <button onClick={handlePasswordUpdate}
                      style={{ padding: '0.6rem 1.4rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 9, cursor: 'pointer', fontWeight: 700, fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      Update Password
                    </button>
                  </div>
                </SectionCard>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
