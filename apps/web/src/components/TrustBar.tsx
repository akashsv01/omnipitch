import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { ReplaySnapshot } from '../types/contracts';
import { generation } from '../lib/evidence';
import { useTr } from '../lib/i18n';

const STEPS = [
  'Every number is computed in code from the recorded events; the AI never calculates.',
  "A moment exists only when a rule's threshold is met, and its evidence is frozen when it is detected.",
  "AI text is checked in code before it is shown: every number, player, team, event ID and claim (score, box, direction) must match the moment's evidence.",
  'Text that fails any check is rejected and the rule-based text stays on screen, labelled as such.',
  "Recaps are marked Reconciled only after the period is checked against the pipeline's own records.",
];

/** The checks behind the room, counted from the snapshot itself: moments, the figures they carry, the events they
 * cite, and how each explanation was produced (the same status the moment cards show). Nothing here is estimated. */
export function TrustBar({ replay }: { replay: ReplaySnapshot }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const aiMode = replay.insights.status === 'off' ? 'off' : replay.insights.mode;
  const counts = useMemo(() => {
    const cited = new Set<string>();
    let figures = 0, ai = 0, rejected = 0, pending = 0;
    for (const moment of replay.moments) {
      figures += moment.metrics.length;
      moment.evidence_ids.forEach(id => cited.add(id));
      const gen = generation(moment, aiMode);
      if (gen === 'ai') ai += 1; else if (gen === 'rejected') rejected += 1; else if (gen === 'pending') pending += 1;
    }
    return { moments: replay.moments.length, figures, cited: cited.size, ai, rejected, pending };
  }, [replay.moments, aiMode]);
  const stats: [number, string, string?][] = [
    [counts.moments, tr('moments, each from recorded events')],
    [counts.figures, tr('figures computed in code, not by AI')],
    [counts.cited, tr('source events cited')],
    ...(aiMode === 'off'
      ? [[counts.moments, tr('rule-based explanations')]] as [number, string, string?][]
      : [[counts.ai, tr('AI-written and checked'), 'ai'], [counts.rejected, tr('AI texts rejected, rule-based kept')],
        ...(counts.pending ? [[counts.pending, tr('awaiting AI')]] : [])] as [number, string, string?][]),
  ];
  // One line in the score strip; the counts and the method open as a panel on demand, so it never pushes the pitch down.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, [open]);
  return <div className="trust" ref={box}>
    <button type="button" className="trust-pill" aria-expanded={open} aria-controls="trust-panel" onClick={() => setOpen(value => !value)}
      aria-label={`${tr('Checked before it is shown')}: ${counts.moments} ${tr('moments')}, ${counts.figures} ${tr('figures')}`} title={tr('How we check')}>
      <ShieldCheck size={15} aria-hidden="true" />
      <span className="trust-word">{tr('Checked')}</span>
      <span className="trust-summary"><b className="num">{counts.moments}</b> {tr('moments')} · <b className="num">{counts.figures}</b> {tr('figures')}
        {aiMode !== 'off' && <> · <b className="num" data-mode="ai">{counts.ai}</b> {tr('AI-checked')}</>}</span>
      <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
    </button>
    {open && <section className="trust-panel" id="trust-panel" aria-labelledby="trust-title">
      <h2 id="trust-title"><ShieldCheck size={15} aria-hidden="true" />{tr('Checked before it is shown')}</h2>
      <dl className="trust-stats">
        {stats.map(([value, label, mode]) => <div key={label} data-mode={mode}><dt>{label}</dt><dd className="num">{value.toLocaleString()}</dd></div>)}
      </dl>
      <h3>{tr('How we check')}</h3>
      <ol className="trust-how">{STEPS.map(step => <li key={step}>{tr(step)}</li>)}</ol>
    </section>}
  </div>;
}
