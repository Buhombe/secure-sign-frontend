import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function AppShell({ children }) {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const photoInputRef = useRef();

  const handleLogout = () => { logout(); navigate('/login'); };

  const handlePhotoChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('photo', file);
      const { data } = await api.post('/auth/profile-photo', form);
      updateUser({ profile_photo: data.profile_photo });
    } catch (err) {
      console.error('Photo upload failed');
    } finally { setUploading(false); }
  };

  const photoSrc = user?.profile_photo ? `http://localhost:5000${user.profile_photo}` : null;

  const navItems = [
    { icon: '🏠', label: 'Home',     path: '/dashboard' },
    { icon: '📂', label: 'Manage',   path: '/manage' },
    { icon: '⬆️', label: 'Upload',   path: '/upload' },
    { icon: '📊', label: 'Reports',  path: '/audit' },
    { icon: '⚙️', label: 'Settings', path: '/settings' },
  ];

  const SidebarContent = () => (
    <aside style={{
      width: 240, minWidth: 240,
      background: 'white',
      borderRight: '1px solid #e5e7eb',
      display: 'flex', flexDirection: 'column',
      height: '100vh',
      overflowY: 'auto',
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1.25rem', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ width: 36, height: 36, background: '#2563eb', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', flexShrink: 0 }}>✍️</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: '1rem', color: '#0f172a' }}>SecureSign</div>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, color: '#2563eb', letterSpacing: '0.1em' }}>AFRICA</div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.75rem' }}>
        {navItems.map(({ icon, label, path }) => {
          const active = location.pathname === path;
          return (
            <button key={label} onClick={() => { navigate(path); setSidebarOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                width: '100%', padding: '0.6rem 0.9rem',
                background: active ? '#eff6ff' : 'transparent',
                color: active ? '#2563eb' : '#64748b',
                border: 'none', borderRadius: 8,
                fontSize: '0.875rem', fontWeight: active ? 600 : 500,
                cursor: 'pointer', textAlign: 'left', marginBottom: '0.1rem',
              }}>
              <span style={{ width: 20, textAlign: 'center' }}>{icon}</span>
              {label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: '1rem', borderTop: '1px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div onClick={() => photoInputRef.current?.click()} style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
            {photoSrc ? (
              <img src={photoSrc} alt="profile" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', border: '2px solid #e5e7eb' }} />
            ) : (
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: '0.9rem', border: '2px solid #e5e7eb' }}>
                {user?.email?.[0]?.toUpperCase()}
              </div>
            )}
            <div style={{ position: 'absolute', bottom: -2, right: -2, width: 14, height: 14, background: uploading ? '#f59e0b' : '#10b981', borderRadius: '50%', border: '2px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '7px', color: 'white' }}>
              {uploading ? '⏳' : '+'}
            </div>
          </div>
          <input ref={photoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email?.split('@')[0]}
            </div>
            <div style={{ fontSize: '0.7rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email}
            </div>
          </div>
          <button onClick={handleLogout} title="Logout"
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1rem', padding: '0.25rem' }}>
            ↪
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-topbar { display: flex !important; }
        }
        @media (min-width: 769px) {
          .desktop-sidebar { display: flex !important; }
          .mobile-topbar { display: none !important; }
          .mobile-drawer { display: none !important; }
        }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>

        {/* Desktop sidebar — shown only ≥769px */}
        <div className="desktop-sidebar" style={{ display: 'none' }}>
          <SidebarContent />
        </div>

        {/* Mobile drawer */}
        {sidebarOpen && (
          <>
            <div onClick={() => setSidebarOpen(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 40 }} />
            <div className="mobile-drawer" style={{ position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 50, display: 'flex' }}>
              <SidebarContent />
            </div>
          </>
        )}

        {/* Right side */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Mobile topbar */}
          <div className="mobile-topbar" style={{ display: 'none', alignItems: 'center', gap: '1rem', padding: '0.75rem 1rem', background: 'white', borderBottom: '1px solid #e5e7eb' }}>
            <button onClick={() => setSidebarOpen(true)}
              style={{ background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: '#374151' }}>☰</button>
            <span style={{ fontWeight: 800, color: '#0f172a' }}>SecureSign</span>
          </div>

          {children}
        </div>
      </div>
    </>
  );
}