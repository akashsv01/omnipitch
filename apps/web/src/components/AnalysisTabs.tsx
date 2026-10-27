import { memo, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import type { PushStatus } from '../lib/push';
import type { RecapScope, Analysis, Event, IngestResult, PpdaWindow, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { fetchLedger, ingestEvents, type LedgerView } from '../lib/api';
import { fmt, playerIndex, surname, teamTone } from '../lib/format';
import { passingSummary } from '../lib/passing';
import { INDICATOR } from '../lib/motion';
import { EventhousePanel } from './EventhousePanel';
import { PassingPanel } from './PassingPanel';
import { Pitch } from './Pitch';
import { RecapPanel } from './RecapPanel';
import { momentumSlots, momentumSummary } from './Scoreboard';

export type Tab = 'recap' | 'teams' | 'passing' | 'pressing' | 'players' | 'shots' | 'quality';
// Fans get the familiar views (recap, match stats, players, shots); analysts get every view. A fan can
// always switch audience to reach the rest, and switching never resets the replay.
const TABS: { id: Tab; label: string; fanLabel?: string; fan: boolean }[] = [
  { id: 'recap', label: 'Recap', fan: true }, { id: 'teams', label: 'Team comparison', fanLabel: 'Match stats', fan: true },
  { id: 'passing', label: 'Passing', fan: true }, { id: 'pressing', label: 'Pressing', fan: false }, { id: 'players', label: 'Players', fan: true },
  { id: 'shots', label: 'Shot map', fan: true }, { id: 'quality', label: 'Data quality', fan: false },
];

export type TabRequest = { tab: Tab; nonce: number; scope?: RecapScope };

export const AnalysisTabs = memo(function AnalysisTabs({ replay, audience, favoritePlayer, onSelectEvent, busy = false, onLoadEventhouse, onJumpMoment, tabRequest, push, playhead = 0 }: {
  replay: ReplaySnapshot; audience: Audience; favoritePlayer: string | null; onSelectEvent: (event: Event) => void;
  busy?: boolean; onLoadEventhouse?: (sourceRunId: string) => void;
  onJumpMoment: (momentId: string, replayMs: number) => void; tabRequest?: TabRequest; push?: PushStatus;
  /** Replay position as a 0–1 fraction, quantised by the caller so this memoised section re-renders rarely. */
  playhead?: number;
}) {
  const [chosen, setTab] = useState<Tab>('teams');
  useEffect(() => { if (tabRequest) setTab(tabRequest.tab); }, [tabRequest]);
  const tabs = audience === 'fan' ? TABS.filter(item => item.fan) : TABS;
  const tab = tabs.some(item => item.id === chosen) ? chosen : 'teams';
  return <section className="analysis" aria-labelledby="analysis-title">
    <div className="section-head">
      <h2 id="analysis-title">{audience === 'fan' ? 'The match so far' : 'Match analysis'}</h2>
      <p>{audience === 'fan' ? 'Based on the events up to the current replay time' : `Metrics from the ${replay.analysis.through_sequence} events available up to the current replay time · ${replay.analysis.metric_version}`}</p>
    </div>
    <div className="tabs" role="tablist" aria-label="Analysis views">
      {tabs.map(item => <button key={item.id} id={`tab-${item.id}`} role="tab" type="button" className="tab" aria-selected={tab === item.id}
        aria-controls={`panel-${item.id}`} onClick={() => setTab(item.id)}
        onKeyDown={event => {
          const index = tabs.findIndex(entry => entry.id === tab);
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            setTab(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }
        }} tabIndex={tab === item.id ? 0 : -1}>
        {audience === 'fan' ? item.fanLabel ?? item.label : item.label}{tab === item.id && <motion.span layoutId="tab-underline" className="underline" transition={INDICATOR} />}
      </button>)}
    </div>
    <div key={tab} className="tab-body tab-fade" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === 'recap' && <RecapPanel replay={replay} audience={audience} onJump={onJumpMoment} request={tabRequest} />}
      {tab === 'teams' && <div style={{ display: 'grid', gap: 26 }}>
        <Momentum replay={replay} playhead={playhead} audience={audience} />
        <TeamCompare analysis={replay.analysis} audience={audience} />
      </div>}
      {tab === 'passing' && <PassingPanel replay={replay} audience={audience} onSelectEvent={onSelectEvent} />}
      {tab === 'pressing' && <Pressing analysis={replay.analysis} audience={audience} />}
      {tab === 'players' && <Players replay={replay} favoritePlayer={favoritePlayer} audience={audience} />}
      {tab === 'shots' && <Shots replay={replay} onSelectEvent={onSelectEvent} />}
      {tab === 'quality' && <Quality replay={replay} busy={busy} onLoadEventhouse={onLoadEventhouse} push={push} />}
    </div>
  </section>;
});

/** Compact momentum: illustrative threat from completed passes per 5 minutes, with the replay playhead. */
function Momentum({ replay, playhead, audience }: { replay: ReplaySnapshot; playhead: number; audience: Audience }) {
  const { values, max, totals } = useMemo(() => momentumSlots(replay.analysis.momentum), [replay.analysis.momentum]);
  const width = 760, height = 96, mid = 48, gap = 4;
  const slot = (width - gap) / 20;
  const half = replay.events.find(event => event.type === 'period_end' && event.period === 1);
  const halfFraction = half ? Math.min(.9, Math.max(.1, half.match_time_ms / Math.max(1, replay.replay.duration_ms))) : .5;
  // Slots are per half; map the replay playhead into slot space through the half-time split.
  const head = playhead <= halfFraction ? playhead / halfFraction * 10 : 10 + (playhead - halfFraction) / (1 - halfFraction) * 10;
  return <div className="momentum">
    <div className="momentum-head">
      <h3>Momentum</h3>
      <span className="hint">Harbor <b className="num" style={{ color: 'var(--harbor)' }}>{fmt(totals.harbor, 2)}</b> · Vale <b className="num" style={{ color: 'var(--vale)' }}>{fmt(totals.vale, 2)}</b></span>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Momentum by five-minute slot. ${momentumSummary(replay.analysis.momentum)}.`}>
      <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--line-2)" />
      <line x1={width / 2} x2={width / 2} y1="4" y2={height - 4} stroke="var(--line-2)" strokeDasharray="2 4" />
      {values.map((v, i) => v.seen && <g key={i}>
        <rect x={gap / 2 + i * slot + 2} y={mid - Math.max(0, v.harbor / max * (mid - 6))} width={slot - 4} height={Math.max(0, v.harbor / max * (mid - 6))} rx="2" fill="var(--harbor)" opacity=".8" />
        <rect x={gap / 2 + i * slot + 2} y={mid} width={slot - 4} height={Math.max(0, v.vale / max * (mid - 6))} rx="2" fill="var(--vale)" opacity=".8" />
      </g>)}
      <line x1={gap / 2 + Math.min(20, head) * slot} x2={gap / 2 + Math.min(20, head) * slot} y1="0" y2={height} stroke="var(--text)" strokeWidth="2" />
    </svg>
    <p className="hint">{audience === 'analyst'
      ? 'Sum of the illustrative threat-grid gain from completed passes in each five-minute slot (stoppage time folds into each half\'s last slot). Harbor above the line, Vale below. Uncalibrated; it is not a win or goal probability.'
      : 'Who moved the ball into dangerous areas, five minutes at a time: Harbor above, Vale below. It is not a win probability.'}</p>
  </div>;
}

function TeamCompare({ analysis, audience }: { analysis: Analysis; audience: Audience }) {
  const home = analysis.teams.harbor;
  const away = analysis.teams.vale;
  if (!home || !away) return null;
  const rows: { label: string; hint?: string; unit?: string; a: number | null; b: number | null; digits?: number; fan?: boolean; lowerBetter?: boolean }[] = [
    { label: 'Goals', a: home.goals, b: away.goals, fan: true },
    { label: 'Shots', hint: 'all attempts', a: home.shots, b: away.shots, fan: true },
    { label: 'On target', a: home.shots_on_target, b: away.shots_on_target, fan: true },
    { label: 'Pass share', hint: 'share of pass attempts, not possession time', unit: '%', a: home.pass_share_pct, b: away.pass_share_pct, fan: true },
    { label: 'Pass completion', unit: '%', a: home.completion_pct, b: away.completion_pct },
    { label: 'Forward progression', hint: 'completed passes', unit: 'm', a: home.progression_m, b: away.progression_m, digits: 0, fan: true },
    { label: 'Final-third entries', a: home.final_third_entries, b: away.final_third_entries },
    { label: 'Box entries', hint: 'completed passes', a: home.box_entries, b: away.box_entries },
    { label: 'Illustrative threat', hint: 'uncalibrated grid sum', a: home.threat_gained, b: away.threat_gained, digits: 2 },
    { label: 'Ball wins', hint: 'tackles + interceptions', a: home.turnovers_won, b: away.turnovers_won, fan: true },
    { label: 'Defensive actions', a: home.defensive_actions, b: away.defensive_actions },
    { label: 'Fouls', a: home.fouls, b: away.fouls, lowerBetter: true },
  ];
  const shown = audience === 'fan' ? rows.filter(row => row.fan) : rows;
  return <div className="compare">
    <div className="compare-head"><span style={{ color: 'var(--harbor)' }}>Harbor Comets</span><span /><span style={{ color: 'var(--vale)' }}>Vale Owls</span></div>
    {shown.map(row => {
      // One scale per metric: each bar is that team's share of the two teams' total (empty when both are zero).
      const total = (row.a ?? 0) + (row.b ?? 0);
      const share = (value: number | null) => total > 0 ? (value ?? 0) / total : 0;
      const missing = row.a === null && row.b === null;
      const lead = (a: number | null, b: number | null) => (a ?? 0) > (b ?? 0) !== !!row.lowerBetter;
      return <div className="compare-row" key={row.label}>
        <span className="compare-value" style={{ color: lead(row.a, row.b) ? 'var(--text)' : 'var(--text-2)' }}>{fmt(row.a, row.digits ?? 1)}{row.a !== null && row.unit && <small>{row.unit}</small>}</span>
        <div className="bar" aria-hidden="true"><i style={{ background: 'var(--harbor)', transform: `scaleX(${share(row.a)})` }} /></div>
        <span className="compare-label">{row.label}{missing ? <small>no data yet</small> : total === 0 ? <small>none yet</small> : row.hint && <small>{row.hint}</small>}</span>
        <div className="bar away" aria-hidden="true"><i style={{ background: 'var(--vale)', transform: `scaleX(${share(row.b)})` }} /></div>
        <span className="compare-value right" style={{ color: lead(row.b, row.a) ? 'var(--text)' : 'var(--text-2)' }}>{fmt(row.b, row.digits ?? 1)}{row.b !== null && row.unit && <small>{row.unit}</small>}</span>
      </div>;
    })}
    {audience === 'analyst' && <p className="hint" style={{ marginTop: 10 }}>Progression and threat use each team's own attacking frame. Pass share counts attempts; it is not time in possession.</p>}
  </div>;
}

function PpdaCard({ team, window, audience }: { team: string; window: PpdaWindow | undefined; audience: Audience }) {
  const name = team === 'harbor' ? 'Harbor Comets' : 'Vale Owls';
  if (!window) return <div className="card"><h3>{name}</h3><p className="hint">No events yet.</p></div>;
  // A ratio describes how many passes the opponents made per defensive action. It is never presented as proof
  // that pressing worked, and a window that fails the sample gate leads with that fact, not with the number.
  const valid = window.status === 'ok';
  const verdict = valid
    ? window.value! <= 4 ? 'Few passes allowed per defensive action' : window.value! <= 8 ? 'A moderate number of passes per action' : 'Many passes allowed per defensive action'
    : window.status === 'no_defensive_actions' ? 'No defensive actions in the zone' : 'Insufficient events';
  return <div className="card ppda-card" data-valid={valid}>
    <h3 style={{ color: teamTone(team) }}>{name}</h3>
    {valid
      ? <div className="stat-pair">
          <div className="stat"><b>{fmt(window.value, 2)}</b><span>PPDA, last 5 minutes</span></div>
          <div className="stat"><b className="verdict">{verdict}</b><span>Lower means fewer opponent passes per action; it does not show the press worked</span></div>
        </div>
      : <div className="stat-pair">
          <div className="stat"><b className="verdict">{verdict}</b><span>{window.reason}</span></div>
          {window.value !== null && <div className="stat provisional"><b>{fmt(window.value, 2)}</b><span>Provisional ratio, below the sample gate</span></div>}
        </div>}
    {audience === 'analyst' && <p className="hint">{window.opponent_passes} opponent passes ÷ {window.defensive_actions} defensive actions · {window.zone} · last 5 minutes · gate ≥ 10 passes and ≥ 3 actions · {window.metric_version}</p>}
  </div>;
}

function Pressing({ analysis, audience }: { analysis: Analysis; audience: Audience }) {
  const [tip, setTip] = useState<string>();
  const series = analysis.ppda_series.filter(w => w.closed);
  const width = 760, height = 220, pad = 34;
  const slots = 20;
  const x = (w: PpdaWindow) => pad + ((w.period - 1) * 10 + Math.min(9, w.start_ms / 300000) + .5) * (width - pad * 2) / slots;
  const max = Math.max(12, ...series.map(w => w.value ?? 0));
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="grid-2">
      <PpdaCard team="harbor" window={analysis.ppda_current.harbor} audience={audience} />
      <PpdaCard team="vale" window={analysis.ppda_current.vale} audience={audience} />
    </div>
    <div className="card">
      <h3>PPDA by five-minute window</h3>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PPDA by five-minute window for both teams. Hollow points did not meet the sample gate.">
        {[0, .25, .5, .75, 1].map(t => <g key={t}>
          <line x1={pad} x2={width - pad} y1={y(max * t)} y2={y(max * t)} stroke="var(--rule)" strokeDasharray="2 5" />
          <text x={pad - 8} y={y(max * t) + 4} textAnchor="end" fontSize="11" fill="var(--chalk-faint)">{Math.round(max * t)}</text>
        </g>)}
        <line x1={width / 2} x2={width / 2} y1={pad / 2} y2={height - pad} stroke="var(--rule-strong)" />
        <text x={width / 2 + 6} y={pad / 2 + 10} fontSize="11" fill="var(--chalk-faint)">Half-time</text>
        {(['harbor', 'vale'] as const).map(team => {
          const points = series.filter(w => w.team_id === team && w.value !== null);
          const valid = points.filter(w => w.status === 'ok');
          return <g key={team}>
            {[1, 2].map(period => {
              const line = valid.filter(w => w.period === period);
              return line.length > 1 ? <polyline key={period} fill="none" stroke={teamTone(team)} strokeWidth="2"
                points={line.map(w => `${x(w)},${y(w.value!)}`).join(' ')} /> : null;
            })}
            {points.map(w => {
              const text = `${team === 'harbor' ? 'Harbor' : 'Vale'}, ${w.period === 1 ? 'first' : 'second'} half minutes ${w.start_ms / 60000}–${w.end_ms / 60000}: PPDA ${w.value} (${w.opponent_passes} passes ÷ ${w.defensive_actions} actions)${w.status !== 'ok' ? ', below the sample gate, so no claim is made' : ''}`;
              return <circle key={`${w.period}-${w.start_ms}`} className="chart-point" cx={x(w)} cy={y(w.value!)} r="5" tabIndex={0} role="img" aria-label={text}
                fill={w.status === 'ok' ? teamTone(team) : 'var(--inset)'} stroke={teamTone(team)} strokeWidth="1.6"
                onFocus={() => setTip(text)} onMouseEnter={() => setTip(text)} onClick={() => setTip(text)}><title>{text}</title></circle>;
            })}
          </g>;
        })}
        <text x={pad} y={height - 10} fontSize="11" fill="var(--chalk-faint)">Kick-off</text>
        <text x={width - pad} y={height - 10} textAnchor="end" fontSize="11" fill="var(--chalk-faint)">Full-time</text>
      </svg>
      <p className="chart-tip" aria-live="polite">{tip ?? 'Select or focus a point for its window, value and sample.'}</p>
      <div className="legend hint">
        <span><i style={{ background: 'var(--harbor)' }} />Harbor</span><span><i style={{ background: 'var(--vale)' }} />Vale</span>
        <span><i style={{ border: '1.5px solid var(--chalk-dim)' }} />Below sample gate (no claim made)</span>
      </div>
    </div>
    <div className="notice"><Info size={16} />
      <span>PPDA counts opponent passes per defensive action beyond 42 m in the defending team's attacking frame. Lower means more intense pressure. It does not prove pressing caused a turnover. Windows need at least 10 passes and 3 actions before the app makes any claim.</span>
    </div>
  </div>;
}

type SortKey = 'threat_gained' | 'progression_m' | 'passes' | 'shots' | 'defensive_actions';

function Players({ replay, favoritePlayer, audience }: { replay: ReplaySnapshot; favoritePlayer: string | null; audience: Audience }) {
  const [sort, setSort] = useState<SortKey>('threat_gained');
  const [team, setTeam] = useState<'all' | 'harbor' | 'vale'>('all');
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const passing = useMemo(() => new Map(passingSummary(replay.events, []).players.map(row => [row.player_id, row])), [replay.events]);
  const columns: { key: SortKey; label: string; analyst?: boolean }[] = [
    { key: 'threat_gained', label: 'Threat', analyst: true }, { key: 'progression_m', label: 'Progress m' },
    { key: 'passes', label: 'Passes' }, { key: 'shots', label: 'Shots' }, { key: 'defensive_actions', label: 'Def. actions' },
  ];
  const visible = columns.filter(column => audience === 'analyst' || !column.analyst);
  const active = visible.some(column => column.key === sort) ? sort : 'progression_m';
  const rows = replay.analysis.players.filter(row => team === 'all' || row.team_id === team).sort((a, b) => b[active] - a[active]);
  return <div style={{ display: 'grid', gap: 12 }}>
    <div className="segmented small" role="group" aria-label="Team filter" style={{ justifySelf: 'start' }}>
      {(['all', 'harbor', 'vale'] as const).map(id => <button key={id} type="button" aria-pressed={team === id} onClick={() => setTeam(id)}>
        {team === id && <motion.span layoutId="player-team" className="thumb" />}{id === 'all' ? 'Both teams' : id === 'harbor' ? 'Harbor' : 'Vale'}
      </button>)}
    </div>
    <div className="table-wrap"><table>
      <thead><tr><th>Player</th>{visible.map(column => <th key={column.key} className="num" aria-sort={active === column.key ? 'descending' : undefined}>
        <button type="button" onClick={() => setSort(column.key)}>{column.label}{active === column.key && <ArrowDown size={12} />}</button>
      </th>)}{audience === 'analyst' && <><th className="num">Completed</th><th className="num" title="Average pass difficulty, 0–100">Pass diff.</th></>}</tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={8} className="hint">No player actions yet.</td></tr>}
        {rows.map(row => {
          const person = people.get(row.player_id);
          return <tr key={row.player_id} data-favorite={row.player_id === favoritePlayer}>
            <td><span className="player-cell"><span className="shirt" style={{ background: teamTone(row.team_id) }}>{person?.shirt}</span>
              <span>{person?.name ?? row.player_id} <span className="hint">{person?.position}</span></span></span></td>
            {visible.map(column => <td key={column.key} className="num">{fmt(row[column.key], column.key === 'threat_gained' ? 3 : column.key === 'progression_m' ? 0 : 1)}</td>)}
            {audience === 'analyst' && <><td className="num">{row.passes ? `${Math.round(100 * row.passes_completed / row.passes)}%` : '–'}</td>
              <td className="num">{passing.get(row.player_id)?.meanDifficulty ?? '–'}</td></>}
          </tr>;
        })}
      </tbody>
    </table></div>
    <p className="hint">Counts come from recorded on-ball events only. No off-ball work, distance covered or speed is available.</p>
  </div>;
}

function Shots({ replay, onSelectEvent }: { replay: ReplaySnapshot; onSelectEvent: (event: Event) => void }) {
  const shots = replay.events.filter(event => event.type === 'shot');
  const people = playerIndex(replay.replay.roster);
  return <div className="grid-2" style={{ alignItems: 'start' }}>
    <div className="pitch-wrap" style={{ margin: 0 }}>
      <Pitch events={replay.events} highlightIds={shots.map(shot => shot.event_id)} roster={replay.replay.roster} onSelect={onSelectEvent} compact />
    </div>
    <div className="card">
      <h3>{shots.length} shots</h3>
      {shots.length === 0 ? <p className="hint">No shots yet.</p> : <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}><table>
        <thead><tr><th>Min</th><th>Player</th><th>Outcome</th></tr></thead>
        <tbody>{[...shots].reverse().map(shot => <tr key={shot.event_id} style={{ cursor: 'pointer' }} onClick={() => onSelectEvent(shot)}>
          <td>{Math.floor(shot.match_time_ms / 60000) + (shot.period === 2 ? 46 : 1)}'</td>
          <td><span className="player-cell"><i className="team-bar" style={{ background: teamTone(shot.team_id) }} />{surname(people.get(shot.player_id ?? ''))}</span></td>
          <td style={{ color: shot.is_goal ? 'var(--flood)' : undefined }}>{shot.outcome.replace('_', ' ')}</td>
        </tr>)}</tbody>
      </table></div>}
      <p className="hint">Shot quality is not modelled. Lines show recorded start and end points.</p>
    </div>
  </div>;
}

const PUSH_LABEL: Record<PushStatus['state'], string> = {
  off: 'Off', connecting: 'Connecting', live: 'Live', retrying: 'Reconnecting', unavailable: 'Not configured',
};

function Quality({ replay, busy, onLoadEventhouse, push }: { replay: ReplaySnapshot; busy: boolean; onLoadEventhouse?: (id: string) => void; push?: PushStatus }) {
  const runId = replay.state.run_id;
  const [ledger, setLedger] = useState<LedgerView>();
  const [result, setResult] = useState<{ before: LedgerView; ingest: IngestResult; after: Analysis['teams'] }>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let active = true;
    fetchLedger(runId).then(view => active && setLedger(view)).catch(err => active && setError(String(err.message ?? err)));
    return () => { active = false; };
  }, [runId, replay.state.latest_event_sequence]);
  async function duplicateTest() {
    setRunning(true);
    setError(undefined);
    try {
      const before = await fetchLedger(runId);
      const sample = replay.events.slice(-Math.min(50, replay.events.length));
      const ingest = await ingestEvents(runId, [...sample].reverse());
      setResult({ before, ingest, after: replay.analysis.teams });
      setLedger(await fetchLedger(runId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }
  const summary = ledger?.summary;
  return <div style={{ display: 'grid', gap: 18 }}>
    <div className="card">
      <h3>Live updates</h3>
      {!push || push.state === 'off'
        ? <p className="hint">Polling only: this replay has no source run to follow (simulator data).</p>
        : <>
          <div className="stat-pair">
            <div className="stat"><b>{PUSH_LABEL[push.state]}</b><span>Web PubSub</span></div>
            <div className="stat"><b>{push.received}</b><span>messages used</span></div>
            <div className="stat"><b>{push.ignored}</b><span>ignored (duplicate, stale or invalid)</span></div>
          </div>
          <p className="hint">Run <span className="mono">{push.runId}</span>{push.lastType ? ` · last ${push.lastType.replace('_', ' ')} at ${push.lastAt}` : ''}
            {push.error ? ` · ${push.error}` : ''}. A push only fetches the next snapshot sooner; the snapshot API stays the source of truth, and polling continues. The socket connects to Web PubSub directly, so it can stay Live while the API is down (the top bar shows API reachability).</p>
        </>}
    </div>
    <div className="card">
      <h3>Narrated insights</h3>
      {replay.insights.mode === 'off'
        ? <p className="hint">Off: moments show deterministic templates. Set OMNIPITCH_INSIGHTS=cosmos to show the narration worker's insights.</p>
        : <>
          <div className="stat-pair">
            <div className="stat"><b>{replay.insights.narrated}</b><span>from Cosmos</span></div>
            <div className="stat"><b>{replay.insights.ai}</b><span>AI-written</span></div>
            <div className="stat"><b>{replay.insights.rejected}</b><span>rejected by our checks</span></div>
          </div>
          <p className="hint">Run <span className="mono">{replay.insights.source_run_id ?? 'none'}</span> · status {replay.insights.status}
            {replay.insights.error ? ` · ${replay.insights.error}` : ''}. Every narrated insight is re-validated against this API's own copy of the moment; rejected ones keep the template.</p>
        </>}
    </div>
    <div className="grid-2">
      <div className="card">
        <h3>Event ledger</h3>
        {summary ? <div className="stat-pair">
          <div className="stat"><b>{summary.unique_events}</b><span>unique events</span></div>
          <div className="stat"><b>{summary.duplicates_ignored}</b><span>duplicates ignored</span></div>
          <div className="stat"><b>{summary.conflicts_rejected + summary.invalid_rejected}</b><span>rejected</span></div>
          <div className="stat"><b>{summary.missing_sequences}</b><span>sequence gaps</span></div>
        </div> : <p className="hint">Loading ledger…</p>}
        <p className="hint">Identity is (run ID, event ID). Re-delivered identical events are ignored; a different payload under an existing ID is rejected and logged.</p>
      </div>
      <div className="card">
        <h3>Duplicate delivery test</h3>
        <p className="hint">Re-sends the latest {Math.min(50, replay.events.length)} revealed events, in reverse order, to the ingestion endpoint. Counts and metrics should not change.</p>
        <button type="button" className="button primary" style={{ justifySelf: 'start' }} disabled={running || replay.events.length === 0} onClick={() => void duplicateTest()}>
          <ShieldCheck size={16} aria-hidden="true" />{running ? 'Sending…' : 'Run duplicate test'}
        </button>
        {result && <motion.div className="notice" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} style={{ background: 'rgba(111,211,154,.1)', borderColor: 'rgba(111,211,154,.35)' }}>
          <CheckCircle2 size={16} color="var(--ok)" />
          <span>{result.ingest.accepted} accepted, {result.ingest.duplicates} ignored as duplicates. Unique events {result.before.summary.unique_events} → {result.ingest.ledger.unique_events}.
            {result.ingest.accepted === 0 ? ' Counts unchanged.' : ''}</span>
        </motion.div>}
        {error && <p className="alert" role="alert">{error}</p>}
      </div>
    </div>
    {ledger && ledger.diagnostics.length > 0 && <div className="card">
      <h3>Diagnostics</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>Event</th><th>Code</th><th>Message</th></tr></thead>
        <tbody>{ledger.diagnostics.map((item, index) => <tr key={index}><td className="mono">{item.event_id ?? '–'}</td><td>{item.code}</td><td style={{ whiteSpace: 'normal' }}>{item.message}</td></tr>)}</tbody>
      </table></div>
    </div>}
    {replay.replay.backend_mode === 'azure' && onLoadEventhouse && <EventhousePanel replay={replay} busy={busy} onLoad={onLoadEventhouse} />}
    <div className="notice"><Info size={16} /><span>{replay.replay.backend_mode === 'azure'
      ? 'Azure mode: events are read from Fabric Eventhouse; the local SQLite ledger keeps replay state, moments and this duplicate test.'
      : 'Local mode: SQLite stands in for Eventhouse and Cosmos DB. Set OMNIPITCH_BACKEND_MODE=azure to read from Fabric Eventhouse.'}</span></div>
  </div>;
}
