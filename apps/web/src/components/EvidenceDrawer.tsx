import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Bot, X } from 'lucide-react';
import type { Event, Moment, Player } from '../types/contracts';
import { METRIC_LABEL, RULE_LABEL, clockLabel, eventLabel, fmt, playerIndex, surname, teamTone } from '../lib/format';
import { Pitch } from './Pitch';
import { RULE_ICON } from './MomentFeed';

const MODE_LABEL = { fallback: 'Deterministic template', ai: 'AI generated, validated', fixture: 'Hand-authored fixture' };

export function EvidenceDrawer({ moment, events, roster, onClose, onSelectEvent, reduced }: {
  moment: Moment; events: Event[]; roster: Player[]; onClose: () => void; onSelectEvent: (event: Event) => void; reduced: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const people = playerIndex(roster);
  const evidence = events.filter(event => moment.evidence_ids.includes(event.event_id));
  const Icon = RULE_ICON[moment.rule];
  const facts = moment.facts as Record<string, any>;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  return <>
    <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
    <motion.aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title"
      initial={reduced ? { opacity: 0 } : { x: '100%' }} animate={reduced ? { opacity: 1 } : { x: 0 }} exit={reduced ? { opacity: 0 } : { x: '100%' }}
      transition={{ type: 'spring', stiffness: 380, damping: 40 }}>
      <div className="drawer-head">
        <div>
          <div className="moment-meta">
            <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
            <span className="rule-tag"><Icon size={13} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
            <span className="mode-badge"><Bot size={13} aria-hidden="true" />{MODE_LABEL[moment.insight.generation_mode]}</span>
          </div>
          <h2 id="evidence-title">{moment.insight.headline}</h2>
        </div>
        <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close evidence"><X size={18} /></button>
      </div>
      <div className="drawer-body">
        <div className="pitch-wrap" style={{ margin: 0 }}>
          <Pitch events={events} highlightIds={moment.evidence_ids} roster={roster} onSelect={onSelectEvent} animate={!reduced} compact />
        </div>
        <section className="drawer-section">
          <h3>What the system says</h3>
          <div className="quote"><small>For fans</small>{moment.insight.casual_text}</div>
          <div className="quote"><small>For analysts</small>{moment.insight.analyst_text}</div>
        </section>
        <section className="drawer-section">
          <h3>Metrics behind it</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Metric</th><th className="num">Value</th><th>Unit</th></tr></thead>
            <tbody>{moment.metrics.map(metric => <tr key={metric.name}>
              <td>{METRIC_LABEL[metric.name] ?? metric.name}</td><td className="num">{fmt(metric.value, Math.abs(metric.value) < 1 ? 3 : 2)}</td><td>{metric.unit}</td>
            </tr>)}</tbody>
          </table></div>
        </section>
        <Calculation moment={moment} facts={facts} />
        <section className="drawer-section">
          <h3>Source events ({evidence.length})</h3>
          <ul className="evidence-list">
            {evidence.map(event => <li key={event.event_id}>
              <button type="button" onClick={() => onSelectEvent(event)}>
                <i className="team-bar" style={{ background: teamTone(event.team_id) }} />
                <span><b style={{ fontWeight: 600 }}>{eventLabel(event)}</b> · {surname(people.get(event.player_id ?? ''))} · {clockLabel(event.period, event.match_time_ms)}</span>
                <span className="mono" style={{ color: 'var(--chalk-faint)' }}>{event.event_id}</span>
              </button>
            </li>)}
            {evidence.length < moment.evidence_ids.length && <li className="hint">Some cited events are outside the current replay position.</li>}
          </ul>
        </section>
        <section className="drawer-section">
          <h3>Limitations</h3>
          <ul className="limitations">{moment.insight.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="drawer-section">
          <h3>Provenance</h3>
          <dl className="facts">
            <dt>Moment</dt><dd className="mono">{moment.moment_id}</dd>
            <dt>Rule</dt><dd>{moment.rule} {moment.rule_version}</dd>
            <dt>Metric version</dt><dd>{moment.metric_version}</dd>
            <dt>Detected at</dt><dd>event {moment.source_sequence} (anchor {moment.anchor_sequence})</dd>
            <dt>Coordinates</dt><dd>105 × 68 m fixed frame; metrics use the acting team's attacking frame</dd>
            <dt>Knowledge</dt><dd>{moment.insight.knowledge_source_ids.join(', ') || 'none'}</dd>
          </dl>
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
  return <section className="drawer-section">
    <h3>Calculation</h3>
    <dl className="facts">{rows.map(([term, value]) => <div key={term} style={{ display: 'contents' }}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
