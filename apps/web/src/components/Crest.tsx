import { useId, useRef } from 'react';

/** Fictional club marks drawn for OmniPitch; not based on any real club. Layered for depth: a dark base,
 * the coloured rim, an inner bevel highlight and the emblem. Static SVG; no animation of its own. */
export function CrestMark({ team }: { team: string }) {
  const id = useId();
  const vale = team === 'vale';
  const tone = vale ? 'var(--vale)' : 'var(--harbor)';
  const fill = vale ? '#123039' : '#3a1d18';
  const shield = 'M26 3 46 10v15c0 12-8.5 20.5-20 24C14.5 45.5 6 37 6 25V10Z';
  return <svg viewBox="0 0 52 52" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-bevel`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity=".22" />
        <stop offset=".45" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity=".28" />
      </linearGradient>
    </defs>
    <path d={shield} transform="translate(0 1.5)" fill="#000" opacity=".35" />
    <path d={shield} fill={fill} stroke={tone} strokeWidth="2.2" />
    <path d="M26 7.5 42 13v12c0 9.6-6.8 16.4-16 19.3C16.8 41.4 10 34.6 10 25V13Z" fill="none" stroke={tone} strokeOpacity=".28" strokeWidth="1" />
    {vale ? <g>
      <path d="M15 19c3-4 8-4 11 0 3-4 8-4 11 0" fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="19.5" cy="25" r="4.6" fill={tone} /><circle cx="32.5" cy="25" r="4.6" fill={tone} />
      <circle cx="19.5" cy="25" r="1.8" fill={fill} /><circle cx="32.5" cy="25" r="1.8" fill={fill} />
      <path d="M23.5 31 26 35l2.5-4" fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" />
    </g> : <g>
      <path d="M12 36c6-4 12-10 17-19" fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" opacity=".55" />
      <path d="M15 38c7-4 13-10 17-17" fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" opacity=".8" />
      <circle cx="33.5" cy="18.5" r="6.5" fill={tone} />
      <circle cx="35.5" cy="16.5" r="2" fill="#ffd3c6" />
    </g>}
    <path d={shield} fill={`url(#${id}-bevel)`} />
  </svg>;
}

/** Crest with a short entrance when the match changes (key it by run) and an optional, tiny pointer tilt.
 * The tilt only exists for fine pointers without reduced motion and only moves the crest itself. */
export function Crest({ team, tilt = false, className = 'crest' }: { team: string; tilt?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const allow = () => tilt && typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('[data-motion="reduced"]');
  return <span ref={ref} className={`${className} crest-in`}
    onPointerMove={event => {
      if (!allow() || !ref.current) return;
      const box = ref.current.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5, y = (event.clientY - box.top) / box.height - .5;
      ref.current.style.transform = `perspective(200px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 10).toFixed(2)}deg)`;
    }}
    onPointerLeave={() => { if (ref.current) ref.current.style.transform = ''; }}>
    <CrestMark team={team} />
  </span>;
}

/** The OmniPitch pitch-and-arrow mark, as introduced in commit 3ada323: a pitch outline with a rising
 * attacking arrow ending at the ball. Fixed colours so it reads the same on the ivory landing and the dark
 * match room; the hairline edge keeps the tile's shape visible against dark backgrounds. */
export function BrandMark() {
  return <svg viewBox="0 0 34 34" aria-hidden="true">
    <rect width="34" height="34" rx="10" fill="#1e4a38" />
    <rect x=".5" y=".5" width="33" height="33" rx="9.5" fill="none" stroke="#f3f3ea" strokeOpacity=".16" />
    <rect x="5" y="7" width="24" height="20" rx="2" fill="none" stroke="#eaf0ea" strokeWidth="1.4" opacity=".85" />
    <path d="M17 7v20" stroke="#eaf0ea" strokeWidth="1.4" opacity=".85" />
    <circle cx="17" cy="17" r="4" fill="none" stroke="#eaf0ea" strokeWidth="1.4" opacity=".85" />
    <path d="M9 22 15 14l5 4 6-7" fill="none" stroke="#f2cc62" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="26" cy="11" r="2.2" fill="#f2cc62" />
  </svg>;
}

/** Logo and wordmark, top left on every route. Links home; plain clicks navigate in-app, modified clicks
 * (new tab, etc.) keep normal link behaviour. */
export function Brand({ onNavigate, tagline }: { onNavigate?: () => void; tagline?: string }) {
  return <a className="brand" href="/" aria-label="OmniPitch home"
    onClick={event => {
      if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      onNavigate();
    }}>
    <span className="brand-mark"><BrandMark /></span>
    <b className="brand-word">OmniPitch</b>
    {tagline && <span className="brand-tag">{tagline}</span>}
  </a>;
}
