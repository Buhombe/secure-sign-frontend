import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    color: '#64748b',
    highlight: false,
    description: 'Perfect for trying out SecureSign',
    features: [
      '3 documents per month',
      'Up to 3 signers per document',
      'RSA-PSS cryptographic signing',
      'Audit trail',
      'Email notifications',
      'PDF download',
    ],
    missing: [
      'Unlimited documents',
      'Priority support',
      'Custom branding',
    ],
    cta: 'Get started free',
    ctaAction: 'signup',
  },
  {
    name: 'Pro',
    price: '$9',
    period: 'per month',
    color: '#2563eb',
    highlight: true,
    description: 'For freelancers and small businesses',
    features: [
      'Unlimited documents',
      'Up to 10 signers per document',
      'RSA-PSS cryptographic signing',
      'Full audit trail + HMAC integrity',
      'Email notifications',
      'PDF download',
      'Priority email support',
    ],
    missing: [
      'Custom branding',
    ],
    cta: 'Start Pro — $9/mo',
    ctaAction: 'pro',
  },
  {
    name: 'Business',
    price: '$29',
    period: 'per month',
    color: '#7c3aed',
    highlight: false,
    description: 'For teams and growing companies',
    features: [
      'Everything in Pro',
      'Up to 5 team members',
      'Custom email branding',
      'API access',
      'Dedicated support',
      'SLA guarantee',
    ],
    missing: [],
    cta: 'Contact us',
    ctaAction: 'contact',
  },
];

export default function Pricing() {
  const navigate  = useNavigate();
  const { user }  = useAuth();

  const handleCta = (action) => {
    if (action === 'signup') navigate(user ? '/dashboard' : '/login');
    if (action === 'pro')    navigate(user ? '/settings' : '/login');
    if (action === 'contact') window.location.href = 'mailto:hello@securesign.app';
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* Nav */}
      <nav style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '1rem 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }} onClick={() => navigate('/')}>
          <div style={{ width: 32, height: 32, background: '#2563eb', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem' }}>✍️</div>
          <span style={{ fontWeight: 800, fontSize: '1rem', color: '#0f172a' }}>SecureSign</span>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {user ? (
            <button onClick={() => navigate('/dashboard')}
              style={{ padding: '0.5rem 1.1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
              Dashboard
            </button>
          ) : (
            <>
              <button onClick={() => navigate('/login')}
                style={{ padding: '0.5rem 1rem', background: 'transparent', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, fontWeight: 500, fontSize: '0.875rem', cursor: 'pointer' }}>
                Log in
              </button>
              <button onClick={() => navigate('/login')}
                style={{ padding: '0.5rem 1.1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                Get started
              </button>
            </>
          )}
        </div>
      </nav>

      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '4rem 1rem 3rem' }}>
        <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 800, color: '#0f172a', margin: '0 0 1rem' }}>
          Simple, transparent pricing
        </h1>
        <p style={{ fontSize: '1.1rem', color: '#64748b', margin: '0 auto', maxWidth: 480 }}>
          Sign documents securely. No hidden fees. Cancel anytime.
        </p>
      </div>

      {/* Plans */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', maxWidth: 960, margin: '0 auto', padding: '0 1.5rem 4rem' }}>
        {plans.map(plan => (
          <div key={plan.name} style={{
            background: 'white',
            borderRadius: 16,
            border: plan.highlight ? `2px solid ${plan.color}` : '1px solid #e5e7eb',
            padding: '2rem',
            position: 'relative',
            boxShadow: plan.highlight ? '0 8px 32px rgba(37,99,235,0.12)' : '0 1px 4px rgba(0,0,0,0.04)',
          }}>

            {plan.highlight && (
              <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: plan.color, color: 'white', padding: '0.25rem 1rem', borderRadius: 20, fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                Most popular
              </div>
            )}

            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: plan.color, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {plan.name}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '2.4rem', fontWeight: 800, color: '#0f172a' }}>{plan.price}</span>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>/{plan.period}</span>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#64748b', margin: 0 }}>{plan.description}</p>
            </div>

            <button onClick={() => handleCta(plan.ctaAction)} style={{
              width: '100%', padding: '0.75rem', borderRadius: 10, border: plan.highlight ? 'none' : '1px solid #e5e7eb',
              background: plan.highlight ? plan.color : 'white',
              color: plan.highlight ? 'white' : '#374151',
              fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', marginBottom: '1.5rem',
            }}>
              {plan.cta}
            </button>

            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '1.25rem' }}>
              {plan.features.map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.6rem', fontSize: '0.85rem', color: '#374151' }}>
                  <span style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }}>✓</span>
                  {f}
                </div>
              ))}
              {plan.missing.map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.6rem', fontSize: '0.85rem', color: '#cbd5e1' }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}>—</span>
                  {f}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 1.5rem 4rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', textAlign: 'center', marginBottom: '2rem' }}>
          Frequently asked questions
        </h2>
        {[
          { q: 'Are signatures legally binding?', a: 'SecureSign uses RSA-PSS cryptographic signatures with full audit trails. For most business purposes in East Africa this is sufficient. For court-level legal matters, consult your attorney.' },
          { q: 'Do signers need an account?', a: 'No. Signers receive a unique link via email and can sign without creating an account. Only document senders need an account.' },
          { q: 'What file types are supported?', a: 'PDF files only, up to 10MB. We validate magic bytes to ensure the file is a genuine PDF.' },
          { q: 'Can I cancel anytime?', a: 'Yes. You can cancel your subscription at any time. Your account will remain on the paid plan until the end of the billing period.' },
        ].map(({ q, a }) => (
          <div key={q} style={{ marginBottom: '1.25rem', background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.25rem' }}>
            <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: '0.5rem', fontSize: '0.95rem' }}>{q}</div>
            <div style={{ color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>{a}</div>
          </div>
        ))}
      </div>

    </div>
  );
}
