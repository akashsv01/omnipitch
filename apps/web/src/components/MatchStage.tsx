import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Flame, GitFork, Grid3x3, Play, Route, SlidersHorizontal, X } from 'lucide-react';
import type { Event, Moment, ReplaySnapshot } from '../types/contracts';
import type { Audience, Prefs } from '../lib/prefs';
import { RULE_LABEL, clockLabel, eventLabel, fmt, playerIndex, teamTone } from '../lib/format';
import { DUR, EASE_OUT } from '../lib/motion';
import { Crest } from './Crest';
import { Pitch, PitchLegend } from './Pitch';

const LAYERS = [
  { key: 'trail', label: 'Recent play', icon: Route },
  { key: 'threat', label: 'Threat grid', icon: Flame },
  { key: 'density', label: 'Event density', icon: Grid3x3 },
  { key: 'network', label: 'Pass network', icon: GitFork },
] as const;

/** The pitch as the stage. Two modes: following the newest event, or inspecting one moment's source sequence
 * (numbered steps on a quieter pitch). Pre-match shows the fixture and an explicit start. */
export const MatchStage = memo(function MatchStage({ replay, selected, onSelect, prefs, updatePrefs, goal, animate, audience, inspect, onStopInspect, onStart, startDisabled }: {
  replay: ReplaySnapshot; selected?: Event; onSelect: (event: Event | undefined) => void; prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void; goal: Event | null; animate: boolean; audience: Audience;
  inspect: Moment | null; onStopInspect: () => void; onStart: () => void; startDisabled: boolean;
}) {
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const focus = selected ?? [...replay.events].reverse().find(event => event.start);
  const networkTeam = prefs.favoriteTeam ?? focus?.team_id ?? 'harbor';
  const fan = audience === 'fan';
  // Each audience remembers its own layers; switching never rewrites the other's view.
  const layerKey = fan ? 'layers' : 'analystLayers';
  const layers = prefs[layerKey];
  const [tactics, setTactics] = useState(false);
  const pre = replay.state.latest_event_sequence === 0;
  const steps = inspect ? replay.events.filter(event => inspect.evidence_ids.includes(event.event_id) && event.start).length : 0;
  const caption = inspect ? `This moment's ${steps} recorded ${steps === 1 ? 'action' : 'actions'}, numbered in order; later events are hidden. Lines join recorded points.`
    : layers.density ? 'Event density: action locations only, not tracking.'
    : layers.network ? `${networkTeam === 'harbor' ? 'Harbor' : 'Vale'} pass network: average action locations, not tracked positions.`
    : layers.threat ? `Threat grid (${focus?.team_id === 'vale' ? 'Vale' : 'Harbor'} frame): hand-designed, not a probability.`
    : 'Lines join recorded points; the moving ball is illustrative.';
  const toggle = (key: keyof Prefs['layers']) => updatePrefs({ [layerKey]: {
    ...layers, [key]: !layers[key],
    // Threat and density share the turf as heat layers: one at a time keeps both readable.
    ...(key === 'density' && !layers.density ? { threat: false } : {}), ...(key === 'threat' && !layers.threat ? { density: false } : {}),
  } });
  const chips = <div className="layer-chips" role="group" aria-label="Pitch layers">
    {LAYERS.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="chip" aria-pressed={layers[key]} onClick={() => toggle(key)}
      disabled={!!inspect && key !== 'threat'}>
      <Icon size={14} aria-hidden="true" />{label}
    </button>)}
  </div>;

  return <section className="desk-stage" aria-labelledby="pitch-title">
    <div className="stage-head">
      <h2 id="pitch-title">Match pitch</h2>
      {inspect
        ? <span className="stage-mode" data-mode="inspecting" role="status">
            Inspecting <b>{clockLabel(inspect.period, inspect.match_time_ms)} {RULE_LABEL[inspect.rule].toLowerCase()}</b>
            <button type="button" className="text-button" onClick={onStopInspect}><X size={14} aria-hidden="true" />Return to replay</button>
          </span>
        : <span className="stage-mode">{selected ? 'Showing a selected event' : pre ? 'Waiting for kick-off' : 'Following replay'}</span>}
      {fan
        ? <div className="tactics">
            <button type="button" className="chip" aria-expanded={tactics} aria-controls="tactics-panel" onClick={() => setTactics(open => !open)}>
              <SlidersHorizontal size={14} aria-hidden="true" />Explore tactics{LAYERS.some(l => l.key !== 'trail' && layers[l.key]) ? <span className="count">on</span> : null}
            </button>
            {tactics && <div className="tactics-panel" id="tactics-panel">
              {chips}
              <p className="hint">Heat and network layers summarise recorded actions. They are not tracking data.</p>
            </div>}
          </div>
        : chips}
    </div>
    <div className="pitch-frame">
      <div className="pitch-wrap" data-mode={inspect ? 'sequence' : 'live'}>
        <Pitch events={replay.events} selected={inspect ? undefined : selected} onSelect={onSelect}
          layers={inspect ? { trail: false, threat: layers.threat, density: false, network: false } : layers} roster={replay.replay.roster}
          players={replay.analysis.players} network={{ team: networkTeam, links: replay.analysis.pass_network[networkTeam] ?? [] }}
          highlightIds={inspect?.evidence_ids} numbered={!!inspect} animate={animate} speed={replay.replay.speed} />
      </div>
      {pre && !inspect && <div className="stage-overlay">
        <div className="stage-card">
          <div className="fixture">
            <Crest team={replay.state.home_team.id} />{replay.state.home_team.name}<small>v</small>{replay.state.away_team.name}<Crest team={replay.state.away_team.id} />
          </div>
          <p>A synthetic match, replayed event by event. Moments appear only when the recorded events support them.</p>
          <button type="button" className="button primary" onClick={onStart} disabled={startDisabled}><Play size={16} fill="currentColor" aria-hidden="true" />Start replay</button>
        </div>
      </div>}
      <AnimatePresence>
        {goal && !inspect && <GoalRibbon key={goal.event_id} goal={goal} replay={replay} scorer={people.get(goal.player_id ?? '')?.name} animate={animate} />}
      </AnimatePresence>
      {focus && !inspect && !pre && !goal && <Annotation event={focus} name={people.get(focus.player_id ?? '')?.name} pinned={!!selected} onClear={() => onSelect(undefined)} />}
    </div>
    <div className="stage-foot">
      <span>{caption}</span>
      <PitchLegend compact={fan} />
    </div>
    {!fan && focus && !pre && <EventInspector event={inspect ? undefined : focus} moment={inspect} events={replay.events} name={people.get(focus.player_id ?? '')?.name} />}
  </section>;
});

