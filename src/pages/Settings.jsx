import { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import AppShell from '../components/AppShell';

export default function Settings() {
  const { user, updateUser } = useAuth();
  const [activeTab, setActiveTab] = useState('profile');
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState('');
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [pwError, setPwError] = useState('');
  const photoRef = useRef();

  const photoSrc = user?.profile_photo ? `http://localhost:5000${user.profile_photo}` : null;

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('photo', file);
      const { data } = await api.post('/auth/profile-photo', form);
      updateUser({ profile_photo: data.profile_photo });
      setSaved('Profile photo updated!');
      setTimeout(() => setSaved(''), 3000);
    } catch { setSaved('Failed to upload.'); }
    finally { setUploading(false); }
  };

  const tabs = [
    { id: 'profile', label: 'My Profile', icon: '👤' },
    { id: 'notifications', label: 'Notifications', icon: '🔔' },
    { id: 'security', label: 'Security', icon: '🔒' },
    { id: 'billing', label: 'Billing & Plan', icon: '💳' },
  ];

  return (
    <AppShell>
      <div style={{ flex: 1 }}>
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '1rem 1.5rem' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Settings</h1>
        </header>

        <main style={{ padding: 'clamp(1rem, 3vw, 2rem)', maxWidth: 900, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {/* Sidebar tabs */}
            <div style={{ width: 200, flexShrink: 0 }}>
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem',
                      padding: '0.75rem 1rem', background: activeTab === t.id ? '#eff6ff' : 'white',
                      color: activeTab === t.id ? '#2563eb' : '#374151',
                      border: 'none', borderBottom: '1px solid #f1f5f9',
                      fontSize: '0.875rem', fontWeight: activeTab === t.id ? 600 : 400,
                      cursor: 'pointer', textAlign: 'left',
                    }}>
                    <span>{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {saved && (
                <div style={{ background: '#dcfce7', color: '#16a34a', padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.875rem', fontWeight: 600 }}>
                  ✓ {saved}
                </div>
              )}

              {activeTab === 'profile' && (
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1.5rem', color: '#0f172a' }}>My Profile</h2>

                  {/* Profile photo */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ position: 'relative' }}>
                      {photoSrc ? (
                        <img src={photoSrc} alt="profile" style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', border: '3px solid #e5e7eb' }} />
                      ) : (
                        <div style={{ width: 80, height: 80, borderRadius: '50%', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: '2rem', border: '3px solid #e5e7eb' }}>
                          {user?.email?.[0]?.toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: '0.35rem' }}>{user?.email?.split('@')[0]}</div>
                      <input ref={photoRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
                      <button onClick={() => photoRef.current?.click()}
                        style={{ padding: '0.4rem 0.9rem', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, cursor: 'pointer', fontSize: '0.8rem', color: '#374151', fontWeight: 500 }}>
                        {uploading ? 'Uploading...' : '📷 Change Photo'}
                      </button>
                    </div>
                  </div>

                  {/* Account info */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                      <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '0.35rem' }}>Email Address</label>
                      <div style={{ padding: '0.6rem 0.9rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.875rem', color: '#374151' }}>
                        {user?.email}
                      </div>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '0.35rem' }}>Member Since</label>
                      <div style={{ padding: '0.6rem 0.9rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.875rem', color: '#374151' }}>
                        {user?.created_at ? new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'notifications' && (
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1.5rem', color: '#0f172a' }}>Notification Preferences</h2>
                  {[
                    { label: 'Document signed by recipient', sub: 'Get notified when someone signs your document' },
                    { label: 'Signature request received', sub: 'Get notified when you receive a signing request' },
                    { label: 'Document viewed', sub: 'Get notified when your document is viewed' },
                    { label: 'Reminders', sub: 'Send reminders for pending documents' },
                  ].map(({ label, sub }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.9rem 0', borderBottom: '1px solid #f8fafc' }}>
                      <div>
                        <div style={{ fontSize: '0.875rem', fontWeight: 500, color: '#0f172a' }}>{label}</div>
                        <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{sub}</div>
                      </div>
                      <div style={{ width: 40, height: 22, background: '#2563eb', borderRadius: 11, position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
                        <div style={{ position: 'absolute', right: 2, top: 2, width: 18, height: 18, background: 'white', borderRadius: '50%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'security' && (
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1.5rem', color: '#0f172a' }}>Security</h2>
                  {pwError && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '0.6rem', borderRadius: 7, marginBottom: '1rem', fontSize: '0.8rem' }}>{pwError}</div>}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', maxWidth: 400 }}>
                    {[
                      { label: 'Current Password', key: 'current', type: 'password' },
                      { label: 'New Password', key: 'newPw', type: 'password' },
                      { label: 'Confirm New Password', key: 'confirm', type: 'password' },
                    ].map(({ label, key, type }) => (
                      <div key={key}>
                        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '0.35rem' }}>{label}</label>
                        <input type={type} value={pwForm[key]} onChange={e => setPwForm(p => ({ ...p, [key]: e.target.value }))}
                          style={{ width: '100%', padding: '0.6rem 0.9rem', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: '0.875rem', outline: 'none' }} />
                      </div>
                    ))}
                    <button style={{ padding: '0.6rem 1.25rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '0.875rem', alignSelf: 'flex-start' }}>
                      Update Password
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'billing' && (
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.5rem' }}>
                  <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1.5rem', color: '#0f172a' }}>Billing & Plan</h2>
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '1.25rem', marginBottom: '1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div>
                        <div style={{ fontWeight: 700, color: '#1e40af', fontSize: '1rem' }}>Free Plan</div>
                        <div style={{ fontSize: '0.78rem', color: '#3b82f6', marginTop: '0.2rem' }}>5 documents/month included</div>
                      </div>
                      <button style={{ padding: '0.5rem 1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '0.8rem' }}>
                        Upgrade Plan
                      </button>
                    </div>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>No payment method on file.</div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </AppShell>
  );
}
