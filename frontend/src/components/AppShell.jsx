import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import HakikiLogo from './HakikiLogo';

/* ─── Design Tokens ─────────────────────────────────────────── */
const T = {
  sidebar: '#0F172A',
  sidebarBorder: 'rgba(255,255,255,0.07)',
  sidebarText: '#94A3B8',
  sidebarActive: 'rgba(37,99,235,0.3)',
  sidebarActiveText: '#E2E8F0',
  sidebarHover: 'rgba(255,255,255,0.06)',
  primary: '#2563EB',
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  text: '#0F172A',
  muted: '#64748B',
};

const NAV = [
  {
    icon: (active) => (
      <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke={active ? '#93C5FD' : '#64748B'} strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9"/>
      </svg>
    ),
    label: 'Dashboard', path: '/dashboard',
  },
  {
    icon: (active) => (
      <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke={active ? '#93C5FD' : '#64748B'} strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
    ),
    label: 'Documents', path: '/manage',
  },
  {
    icon: (active) => (
      <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke={active ? '#93C5FD' : '#64748B'} strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    label: 'Settings', path: '/settings',
  },
];

/* ─── Sidebar Nav Item ───────────────────────────────────────── */
function NavItem({ item, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem',
        width: '100%', padding: '0.6rem 0.9rem',
        background: active ? T.sidebarActive : 'transparent',
        color: active ? '#E2E8F0' : T.sidebarText,
        border: active ? '1px solid rgba(37,99,235,0.4)' : '1px solid transparent',
        borderRadius: 10,
        fontSize: '0.875rem', fontWeight: active ? 600 : 400,
        cursor: 'pointer', textAlign: 'left',
        marginBottom: '0.15rem',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = T.sidebarHover; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {item.icon(active)}
      </span>
      <span>{item.label}</span>
    </button>
  );
}

/* ─── Avatar ─────────────────────────────────────────────────── */
function Avatar({ photoSrc, email, size = 34, onClick }) {
  return (
    <div onClick={onClick} style={{ flexShrink: 0, cursor: onClick ? 'pointer' : 'default', position: 'relative' }}>
      {photoSrc ? (
        <img src={photoSrc} alt="profile"
          style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(255,255,255,0.15)', display: 'block' }} />
      ) : (
        <div style={{
          width: size, height: size, borderRadius: '50%',
          background: 'linear-gradient(135deg, #3B82F6, #1D4ED8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontWeight: 700, fontSize: size * 0.38,
          border: '2px solid rgba(255,255,255,0.15)',
        }}>
          {email?.[0]?.toUpperCase()}
        </div>
      )}
    </div>
  );
}

/* ─── Desktop Sidebar Content ────────────────────────────────── */
function SidebarContent({ onNav, uploading, photoSrc, user, onLogout, onPhotoClick }) {
  const location = useLocation();

  return (
    <div style={{
      width: 240, flexShrink: 0,
      background: T.sidebar,
      display: 'flex', flexDirection: 'column',
      height: '100%',
      borderRight: '1px solid rgba(255,255,255,0.04)',
    }}>
      {/* Logo */}
      <div style={{ padding: '1.25rem 1.25rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <HakikiLogo size={34} showText={true} textSize="0.9rem"
          style={{ filter: 'brightness(1.1)' }} />
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.85rem 0.75rem', overflowY: 'auto' }}>
        <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'rgba(148,163,184,0.5)', letterSpacing: '0.1em', textTransform: 'uppercase', padding: '0 0.5rem 0.6rem', marginBottom: '0.25rem' }}>
          Menu
        </div>
        {NAV.map(item => (
          <NavItem
            key={item.path}
            item={item}
            active={location.pathname === item.path}
            onClick={() => onNav(item.path)}
          />
        ))}
      </nav>

      {/* User footer */}
      <div style={{ padding: '0.85rem 0.75rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.6rem 0.75rem', borderRadius: 10, background: 'rgba(255,255,255,0.04)', marginBottom: '0.5rem' }}>
          <Avatar photoSrc={photoSrc} email={user?.email} size={32} onClick={onPhotoClick} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#E2E8F0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email?.split('@')[0]}
            </div>
            <div style={{ fontSize: '0.68rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email}
            </div>
          </div>
        </div>

        {/* Logout */}
        <button onClick={onLogout}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.6rem',
            width: '100%', padding: '0.55rem 0.75rem',
            background: 'transparent', border: '1px solid transparent',
            borderRadius: 8, cursor: 'pointer', color: '#64748B',
            fontSize: '0.84rem', fontWeight: 500,
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(220,38,38,0.12)';
            e.currentTarget.style.color = '#F87171';
            e.currentTarget.style.borderColor = 'rgba(220,38,38,0.2)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = '#64748B';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        >
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
          Log out
        </button>
      </div>
    </div>
  );
}

/* ─── New Document Dropdown ──────────────────────────────────── */
function NewDropdown({ navigate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const options = [
    { label: 'Upload Document', icon: '⬆', path: '/upload' },
    { label: 'Manage Documents', icon: '📂', path: '/manage' },
  ];

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          padding: '0.45rem 0.9rem',
          background: T.primary, color: 'white',
          border: 'none', borderRadius: 9,
          fontSize: '0.84rem', fontWeight: 600,
          cursor: 'pointer', whiteSpace: 'nowrap',
          boxShadow: '0 2px 8px rgba(37,99,235,0.3)',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#1D4ED8'}
        onMouseLeave={e => e.currentTarget.style.background = T.primary}
      >
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        New
        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 1 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 100,
          background: 'white', borderRadius: 12, border: '1px solid #E2E8F0',
          boxShadow: '0 12px 28px rgba(0,0,0,0.1)', padding: '0.4rem',
          minWidth: 200,
        }} className="fade-in">
          {options.map(opt => (
            <button key={opt.path}
              onClick={() => { navigate(opt.path); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.65rem',
                width: '100%', padding: '0.6rem 0.9rem',
                background: 'transparent', border: 'none', borderRadius: 8,
                fontSize: '0.84rem', color: '#0F172A', cursor: 'pointer',
                textAlign: 'left', fontWeight: 500,
                transition: 'background 0.1s ease',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: '1rem' }}>{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Main AppShell ──────────────────────────────────────────── */
export default function AppShell({ children }) {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
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
      updateUser?.({ profile_photo: data.profile_photo });
    } catch { console.error('Photo upload failed'); }
    finally { setUploading(false); }
  };

  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
  const photoFilename = user?.profile_photo?.split('/').pop();
  const photoSrc = user?.profile_photo
    ? user.profile_photo.startsWith('http')
      ? user.profile_photo
      : `${API_BASE}/auth/photo/${photoFilename}`
    : null;

  const handleNav = (path) => { navigate(path); setSidebarOpen(false); };

  return (
    <>
      <style>{`
        .hs-desktop-sidebar { display: none; }
        .hs-mobile-topbar { display: flex; }
        @media (min-width: 768px) {
          .hs-desktop-sidebar { display: flex; flex-direction: column; }
          .hs-mobile-topbar { display: none !important; }
          .hs-mobile-drawer { display: none !important; }
        }
      `}</style>

      <input ref={photoInputRef} type="file" accept="image/*"
        style={{ display: 'none' }} onChange={handlePhotoChange} />

      <div style={{ display: 'flex', minHeight: '100vh', background: T.bg }}>

        {/* Desktop Sidebar */}
        <div className="hs-desktop-sidebar" style={{ height: '100vh', position: 'sticky', top: 0, zIndex: 30 }}>
          <SidebarContent
            onNav={handleNav}
            uploading={uploading}
            photoSrc={photoSrc}
            user={user}
            onLogout={handleLogout}
            onPhotoClick={() => photoInputRef.current?.click()}
          />
        </div>

        {/* Mobile overlay + drawer */}
        {sidebarOpen && (
          <div className="hs-mobile-drawer" style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
            <div
              className="overlay-fade"
              onClick={() => setSidebarOpen(false)}
              style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }}
            />
            <div className="slide-in-left" style={{ position: 'relative', height: '100%' }}>
              <SidebarContent
                onNav={handleNav}
                uploading={uploading}
                photoSrc={photoSrc}
                user={user}
                onLogout={handleLogout}
                onPhotoClick={() => { photoInputRef.current?.click(); setSidebarOpen(false); }}
              />
            </div>
          </div>
        )}

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          {/* Mobile topbar */}
          <header className="hs-mobile-topbar mobile-topbar" style={{
            alignItems: 'center', gap: '0.75rem',
            padding: '0.65rem 1rem',
            background: 'white', borderBottom: '1px solid #E2E8F0',
            position: 'sticky', top: 0, zIndex: 20,
          }}>
            <button onClick={() => setSidebarOpen(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.2rem', color: '#374151', display: 'flex', alignItems: 'center' }}>
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
              </svg>
            </button>
            <HakikiLogo size={28} showText={true} textSize="0.82rem" />
            <div style={{ flex: 1 }} />
            <NewDropdown navigate={navigate} />
          </header>

          {/* Desktop topbar */}
          <header style={{
            display: 'none',
            alignItems: 'center', gap: '1rem',
            padding: '0.6rem 1.5rem',
            background: 'white', borderBottom: '1px solid #E2E8F0',
            position: 'sticky', top: 0, zIndex: 20,
          }}
          className="hs-desktop-topbar"
          >
            {/* Search */}
            <div style={{
              flex: 1, maxWidth: 400,
              display: 'flex', alignItems: 'center', gap: '0.6rem',
              background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 9,
              padding: '0.45rem 0.9rem',
            }}>
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="#94A3B8" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/>
              </svg>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search documents..."
                style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: '0.85rem', color: '#0F172A', width: '100%' }}
              />
              <span style={{ fontSize: '0.7rem', color: '#CBD5E1', background: '#F1F5F9', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace' }}>⌘K</span>
            </div>
            <div style={{ flex: 1 }} />
            <NewDropdown navigate={navigate} />
            {/* Notification bell */}
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', display: 'flex', alignItems: 'center', padding: '0.4rem', borderRadius: 8, position: 'relative' }}
              onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}>
              <svg width="19" height="19" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
              </svg>
            </button>
            {/* User avatar */}
            <div onClick={() => navigate('/settings')} style={{ cursor: 'pointer' }}>
              {photoSrc ? (
                <img src={photoSrc} alt="profile"
                  style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: '2px solid #E2E8F0' }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #3B82F6, #1D4ED8)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: '0.8rem', border: '2px solid #E2E8F0' }}>
                  {user?.email?.[0]?.toUpperCase()}
                </div>
              )}
            </div>
          </header>

          <style>{`
            @media (min-width: 768px) {
              .hs-desktop-topbar { display: flex !important; }
            }
          `}</style>

          {children}
        </div>
      </div>
    </>
  );
}