/** Analyst: the event in focus (or the inspected moment's sequence) as aligned, measurable fields. */
function EventInspector({ event, moment, events, name }: { event?: Event; moment: Moment | null; events: Event[]; name?: string }) {
  if (moment) {
    const cited = events.filter(e => moment.evidence_ids.includes(e.event_id));
    const first = cited[0], last = cited[cited.length - 1];
    return <dl className="inspector" aria-label="Inspected sequence">
      <div><dt>Sequence</dt><dd>{cited.length} events · seq {first?.sequence}–{last?.sequence}</dd></div>
      <div><dt>Window</dt><dd className="num">{first && last ? `${((last.match_time_ms - first.match_time_ms) / 1000).toFixed(1)} s` : '–'}</dd></div>
      <div><dt>From</dt><dd className="num">{first?.start ? `(${first.start.x}, ${first.start.y})` : '–'}</dd></div>
      <div><dt>To</dt><dd className="num">{last ? (last.end ?? last.start) ? `(${(last.end ?? last.start)!.x}, ${(last.end ?? last.start)!.y})` : '–' : '–'}</dd></div>
      <div><dt>Attack</dt><dd>{first?.attacking_direction === 'positive_x' ? '→ +x' : first?.attacking_direction ? '← −x' : '–'}</dd></div>
    </dl>;
  }
  if (!event) return null;
  const length = event.start && event.end ? Math.hypot(event.end.x - event.start.x, event.end.y - event.start.y) : null;
  const forward = event.start && event.end && event.attacking_direction ? (event.end.x - event.start.x) * (event.attacking_direction === 'positive_x' ? 1 : -1) : null;
  return <dl className="inspector" aria-label="Selected event">
    <div><dt>Event</dt><dd><b>{eventLabel(event)}</b> · {name ?? '–'}</dd></div>
    <div><dt>Time</dt><dd className="num">{clockLabel(event.period, event.match_time_ms)} · P{event.period}</dd></div>
    <div><dt>Start → end</dt><dd className="num">{event.start ? `(${event.start.x}, ${event.start.y})` : '–'}{event.end ? ` → (${event.end.x}, ${event.end.y})` : ''}</dd></div>
    <div><dt>Length · forward</dt><dd className="num">{length === null ? '–' : `${fmt(length, 1)} m`}{forward === null ? '' : ` · ${forward >= 0 ? '+' : ''}${fmt(forward, 1)} m`}</dd></div>
    <div><dt>Attack</dt><dd>{event.attacking_direction === 'positive_x' ? '→ +x' : event.attacking_direction ? '← −x' : '–'}</dd></div>
    <div><dt>ID</dt><dd className="mono">{event.event_id} · #{event.sequence}</dd></div>
  </dl>;
}

/** Once per canonical goal in forward playback (App decides when); the score shown is the authoritative score. */
function GoalRibbon({ goal, replay, scorer, animate }: { goal: Event; replay: ReplaySnapshot; scorer?: string; animate: boolean }) {
  const team = goal.team_id === replay.state.home_team.id ? replay.state.home_team : replay.state.away_team;
  return <motion.div className="goal-ribbon" role="status" style={{ ['--tone' as string]: teamTone(goal.team_id) }}
    initial={animate ? { transform: 'translateX(-24px)', opacity: 0 } : { opacity: 0 }} animate={{ transform: 'translateX(0px)', opacity: 1 }}
    exit={{ opacity: 0, transition: { duration: DUR.switch } }} transition={{ duration: DUR.enter + .04, ease: EASE_OUT }}>
    <Crest team={goal.team_id ?? ''} />
    <b>GOAL</b>
    <span className="who"><strong>{scorer ?? team.name}</strong>{team.name} · {clockLabel(goal.period, goal.match_time_ms)}</span>
    <span className="score" aria-label={`Score ${replay.state.score.home} to ${replay.state.score.away}`}>{replay.state.score.home}–{replay.state.score.away}</span>
  </motion.div>;
}

/** The action in focus, in words, at the pitch edge (static under the pitch on phones). */
/** Coordinates live in the analyst's event inspector below the pitch, not on the turf. */
function Annotation({ event, name, pinned, onClear }: { event: Event; name?: string; pinned: boolean; onClear: () => void }) {
  return <div className="annotation" style={{ ['--tone' as string]: event.type === 'shot' ? 'var(--amber)' : teamTone(event.team_id) }}>
    <span><b>{eventLabel(event)}</b>{name ? ` by ${name}` : ''}, {clockLabel(event.period, event.match_time_ms)}</span>
    {pinned && <button type="button" className="text-button" onClick={onClear}>Return to replay</button>}
  </div>;
}
