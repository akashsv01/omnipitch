import { useMemo } from 'react';
import { Info } from 'lucide-react';
import type { Event, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { clockLabel, fmt, playerIndex, surname, teamTone } from '../lib/format';
import { PASSING_VERSION, passingSummary, type Band } from '../lib/passing';

const BANDS: { id: Band; label: string; range: string }[] = [
  { id: 'easy', label: 'Easy', range: '0–29' }, { id: 'medium', label: 'Medium', range: '30–54' }, { id: 'hard', label: 'Hard', range: '55–100' },
];

/** Pass difficulty by band and speed of attack, per team, plus the hardest completed passes so far. */
export function PassingPanel({ replay, audience, onSelectEvent }: { replay: ReplaySnapshot; audience: Audience; onSelectEvent: (event: Event) => void }) {
  const teams = [replay.state.home_team, replay.state.away_team];
  const summary = useMemo(() => passingSummary(replay.events, teams.map(team => team.id)), [replay.events]); // eslint-disable-line react-hooks/exhaustive-deps
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const analyst = audience === 'analyst';
  if (!summary.ratings.length) return <p className="hint">No passes yet.</p>;
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="grid-2">
      {teams.map(team => {
        const stats = summary.teams[team.id];
        return <div className="card passing-card" key={team.id}>
          <h3 style={{ color: teamTone(team.id) }}>{team.name}</h3>
          <div className="stat-pair">
            <div className="stat"><b>{fmt(stats.meanDifficulty, 0)}</b><span>average pass difficulty (0–100)</span></div>
            <div className="stat"><b>{stats.medianAttackSpeed === null ? '–' : fmt(stats.medianAttackSpeed, 1)}<small> m/s</small></b><span>typical speed of attack</span></div>
          </div>
          <table className="band-table" aria-label={`${team.name} passes by difficulty`}>
            <thead><tr><th>Difficulty</th><th className="num">Passes</th><th className="num">Completed</th><th aria-hidden="true" /></tr></thead>
            <tbody>{BANDS.map(b => {
              const row = stats.bands[b.id];
              return <tr key={b.id} data-band={b.id}>
                <th scope="row">{b.label}{analyst && <small> {b.range}</small>}</th>
                <td className="num">{row.attempted}</td>
                <td className="num">{row.pct === null ? '–' : `${row.pct}%`}</td>
                <td><span className="band-bar"><i style={{ width: `${row.pct ?? 0}%`, background: teamTone(team.id) }} /></span></td>
              </tr>;
            })}</tbody>
          </table>
          {stats.fastest && <p className="hint">Fastest attack: {fmt(stats.fastest.gain, 0)} m in {fmt(stats.fastest.seconds, 1)} s ({fmt(stats.fastest.speed, 1)} m/s) at {clockLabel(stats.fastest.events[0].period, stats.fastest.events[0].match_time_ms)}.
            {' '}<button type="button" className="text-button inline" onClick={() => onSelectEvent(stats.fastest!.events[stats.fastest!.events.length - 1])}>Show on pitch</button></p>}
        </div>;
      })}
    </div>
    <div className="card">
      <h3>Hardest completed passes</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>Min</th><th>Player</th><th className="num">Length</th><th className="num">Forward</th><th className="num">Difficulty</th></tr></thead>
        <tbody>{summary.hardest.map(rating => <tr key={rating.event.event_id} style={{ cursor: 'pointer' }} onClick={() => onSelectEvent(rating.event)}>
          <td>{clockLabel(rating.event.period, rating.event.match_time_ms)}</td>
          <td><span className="player-cell"><i className="team-bar" style={{ background: teamTone(rating.event.team_id) }} />{surname(people.get(rating.event.player_id ?? ''))}</span></td>
          <td className="num">{fmt(rating.length, 1)} m</td>
          <td className="num">{rating.forward >= 0 ? '+' : ''}{fmt(rating.forward, 1)} m</td>
          <td className="num"><b>{rating.difficulty}</b></td>
        </tr>)}</tbody>
      </table></div>
    </div>
    <div className="notice"><Info size={16} /><span>{analyst
      ? `Difficulty (${PASSING_VERSION}) = up to 45 for length (≥ 50 m), 30 for landing depth beyond 70 m in the attacking frame, 25 for forward distance (≥ 30 m); the outcome is not used. Bands: easy < 30, medium 30–54, hard ≥ 55. Check on three full simulated matches (6 team samples): completion falls with difficulty in every sample (≈ 78% / 65% / 51%); small samples mid-match can invert. Speed of attack = forward metres from a possession's first action to its furthest point, divided by the time between those recorded events; possessions with ≥ 15 m and ≥ 2 s. Events only: no tracking, so no player or ball speeds.`
      : 'Difficulty rates each pass from its length, how far forward it goes and how deep it lands, without looking at whether it worked. Over full simulated matches, harder passes fail more often (about 78% of easy, 65% of medium and 51% of hard passes are completed); with few hard passes, one half can differ. Speed of attack is how fast a team moves the ball upfield in one possession.'}</span></div>
  </div>;
}
