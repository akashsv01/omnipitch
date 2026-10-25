import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, X } from 'lucide-react';
import type { Event, Moment, Player } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { METRIC_LABEL, RULE_LABEL, clockLabel, eventLabel, fmt, playerIndex, surname, teamTone } from '../lib/format';
import { DUR, EASE_DRAWER, EASE_OUT } from '../lib/motion';
import { Pitch, PitchLegend } from './Pitch';
import { RULE_ICON } from './MomentFeed';

const AUTHOR = {
  ai: 'The AI model (three roles) from this evidence only. Code then checked every number, name, event ID and claim (score, box, passes, defenders), and the API re-checks it before showing it.',
  fallback: 'A deterministic template from the metrics above. No model was involved.',
  fixture: 'A hand-authored test fixture.',
};
const MODE_LABEL = { fallback: 'Template', ai: 'AI-written, checked', fixture: 'Hand-authored fixture' };

/** What each rule detects, stated as its definition (why the system flagged it), not as an opinion. */
const WHY: Record<Moment['rule'], string> = {
  goal: 'A validated goal changes the score, so it is always a key moment.',
  chance: 'An on-target shot from 18 m or closer is the clearest sign of a scoring opportunity this data supports. There is no expected-goals model.',
  transition: 'The rule looks for a fast attack straight after a ball win: at least 35 m of forward progress, or a shot, within 12 s.',
  threat_gain: 'The rule flags the first pass in a possession that raises the illustrative threat-grid value by at least 0.1: a step towards a chance, not a chance itself.',
  pressing_change: 'A clear drop in PPDA between valid five-minute windows means the defending team allowed far fewer passes per defensive action.',
};

export function EvidenceDrawer({ moment, events, roster, audience, onClose, onReplay, reduced }: {
  moment: Moment; events: Event[]; roster: Player[]; audience: Audience; onClose: () => void; onReplay: (moment: Moment) => void; reduced: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const [other, setOther] = useState(false);
  const [step, setStep] = useState<string>();
  const people = playerIndex(roster);
  const evidence = events.filter(event => moment.evidence_ids.includes(event.event_id));
  const Icon = RULE_ICON[moment.rule];
  const facts = moment.facts as Record<string, any>;
  const primary = audience === 'fan' ? moment.insight.casual_text : moment.insight.analyst_text;
  const secondary = audience === 'fan' ? moment.insight.analyst_text : moment.insight.casual_text;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      // Modal: keep keyboard focus inside the drawer.
      const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button, [href], summary, [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter(el => !el.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  const slide = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { transform: 'translateX(100%)' }, animate: { transform: 'translateX(0%)' }, exit: { transform: 'translateX(100%)' } };
  return <>
    <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.drawer, ease: EASE_OUT }} />
    <motion.aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title" {...slide}
      transition={{ duration: DUR.drawer, ease: EASE_DRAWER }}>
      <div className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <div className="moment-meta">
            <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
            <span className="rule-tag"><Icon size={13} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
            <span className="mode-badge" data-mode={moment.insight.generation_mode}>{MODE_LABEL[moment.insight.generation_mode]}</span>
          </div>
          <h2 id="evidence-title">{moment.insight.headline}</h2>
        </div>
        <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close evidence"><X size={18} /></button>
      </div>
      <div className="drawer-body">
        <section className="drawer-section" aria-labelledby="ev-what">
          <h3 id="ev-what"><span className="step">1</span>What happened</h3>
          <p className="lead">{primary}</p>
          <button type="button" className="text-button quiet" aria-expanded={other} onClick={() => setOther(value => !value)} style={{ justifySelf: 'start' }}>
            {other ? 'Hide' : 'Show'} the {audience === 'fan' ? 'analyst' : 'fan'} explanation
          </button>
          {other && <div className="quote"><small>For {audience === 'fan' ? 'analysts' : 'fans'}</small>{secondary}</div>}
        </section>

        <section className="drawer-section" aria-labelledby="ev-why">
          <h3 id="ev-why"><span className="step">2</span>Why it matters</h3>
          <p style={{ color: 'var(--text-2)' }}>{WHY[moment.rule]}</p>
        </section>

        <section className="drawer-section" aria-labelledby="ev-values">
          <h3 id="ev-values"><span className="step">3</span>Key calculated values <span className="hint">Metrics behind it</span></h3>
          <dl className="value-grid">
            {moment.metrics.map(metric => <div key={metric.name}>
              <dt>{METRIC_LABEL[metric.name] ?? metric.name}</dt>
              <dd>{fmt(metric.value, Math.abs(metric.value) < 1 ? 3 : 2)}{metric.unit && <small>{metric.unit}</small>}</dd>
            </div>)}
          </dl>
        </section>

        <section className="drawer-section" aria-labelledby="ev-sequence">
          <h3 id="ev-sequence"><span className="step">4</span>Source action sequence <span className="hint">{evidence.length} recorded events</span></h3>
          <div className="pitch-wrap">
            <Pitch events={events} highlightIds={moment.evidence_ids} emphasisId={step} roster={roster} animate={!reduced} compact
              onSelect={event => setStep(current => current === event.event_id ? undefined : event.event_id)} />
          </div>
          <PitchLegend compact />
          <ol className="sequence">
            {evidence.map((event, index) => <li key={event.event_id}>
              <button type="button" aria-pressed={step === event.event_id} onClick={() => setStep(current => current === event.event_id ? undefined : event.event_id)}>
                <span className="n">{index + 1}</span>
                <i className="team-bar" style={{ background: teamTone(event.team_id) }} aria-hidden="true" />
                <span><b style={{ fontWeight: 600 }}>{eventLabel(event)}</b> · {surname(people.get(event.player_id ?? ''))} · {clockLabel(event.period, event.match_time_ms)}</span>
                <span className="mono" style={{ color: 'var(--text-3)' }}>{event.event_id}</span>
              </button>
            </li>)}
            {evidence.length < moment.evidence_ids.length && <li className="hint">Some cited events are outside the current replay position.</li>}
          </ol>
          <button type="button" className="button" style={{ justifySelf: 'start' }} onClick={() => onReplay(moment)}>
            <RotateCcw size={15} aria-hidden="true" />Replay this sequence from {clockLabel(moment.period, moment.match_time_ms)}
          </button>
        </section>

        <section className="drawer-section" aria-labelledby="ev-calc">
          <h3 id="ev-calc"><span className="step">5</span>Calculation and detection rule</h3>
          <Calculation moment={moment} facts={facts} />
        </section>

        <section className="drawer-section" aria-labelledby="ev-limits">
          <h3 id="ev-limits"><span className="step">6</span>Limitations and provenance</h3>
          <ul className="limitations">{moment.insight.limitations.map(item => <li key={item}>{item}</li>)}</ul>
          <details className="disclosure">
            <summary>Provenance and identifiers</summary>
            <div>
              <dl className="facts">
                <dt>Written by</dt><dd>{AUTHOR[moment.insight.generation_mode]}</dd>
                <dt>Moment</dt><dd className="mono">{moment.moment_id}</dd>
                <dt>Rule</dt><dd>{moment.rule} {moment.rule_version}</dd>
                <dt>Metric version</dt><dd>{moment.metric_version}</dd>
                <dt>Detected at</dt><dd>event {moment.source_sequence} (anchor {moment.anchor_sequence})</dd>
                <dt>Evidence IDs</dt><dd className="mono">{moment.evidence_ids.join(', ')}</dd>
                <dt>Coordinates</dt><dd>105 × 68 m fixed frame; metrics use the acting team's attacking frame</dd>
                <dt>Knowledge</dt><dd>{moment.insight.knowledge_source_ids.join(', ') || 'none'}</dd>
              </dl>
            </div>
          </details>
        </section>
      </div>
    </motion.aside>
  </>;
}

