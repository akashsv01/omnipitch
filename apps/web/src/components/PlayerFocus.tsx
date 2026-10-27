import { useMemo } from 'react';
import { UserRound, X } from 'lucide-react';
import type { Moment, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, clockLabel, eventLabel, fmt, teamTone } from '../lib/format';
import { localStory, useLanguage } from '../lib/i18n';
import { Pitch } from './Pitch';

/** Follow one player through the match: their recorded actions on a pitch, their numbers so far, where they rank in
 * their team and the moments they were part of. Everything is from their own on-ball events. */
export function PlayerFocus({ replay, audience, playerId, onPlayer, onChoose }: {
  replay: ReplaySnapshot; audience: Audience; playerId: string | null;
  onPlayer: (playerId: string | null) => void; onChoose: (moment: Moment) => void;
}) {
  const teams = [replay.state.home_team, replay.state.away_team];
  const roster = replay.replay.roster;
  return <section className="player-focus" aria-labelledby="player-focus-title">
    <div className="pf-bar">
      <h2 id="player-focus-title"><UserRound size={15} aria-hidden="true" />Player focus</h2>
      <label className="sr-only" htmlFor="player-focus-select">Follow a player</label>
      <select id="player-focus-select" className="focus-select" value={playerId ?? ''} onChange={event => onPlayer(event.target.value || null)}>
        <option value="">Follow a player…</option>
        {teams.map(team => <optgroup key={team.id} label={team.name}>
          {roster.filter(p => p.team_id === team.id).map(p => <option key={p.player_id} value={p.player_id}>{p.shirt} · {p.name} ({p.position})</option>)}
        </optgroup>)}
      </select>
      {playerId && <button type="button" className="icon-button" aria-label="Stop following this player" onClick={() => onPlayer(null)}><X size={15} /></button>}
    </div>
    {playerId && <PlayerCard replay={replay} audience={audience} playerId={playerId} onChoose={onChoose} />}
  </section>;
}

function PlayerCard({ replay, audience, playerId, onChoose }: { replay: ReplaySnapshot; audience: Audience; playerId: string; onChoose: (moment: Moment) => void }) {
  const language = useLanguage();
  const roster = replay.replay.roster;
  const person = roster.find(p => p.player_id === playerId);
  const stats = replay.analysis.players.find(p => p.player_id === playerId);
  const actions = useMemo(() => replay.events.filter(e => e.player_id === playerId), [replay.events, playerId]);
  const recent = useMemo(() => actions.filter(e => e.start).slice(-25).map(e => e.event_id), [actions]);
  const moments = useMemo(() => replay.moments
    .filter(m => m.player_id === playerId || actions.some(a => m.evidence_ids.includes(a.event_id)))
    .sort((a, b) => b.source_sequence - a.source_sequence), [replay.moments, actions, playerId]);
  if (!person) return null;
  const team = replay.analysis.players.filter(p => p.team_id === person.team_id).sort((a, b) => b.action_count - a.action_count);
  const rank = team.findIndex(p => p.player_id === playerId) + 1;
  const last = actions[actions.length - 1];
  const pct = stats && stats.passes ? Math.round(100 * stats.passes_completed / stats.passes) : null;
  const wins = actions.filter(e => e.type === 'interception' || (['tackle', 'challenge'].includes(e.type) && e.outcome === 'won')).length;
  const tiles: [string, string, boolean?][] = [
    ['Actions', String(stats?.action_count ?? 0)],
    ['Passes', stats ? `${stats.passes_completed}/${stats.passes}` : '0/0'],
    ['Pass accuracy', pct === null ? '–' : `${pct}%`],
    ['Forward progression', `${fmt(stats?.progression_m ?? 0, 0)} m`],
    ['Shots · goals', `${stats?.shots ?? 0} · ${stats?.goals ?? 0}`],
    ['Ball wins', String(wins)],
    ['Threat added', fmt(stats?.threat_gained ?? 0, 3), true],
    ['Defensive actions', String(stats?.defensive_actions ?? 0), true],
  ];
  return <div className="player-card tab-fade" style={{ ['--tone' as string]: teamTone(person.team_id) }}>
    <div className="player-card-pitch">
      <Pitch events={replay.events} roster={roster} highlightIds={recent} animate={false} compact />
      <p className="hint">Their last {recent.length} recorded actions{stats ? `; average position (${fmt(stats.mean_action_location.x, 0)}, ${fmt(stats.mean_action_location.y, 0)}) m` : ''}. Events only, not tracking.</p>
    </div>
    <div className="player-card-body">
      <div className="player-head">
        <span className="shirt" style={{ background: teamTone(person.team_id) }}>{person.shirt}</span>
        <div><h3>{person.name}</h3><p className="hint">{person.position} · {person.team_id === replay.state.home_team.id ? replay.state.home_team.name : replay.state.away_team.name}
          {rank > 0 ? ` · ${rank === 1 ? 'most involved' : `#${rank} for involvement`} in the team` : ''}</p></div>
      </div>
      <dl className="player-tiles">
        {tiles.filter(([, , analystOnly]) => !analystOnly || audience === 'analyst').map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="num">{value}</dd></div>)}
      </dl>
      {last && <p className="player-last">Latest: <b>{eventLabel(last)}</b> at {clockLabel(last.period, last.match_time_ms)}</p>}
      <h4 className="pf-sub">Moments involving {person.name.split(' ').slice(-1)[0]} ({moments.length})</h4>
      {moments.length ? <ol className="catch-up-list">{moments.slice(0, 4).map(m => <li key={m.moment_id}>
        <button type="button" className="moment-row" style={{ ['--tone' as string]: teamTone(m.team_id) }} onClick={() => onChoose(m)}>
          <span className="minute">{clockLabel(m.period, m.match_time_ms)}</span>
          <span className="title" lang={language}>{localStory(m, roster, language).headline}</span>
          <span className="sub">{RULE_LABEL[m.rule]}{m.player_id === playerId ? ' · lead player' : ' · in the sequence'}</span>
        </button></li>)}</ol>
        : <p className="hint">None yet. Moments appear only when the events support them.</p>}
    </div>
  </div>;
}
