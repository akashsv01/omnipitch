import { useMemo, useState } from 'react';
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
  return <section className="trust-bar" aria-labelledby="trust-title">
    <div className="trust-head">
      <h2 id="trust-title"><ShieldCheck size={15} aria-hidden="true" />{tr('Checked before it is shown')}</h2>
      <button type="button" className="text-button" aria-expanded={open} aria-controls="trust-how" onClick={() => setOpen(value => !value)}>
        {tr('How we check')}<ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
    </div>
    <dl className="trust-stats">
      {stats.map(([value, label, mode]) => <div key={label} data-mode={mode}><dt>{label}</dt><dd className="num">{value.toLocaleString()}</dd></div>)}
    </dl>
    {open && <ol className="trust-how" id="trust-how">{STEPS.map(step => <li key={step}>{tr(step)}</li>)}</ol>}
  </section>;
}