function Calculation({ moment, facts }: { moment: Moment; facts: Record<string, any> }) {
  let rows: [string, string][] = [];
  if (moment.rule === 'threat_gain') {
    rows = [
      ['Start cell → end cell', `(${facts.start_cell?.join(', ')}) → (${facts.end_cell?.join(', ')}) on a 16 × 12 grid`],
      ['Grid values', `${facts.start_value} → ${facts.end_value} (Δ ${fmt(facts.end_value - facts.start_value, 3)})`],
      ['Grid', `${facts.grid_version}; hand-designed, uncalibrated`],
      ['Entries', [facts.final_third_entry && 'final third', facts.box_entry && 'penalty box'].filter(Boolean).join(', ') || 'none'],
      ['Trigger', 'Δ ≥ 0.1, first qualifying pass per possession'],
    ];
  } else if (moment.rule === 'pressing_change') {
    const w = facts.window, p = facts.previous_window;
    rows = [
      ['Formula', 'opponent passes in zone ÷ defensive actions in zone'],
      ['This window', `${w.opponent_passes} ÷ ${w.defensive_actions} = ${w.value} (min ${w.start_ms / 60000}–${w.end_ms / 60000})`],
      ['Previous valid window', `${p.opponent_passes} ÷ ${p.defensive_actions} = ${p.value} (min ${p.start_ms / 60000}–${p.end_ms / 60000})`],
      ['Zone', facts.zone],
      ['Gates', '≥ 10 passes and ≥ 3 actions per window; drop to ≤ 60% of previous; 10-min cooldown'],
    ];
  } else if (moment.rule === 'transition') {
    rows = [['Turnover', facts.turnover_type], ['Ended in a shot', facts.ended_in_shot ? 'yes' : 'no'],
      ['Trigger', '≥ 35 m forward progress or a shot within 12 s of winning the ball']];
  } else if (moment.rule === 'goal') {
    rows = [['Score after goal', Object.entries(facts.score ?? {}).map(([team, goals]) => `${team} ${goals}`).join(', ')],
      ['Source', 'Validated shot event with is_goal = true']];
  } else if (moment.rule === 'chance') {
    rows = [['Outcome', facts.outcome], ['Trigger', 'On-target shot from 18 m or closer; no xG model']];
  }
  return <dl className="facts">
    {rows.map(([term, value]) => <div key={term} style={{ display: 'contents' }}><dt>{term}</dt><dd>{value}</dd></div>)}
    <div style={{ display: 'contents' }}><dt>Rule version</dt><dd>{moment.rule} {moment.rule_version} · {moment.metric_version}</dd></div>
  </dl>;
}
