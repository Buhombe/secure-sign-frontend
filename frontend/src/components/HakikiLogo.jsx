/**
 * HakikiLogo.jsx
 * SVG recreation of the HakikiSign brand icon.
 * Props: size (number, default 36), showText (bool), textSize (string)
 */
export default function HakikiLogo({ size = 36, showText = false, textSize = '1rem', style = {} }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.25, ...style }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        <defs>
          <linearGradient id="hGrad" x1="20%" y1="0%" x2="80%" y2="100%">
            <stop offset="0%" stopColor="#4f9cf9" />
            <stop offset="100%" stopColor="#1a6fd4" />
          </linearGradient>
          <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1e3a7b" />
            <stop offset="100%" stopColor="#0f2461" />
          </linearGradient>
        </defs>

        {/* Background rounded square */}
        <rect width="100" height="100" rx="22" fill="url(#bgGrad)" />

        {/* Document outline — top right */}
        <path
          d="M58 12 L76 12 L84 22 L84 46 L58 46 Z"
          fill="none"
          stroke="rgba(255,255,255,0.85)"
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <path
          d="M76 12 L76 22 L84 22"
          fill="none"
          stroke="rgba(255,255,255,0.85)"
          strokeWidth="4"
          strokeLinejoin="round"
        />

        {/* H letter */}
        <text
          x="18"
          y="74"
          fontFamily="'Arial Black', Arial, sans-serif"
          fontWeight="900"
          fontSize="58"
          fill="url(#hGrad)"
        >H</text>

        {/* Pen nib — bottom right */}
        <g transform="translate(60, 58)">
          <path
            d="M0 22 L14 0 L22 6 L8 28 Z"
            fill="white"
          />
          <path
            d="M14 0 L22 6 L18 10 L10 4 Z"
            fill="rgba(255,255,255,0.6)"
          />
          <circle cx="4" cy="26" r="2.5" fill="rgba(255,255,255,0.7)" />
        </g>

        {/* Checkmark — bottom left of H */}
        <path
          d="M22 78 L30 88 L46 66"
          stroke="white"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>

      {showText && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span style={{ fontWeight: 800, fontSize: textSize, color: '#0f172a', letterSpacing: '-0.02em' }}>
            HakikiSign
          </span>
          <span style={{ fontSize: `calc(${textSize} * 0.55)`, fontWeight: 700, color: '#1a6fd4', letterSpacing: '0.12em' }}>
            AFRICA
          </span>
        </div>
      )}
    </div>
  );
}
