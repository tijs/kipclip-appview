import { HeartIcon } from "./HeartIcon.tsx";

/**
 * Small "Supporter" pill shown in the UserMenu when the logged-in user is
 * a kipclip supporter on atprotofans.com. Teal to read as "status," not promo.
 */
export function SupporterBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white ${className}`}
      style={{ backgroundColor: "var(--teal)" }}
      title="Thanks for supporting kipclip"
      aria-label="Kipclip supporter"
    >
      <HeartIcon className="w-3 h-3" />
      Supporter
    </span>
  );
}

/**
 * Larger celebration badge for the Settings > Supporter tab. Illustrated,
 * warm orange/cream disc with a coral heart — feels rewarding without
 * piling more coral onto coral.
 */
export function SupporterCelebrationBadge(
  { size = 112, className = "" }: { size?: number; className?: string },
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={className}
      role="img"
      aria-label="Kipclip supporter"
    >
      <defs>
        <radialGradient id="kc-badge-bg" cx="50%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#fbd9a8" />
          <stop offset="60%" stopColor="#f4a261" />
          <stop offset="100%" stopColor="#d98744" />
        </radialGradient>
        <linearGradient id="kc-badge-ring" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.2" />
        </linearGradient>
      </defs>
      {/* outer cream ring */}
      <circle cx="64" cy="64" r="62" fill="#f5f1e8" />
      <circle
        cx="64"
        cy="64"
        r="60"
        fill="none"
        stroke="url(#kc-badge-ring)"
        strokeWidth="2"
      />
      {/* warm orange disc */}
      <circle cx="64" cy="64" r="54" fill="url(#kc-badge-bg)" />
      {/* sun rays */}
      <g
        stroke="#ffffff"
        strokeOpacity="0.45"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <line x1="64" y1="18" x2="64" y2="26" />
        <line x1="64" y1="102" x2="64" y2="110" />
        <line x1="18" y1="64" x2="26" y2="64" />
        <line x1="102" y1="64" x2="110" y2="64" />
        <line x1="30" y1="30" x2="36" y2="36" />
        <line x1="92" y1="92" x2="98" y2="98" />
        <line x1="30" y1="98" x2="36" y2="92" />
        <line x1="92" y1="36" x2="98" y2="30" />
      </g>
      {/* coral heart */}
      <path
        d="M64 92l-2.6-2.4C48.4 78 40 70.3 40 60.8 40 53.2 45.9 47 53.6 47c4.3 0 8.4 2 11 5.2C67.3 49 71.4 47 75.6 47 83.3 47 89 53.2 89 60.8c0 9.5-8.4 17.2-21.4 28.8L64 92z"
        fill="#e66456"
      />
      {/* highlight */}
      <ellipse
        cx="57"
        cy="60"
        rx="4"
        ry="2.5"
        fill="#ffffff"
        fillOpacity="0.55"
      />
    </svg>
  );
}
