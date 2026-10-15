/** Fictional club marks drawn for OmniPitch; not based on any real club. */
export function Crest({ team, className = 'crest' }: { team: string; className?: string }) {
  if (team === 'vale') {
    return <svg className={className} viewBox="0 0 52 52" aria-hidden="true">
      <path d="M26 3 46 10v15c0 12-8.5 20.5-20 24C14.5 45.5 6 37 6 25V10Z" fill="#16323d" stroke="var(--vale)" strokeWidth="2" />
      <path d="M15 19c3-4 8-4 11 0 3-4 8-4 11 0" fill="none" stroke="var(--vale)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="19.5" cy="25" r="4.6" fill="var(--vale)" /><circle cx="32.5" cy="25" r="4.6" fill="var(--vale)" />
      <circle cx="19.5" cy="25" r="1.8" fill="#16323d" /><circle cx="32.5" cy="25" r="1.8" fill="#16323d" />
      <path d="M23.5 31 26 35l2.5-4" fill="none" stroke="var(--vale)" strokeWidth="2" strokeLinejoin="round" />
    </svg>;
  }
  return <svg className={className} viewBox="0 0 52 52" aria-hidden="true">
    <path d="M26 3 46 10v15c0 12-8.5 20.5-20 24C14.5 45.5 6 37 6 25V10Z" fill="#3a1f1a" stroke="var(--harbor)" strokeWidth="2" />
    <path d="M12 36c6-4 12-10 17-19" fill="none" stroke="var(--harbor)" strokeWidth="2" strokeLinecap="round" opacity=".55" />
    <path d="M15 38c7-4 13-10 17-17" fill="none" stroke="var(--harbor)" strokeWidth="2" strokeLinecap="round" opacity=".8" />
    <circle cx="33.5" cy="18.5" r="6.5" fill="var(--harbor)" />
    <circle cx="35.5" cy="16.5" r="2" fill="#ffd3c6" />
  </svg>;
}

export function BrandMark() {
  return <svg viewBox="0 0 34 34" aria-hidden="true">
    <rect width="34" height="34" rx="10" fill="var(--grass)" />
    <rect x="5" y="7" width="24" height="20" rx="2" fill="none" stroke="var(--chalk)" strokeWidth="1.4" opacity=".85" />
    <path d="M17 7v20" stroke="var(--chalk)" strokeWidth="1.4" opacity=".85" />
    <circle cx="17" cy="17" r="4" fill="none" stroke="var(--chalk)" strokeWidth="1.4" opacity=".85" />
    <path d="M9 22 15 14l5 4 6-7" fill="none" stroke="var(--flood)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="26" cy="11" r="2.2" fill="var(--flood)" />
  </svg>;
}
