import { useMemo } from 'react';
import { Gauge, X } from 'lucide-react';
import type { Moment, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, clockLabel, fmt, playerIndex, teamTone } from '../lib/format';
import { FOCUS, focusDef, focusView, type FocusMetric } from '../lib/focus';

/** Choose one metric and the room centres on it: both teams now, a value per five minutes, who leads it and the
 * moments it produced. Choosing nothing keeps the room as it was. */
export function MetricFocus({ replay, audience, metric, onMetric, onChoose }: {
  replay: ReplaySnapshot; audience: Audience; metric: FocusMetric | null;
  onMetric: (metric: FocusMetric | null) => void; onChoose: (moment: Moment) => void;
}) {
  return <section className="metric-focus" aria-labelledby="focus-title">
    <div className="focus-bar">
      <h2 id="focus-title"><Gauge size={15} aria-hidden="true" />Metric focus</h2>
      <div className="filter-row" role="group" aria-label="Follow one metric">
        {FOCUS.map(f => <button key={f.id} type="button" className="chip" aria-pressed={metric === f.id} onClick={() => onMetric(metric === f.id ? null : f.id)}>{f.label}</button>)}
      </div>
      {metric && <button type="button" className="icon-button" aria-label="Stop following this metric" onClick={() => onMetric(null)}><X size={15} /></button>}
    </div>
    {metric && <FocusPanel replay={replay} audience={audience} metric={metric} onChoose={onChoose} />}
  </section>;
}

function FocusPanel({ replay, audience, metric, onChoose }: { replay: ReplaySnapshot; audience: Audience; metric: FocusMetric; onChoose: (moment: Moment) => void }) {
  const def = focusDef(metric);
  const view = useMemo(() => focusView(metric, replay), [metric, replay]);
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const teams = [replay.state.home_team, replay.state.away_team];
  const values = teams.flatMap(t => view.slots[t.id]).filter((v): v is number => v !== null);
  const max = Math.max(def.lowerBetter ? 12 : 0.0001, ...values);
  const width = 1200, height = 190, pad = 40, slot = (width - pad * 2) / 20;
  const x = (i: number) => pad + (i + .5) * slot, y = (v: number) => height - pad - v / max * (height - pad * 2);
  const leaderTeam = (a: number | null, b: number | null) => a === null || b === null || a === b ? null : (a > b) !== !!def.lowerBetter ? 0 : 1;
  const lead = leaderTeam(view.current[teams[0].id], view.current[teams[1].id]);
  return <div className="focus-panel tab-fade">
    <div className="focus-now">
      {teams.map((team, i) => <div key={team.id} className="focus-team" data-lead={lead === i}>
        <span style={{ color: teamTone(team.id) }}>{team.name}</span>
        <b className="num">{view.current[team.id] === null ? '–' : fmt(view.current[team.id], def.digits)}<small>{def.unit}</small></b>
      </div>)}
      <p className="focus-def">{audience === 'analyst' ? def.analyst : def.fan}</p>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${def.label} by five-minute slot for both teams`}>
      {[.5, 1].map(f => <g key={f}>
        <line x1={pad} x2={width - pad} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" strokeDasharray="2 6" />
        <text x={pad - 8} y={y(max * f) + 4} textAnchor="end" fontSize="12" fill="var(--text-3)">{fmt(max * f, def.digits)}</text>
      </g>)}
      <line x1={width / 2} x2={width / 2} y1="6" y2={height - pad} stroke="var(--line-2)" strokeDasharray="2 4" />
      <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="var(--line-2)" />
      {teams.map(team => {
        const points = view.slots[team.id].map((v, i) => v === null ? null : [x(i), y(v)] as const);
        return <g key={team.id}>
          {[0, 10].map(start => {
            const line = points.slice(start, start + 10).filter((p): p is readonly [number, number] => p !== null);
            return line.length > 1 ? <polyline key={start} fill="none" stroke={teamTone(team.id)} strokeWidth="2.2" points={line.map(p => p.join(',')).join(' ')} /> : null;
          })}
          {points.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r="3.5" fill={teamTone(team.id)}><title>{`${team.name}, slot ${i + 1}: ${fmt(view.slots[team.id][i], def.digits)}${def.unit}`}</title></circle>)}
        </g>;
      })}
      <text x={pad} y={height - 14} fontSize="12" fill="var(--text-3)">Kick-off</text>
      <text x={width / 2 + 6} y={height - 14} fontSize="12" fill="var(--text-3)">Half-time</text>
      <text x={width - pad} y={height - 14} textAnchor="end" fontSize="12" fill="var(--text-3)">Full-time</text>
    </svg>
    <div className="grid-2">
      <div>
        <h3 className="focus-sub">Leaders · {view.leaderLabel}</h3>
        {view.leaders.length ? <ol className="focus-list">{view.leaders.map(l => <li key={l.player_id}>
          <span className="shirt" style={{ background: teamTone(l.team_id) }}>{people.get(l.player_id)?.shirt}</span>
          <span>{people.get(l.player_id)?.name ?? l.player_id}</span><b className="num">{fmt(l.value, def.digits)}</b>
        </li>)}</ol> : <p className="hint">Not enough events yet.</p>}
      </div>
      <div>
        <h3 className="focus-sub">Moments it produced</h3>
        {view.moments.length ? <ol className="catch-up-list">{view.moments.map(m => <li key={m.moment_id}>
          <button type="button" className="moment-row" style={{ ['--tone' as string]: teamTone(m.team_id) }} onClick={() => onChoose(m)}>
            <span className="minute">{clockLabel(m.period, m.match_time_ms)}</span><span className="title">{m.insight.headline}</span><span className="sub">{RULE_LABEL[m.rule]}</span>
          </button></li>)}</ol>
          : <p className="hint">{def.rules.length ? 'None yet.' : 'No moment rule uses this metric; it describes the play rather than triggering moments.'}</p>}
      </div>
    </div>
  </div>;
}
