import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Crosshair } from 'lucide-react';
import type { Event, ReplaySnapshot } from '../types/contracts';
import { t } from '../lib/i18n';
import { attackingFrame, goalDistance, passLength, type Direction } from '../lib/geometry';
import { clockLabel, fmt, playerIndex, teamTone } from '../lib/format';

type Outcome = 'goal' | 'saved' | 'blocked' | 'wide';
const outcomeOf = (shot: Event): Outcome => shot.is_goal ? 'goal' : shot.outcome === 'saved' ? 'saved' : shot.outcome === 'blocked' ? 'blocked' : 'wide';
const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: 'goal', label: 'Goal' }, { id: 'saved', label: 'Saved' }, { id: 'blocked', label: 'Blocked' }, { id: 'wide', label: 'Off target' },
];

/** One marker shape per outcome, so the outcome reads without colour (team is the colour). */
function Marker({ outcome, x, y, tone, size = 1 }: { outcome: Outcome; x: number; y: number; tone: string; size?: number }) {
  const r = (outcome === 'goal' ? 1.9 : 1.25) * size;
  if (outcome === 'goal') {
    const points = Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r;
      return `${(x + rr * Math.cos(a)).toFixed(2)},${(y + rr * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
    return <polygon points={points} fill={tone} stroke="var(--text)" strokeWidth={.25} />;
  }
  if (outcome === 'saved') return <circle cx={x} cy={y} r={r} fill={tone} stroke="var(--bg)" strokeWidth={.2} />;
  if (outcome === 'blocked') return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} fill={tone} stroke="var(--bg)" strokeWidth={.2} />;
  return <circle cx={x} cy={y} r={r} fill="none" stroke={tone} strokeWidth={.45} />;
}

function Toggle<T extends string | number>({ value, options, onChange, label, id }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string; id: string }) {
  return <div className="segmented small" role="group" aria-label={label}>
    {options.map(option => <button key={String(option.id)} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>
      {value === option.id && <motion.span layoutId={`${id}-thumb`} className="thumb" />}{option.label}</button>)}
  </div>;
}

/** The shot map: every shot drawn attacking the right-hand goal (each team's own frame), with outcome markers and a
 * legend, team and half filters, goals emphasised, and one selected shot linked between the table, the marker and
 * the main pitch. Shot quality is not modelled; lines show the recorded start and end points only. */
export function ShotMap({ replay, onSelectEvent }: { replay: ReplaySnapshot; onSelectEvent: (event: Event) => void }) {
  const [team, setTeam] = useState<'all' | 'harbor' | 'vale'>('all');
  const [half, setHalf] = useState<'all' | 1 | 2>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const all = useMemo(() => replay.events.filter(event => event.type === 'shot' && event.start), [replay.events]);
  const shots = all.filter(shot => (team === 'all' || shot.team_id === team) && (half === 'all' || shot.period === half));
  // Newest first, by exact period and match time (stoppage time stays in its own half).
  const ordered = [...shots].sort((a, b) => b.period - a.period || b.match_time_ms - a.match_time_ms || b.sequence - a.sequence);
  const selected = shots.find(shot => shot.event_id === selectedId) ?? null;
  const frame = (shot: Event, point: { x: number; y: number }) => attackingFrame(point, (shot.attacking_direction ?? 'positive_x') as Direction);
  const choose = (shot: Event) => setSelectedId(current => current === shot.event_id ? null : shot.event_id);
  const goals = shots.filter(shot => shot.is_goal).length;


  return <div className="shot-map">
    <div className="shot-filters">
      <Toggle id="shot-team" label={t('Team filter')} value={team} onChange={setTeam}
        options={[{ id: 'all', label: t('Both teams') }, { id: 'harbor', label: 'Harbor' }, { id: 'vale', label: 'Vale' }]} />
      <Toggle id="shot-half" label={t('Half')} value={half} onChange={setHalf}
        options={[{ id: 'all', label: t('Whole match') }, { id: 1, label: t('First half') }, { id: 2, label: t('Second half') }]} />
    </div>
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <figure className="shot-figure">
        <svg viewBox="52 -3 56 74" role="img" aria-label={`${t('Shot map')}: ${shots.length} ${t('shots')}, ${goals} ${t(goals === 1 ? 'goal' : 'goals')}. ${t('All shots are drawn attacking the right-hand goal.')}`}>
          <rect x={52.5} y={0} width={52.5} height={68} fill="var(--pitch, #1d3a2c)" stroke="var(--pitch-line, rgba(255,255,255,.55))" strokeWidth={.3} />
          <g fill="none" stroke="var(--pitch-line, rgba(255,255,255,.55))" strokeWidth={.3}>
            <rect x={88.5} y={13.84} width={16.5} height={40.32} />
            <rect x={99.5} y={24.84} width={5.5} height={18.32} />
            <rect x={105} y={30.34} width={1.6} height={7.32} />
            <path d="M 52.5 24.85 A 9.15 9.15 0 0 1 52.5 43.15" />
            <path d="M 88.5 26.7 A 9.15 9.15 0 0 0 88.5 41.3" />
          </g>
          {shots.map(shot => {
            const start = frame(shot, shot.start!), end = shot.end ? frame(shot, shot.end) : null;
            const dim = selected ? selected !== shot : !shot.is_goal;
            return <g key={shot.event_id} opacity={dim ? (selected ? .18 : .55) : 1} style={{ cursor: 'pointer' }}
              onClick={() => choose(shot)} role="button" tabIndex={0} aria-pressed={selected === shot}
              aria-label={`${clockLabel(shot.period, shot.match_time_ms)} ${people.get(shot.player_id ?? '')?.name ?? ''}: ${t(OUTCOMES.find(o => o.id === outcomeOf(shot))!.label)}`}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(shot); } }}>
              {end && <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={teamTone(shot.team_id)} strokeWidth={selected === shot ? .55 : .3}
                strokeDasharray={outcomeOf(shot) === 'wide' ? '1 .8' : undefined} />}
              <Marker outcome={outcomeOf(shot)} x={start.x} y={start.y} tone={teamTone(shot.team_id)} size={selected === shot ? 1.35 : 1} />
            </g>;
          })}
        </svg>
        <figcaption className="shot-legend">
          {OUTCOMES.map(o => <span key={o.id}><svg viewBox="-2.5 -2.5 5 5" width="14" height="14" aria-hidden="true"><Marker outcome={o.id} x={0} y={0} tone="var(--text-2)" /></svg>{t(o.label)}</span>)}
          <span><i className="team-bar" style={{ background: 'var(--harbor)' }} />Harbor</span>
          <span><i className="team-bar" style={{ background: 'var(--vale)' }} />Vale</span>
        </figcaption>
      </figure>
      <div className="card">
        <h3>{shots.length} {t(shots.length === 1 ? 'shot' : 'shots')}{goals ? ` · ${goals} ${t(goals === 1 ? 'goal' : 'goals')}` : ''}</h3>
        {selected && <div className="shot-detail" aria-live="polite">
          <p><b>{clockLabel(selected.period, selected.match_time_ms)}</b> {people.get(selected.player_id ?? '')?.name} · {t(OUTCOMES.find(o => o.id === outcomeOf(selected))!.label)}</p>
          <p className="hint">{t('Distance to goal')} {fmt(goalDistance(selected.start!, (selected.attacking_direction ?? 'positive_x') as Direction), 1)} m
            {selected.end ? ` · ${t('Recorded shot path')} ${fmt(passLength(selected.start!, selected.end), 1)} m` : ''}</p>
          <button type="button" className="button small" onClick={() => onSelectEvent(selected)}><Crosshair size={14} aria-hidden="true" />{t('Show on the main pitch')}</button>
        </div>}
        {shots.length === 0 ? <p className="hint">{t(all.length ? 'No shots match these filters.' : 'No shots yet.')}</p>
          : <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}><table>
            <thead><tr><th>{t('Min')}</th><th>{t('Player')}</th><th>{t('Outcome')}</th></tr></thead>
            <tbody>{ordered.map(shot => <tr key={shot.event_id} aria-selected={selected === shot} data-goal={shot.is_goal || undefined}
              tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => choose(shot)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(shot); } }}>
              <td className="num">{clockLabel(shot.period, shot.match_time_ms)}</td>
              <td><span className="player-cell"><i className="team-bar" style={{ background: teamTone(shot.team_id) }} />{people.get(shot.player_id ?? '')?.name ?? '–'}</span></td>
              <td>{t(OUTCOMES.find(o => o.id === outcomeOf(shot))!.label)}</td>
            </tr>)}</tbody>
          </table></div>}
        <p className="hint">{t('All shots are drawn attacking the right-hand goal.')} {t('Shot quality is not modelled. Lines show recorded start and end points.')}</p>
      </div>
    </div>
  </div>;
}
