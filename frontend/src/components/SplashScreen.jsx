/**
 * SplashScreen.jsx
 * Shown briefly while the app initialises.
 * Fades out automatically after `duration` ms.
 */
import { useEffect, useState } from 'react';
import HakikiLogo from './HakikiLogo';

export default function SplashScreen({ duration = 1600, onDone }) {
  const [visible, setVisible] = useState(true);
  const [fading, setFading]   = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), duration - 400);
    const doneTimer = setTimeout(() => {
      setVisible(false);
      onDone?.();
    }, duration);
    return () => { clearTimeout(fadeTimer); clearTimeout(doneTimer); };
  }, [duration, onDone]);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'linear-gradient(145deg, #0f2461 0%, #1e3a7b 50%, #1a56b0 100%)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '1.5rem',
      opacity: fading ? 0 : 1,
      transition: 'opacity 0.4s ease-out',
    }}>
      <style>{`
        @keyframes hakikiPulse {
          0%   { transform: scale(0.95); opacity: 0; }
          50%  { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(1);    opacity: 1; }
        }
        @keyframes hakikiGlow {
          0%, 100% { box-shadow: 0 0 0px rgba(79,156,249,0); }
          50%       { box-shadow: 0 0 40px rgba(79,156,249,0.35); }
        }
        .splash-icon {
          animation: hakikiPulse 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards,
                     hakikiGlow 2s ease-in-out 0.7s infinite;
          border-radius: 28px;
        }
        @keyframes hakikiTextIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .splash-text {
          animation: hakikiTextIn 0.5s ease-out 0.5s both;
        }
        @keyframes hakikiDots {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%            { opacity: 1;   transform: scale(1); }
        }
        .dot1 { animation: hakikiDots 1.2s ease-in-out 0.8s infinite; }
        .dot2 { animation: hakikiDots 1.2s ease-in-out 1.0s infinite; }
        .dot3 { animation: hakikiDots 1.2s ease-in-out 1.2s infinite; }
      `}</style>

      <div className="splash-icon">
        <HakikiLogo size={96} />
      </div>

      <div className="splash-text" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1.75rem', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.03em' }}>
          HakikiSign
        </div>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#7db8f7', letterSpacing: '0.2em', marginTop: 2 }}>
          AFRICA
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div className="dot1" style={{ width: 7, height: 7, borderRadius: '50%', background: '#4f9cf9' }} />
        <div className="dot2" style={{ width: 7, height: 7, borderRadius: '50%', background: '#4f9cf9' }} />
        <div className="dot3" style={{ width: 7, height: 7, borderRadius: '50%', background: '#4f9cf9' }} />
      </div>
    </div>
  );
}
