import { memo, useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import { useTr } from '../lib/i18n';
import { AnimatePresence, motion } from 'motion/react';
import { CircleHelp, Flame, GitFork, Grid3x3, Play, Route, SlidersHorizontal } from 'lucide-react';
import type { Event, Moment, ReplaySnapshot } from '../types/contracts';
import type { Audience, Prefs } from '../lib/prefs';
import { RULE_LABEL, clockLabel, eventLabel, metricText, playerIndex, teamTone } from '../lib/format';
import { forwardGain, passDifficulty, passLength } from '../lib/geometry';
import { DUR, EASE_OUT } from '../lib/motion';
import { Crest } from './Crest';
import { Pitch, PitchLegend } from './Pitch';
import { atKickoff } from './Scoreboard';

const LAYERS = [
  { key: 'trail', label: 'Recent sequence', icon: Route },
  { key: 'threat', label: 'Threat', icon: Flame },
  { key: 'density', label: 'Event density', icon: Grid3x3 },
  { key: 'network', label: 'Passing connections', icon: GitFork },
] as const;
type Layers = Prefs['layers'];
/** One clear view at a time by default; combining layers is a deliberate, separate step. */
const PRESETS: { id: string; label: string; icon: typeof Route; layers: Layers }[] = [
  { id: 'recent', label: 'Recent sequence', icon: Route, layers: { trail: true, threat: false, density: false, network: false } },
  { id: 'threat', label: 'Threat', icon: Flame, layers: { trail: true, threat: true, density: false, network: false } },
  { id: 'density', label: 'Event density', icon: Grid3x3, layers: { trail: false, threat: false, density: true, network: false } },
  { id: 'network', label: 'Passing connections', icon: GitFork, layers: { trail: false, threat: false, density: false, network: true } },
];
const sameLayers = (a: Layers, b: Layers) => a.trail === b.trail && a.threat === b.threat && a.density === b.density && a.network === b.network;

/** The pitch as the stage. Two modes: following the newest event, or inspecting one moment's source sequence
 * (numbered steps on a quieter pitch). Pre-match shows the fixture and an explicit start. */
export const MatchStage = memo(function MatchStage({ replay, selected, onSelect, prefs, updatePrefs, goal, animate, audience, inspect, onStart, startDisabled, commentary, subtitle }: {
  replay: ReplaySnapshot; selected?: Event; onSelect: (event: Event | undefined) => void; prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void; goal: Event | null; animate: boolean; audience: Audience;
  inspect: Moment | null; /** Returning to the replay lives in the Now bar and the moment card. */ onStopInspect?: () => void; onStart: () => void; startDisabled: boolean;
  /** Live commentary controls, in the header row so they cost no height above the pitch. */
  commentary?: React.ReactNode;
  /** The spoken line as a subtitle over the bottom of the pitch (below it on phones). */
  subtitle?: React.ReactNode;
}) {
  const tr = useTr();
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const focus = selected ?? [...replay.events].reverse().find(event => event.start);
  const [teamPick, setTeamPick] = useState<string | null>(null);
  const networkTeam = teamPick ?? prefs.favoriteTeam ?? focus?.team_id ?? 'harbor';
  const fan = audience === 'fan';
  // Each audience remembers its own layers; switching never rewrites the other's view.
  const layerKey = fan ? 'layers' : 'analystLayers';
  const layers = prefs[layerKey];
  const [tactics, setTactics] = useState(false);
  // Fans get the pitch without footnotes; what the lines and colours mean opens on demand.
  const [keyOpen, setKeyOpen] = useState(false);
  const preset = PRESETS.find(p => sameLayers(p.layers, layers))?.id ?? 'custom';
  const [combine, setCombine] = useState(false);
  const combining = combine || preset === 'custom';
  const pre = atKickoff(replay.state, replay.replay);
  const steps = inspect ? replay.events.filter(event => inspect.evidence_ids.includes(event.event_id) && event.start).length : 0;
  const caption = inspect ? `This moment's ${steps} recorded ${steps === 1 ? 'action' : 'actions'}, numbered in order; later events are hidden. Lines join recorded points.`
    : t('Lines join recorded points; the moving ball is illustrative.');
  const toggle = (key: keyof Prefs['layers']) => updatePrefs({ [layerKey]: {
    ...layers, [key]: !layers[key],
    // Threat and density share the turf as heat layers: one at a time keeps both readable.
    ...(key === 'density' && !layers.density ? { threat: false } : {}), ...(key === 'threat' && !layers.threat ? { density: false } : {}),
  } });
  const chips = <div className="layer-tools">
    <div className="layer-chips" role="radiogroup" aria-label={t('Pitch view')}>
      {PRESETS.map(({ id, label, icon: Icon, layers: next }) => <button key={id} type="button" role="radio" className="chip" aria-checked={preset === id}
        onClick={() => { setCombine(false); updatePrefs({ [layerKey]: next }); }} disabled={!!inspect && id !== 'threat' && id !== 'recent'}>
        <Icon size={14} aria-hidden="true" />{tr(label)}
      </button>)}
      <button type="button" className="chip quiet" aria-pressed={combining} onClick={() => setCombine(value => !value)} disabled={!!inspect}>{tr('Combine…')}</button>
    </div>
    {combining && !inspect && <div className="layer-chips combine" role="group" aria-label={t('Combine layers')}>
      {LAYERS.map(({ key, label }) => <label key={key} className="check"><input type="checkbox" checked={layers[key]} onChange={() => toggle(key)} />{tr(label)}</label>)}
    </div>}
  </div>;

  return <section className="desk-stage" aria-labelledby="pitch-title">
    <div className="stage-head">
      <h2 id="pitch-title">{tr('Match pitch')}</h2>
      {inspect
        ? <span className="stage-mode" data-mode="inspecting" role="status">
            {tr('Inspecting')} <b>{clockLabel(inspect.period, inspect.match_time_ms)} {tr(RULE_LABEL[inspect.rule]).toLowerCase()}</b>
          </span>
        : <span className="stage-mode">{selected ? tr('Showing a selected event') : pre ? tr('Waiting for kick-off') : tr('The latest passes, as they happen')}</span>}
      {commentary}
      {fan && !inspect && <button type="button" className="chip" aria-expanded={keyOpen} aria-controls="pitch-key" onClick={() => setKeyOpen(open => !open)}>
        <CircleHelp size={14} aria-hidden="true" />{tr('Key')}</button>}
      {fan
        ? <div className="tactics">
            <button type="button" className="chip" aria-expanded={tactics} aria-controls="tactics-panel" onClick={() => setTactics(open => !open)}>
              <SlidersHorizontal size={14} aria-hidden="true" />{tr('Explore tactics')}{preset !== 'recent' ? <span className="count">{tr(PRESETS.find(p => p.id === preset)?.label ?? 'Custom')}</span> : null}
            </button>
            {tactics && <div className="tactics-panel" id="tactics-panel">
              {chips}
              <p className="hint">{tr('These views summarise recorded actions. None of them is player tracking.')}</p>
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
      {!pre && subtitle}
      {pre && !inspect && <div className="stage-overlay">
        <div className="stage-card">
          <div className="fixture">
            <Crest team={replay.state.home_team.id} />{replay.state.home_team.name}<small>v</small>{replay.state.away_team.name}<Crest team={replay.state.away_team.id} />
          </div>
          <p>{tr('A synthetic match, replayed event by event. Moments appear only when the recorded events support them.')}</p>
          <button type="button" className="button primary" onClick={onStart} disabled={startDisabled}><Play size={16} fill="currentColor" aria-hidden="true" />{tr('Start replay')}</button>
        </div>
      </div>}
      <AnimatePresence>
        {goal && !inspect && <GoalRibbon key={goal.event_id} goal={goal} replay={replay} scorer={people.get(goal.player_id ?? '')?.name} animate={animate} />}
      </AnimatePresence>
      {focus && !inspect && !pre && !goal && <Annotation event={focus} name={people.get(focus.player_id ?? '')?.name} pinned={!!selected} onClear={() => onSelect(undefined)} />}
    </div>
    {(!fan || inspect || keyOpen) && <div className="stage-foot" id="pitch-key">
      {inspect ? <span>{caption}</span>
        : <LayerKey layers={layers} attackingTeam={focus?.team_id ?? 'harbor'} networkTeam={networkTeam} onTeam={setTeamPick} />}
      <PitchLegend compact={fan} />
      {fan && !inspect && <span className="key-band">{tr('The band shows who moved the ball into danger, Harbor above and Vale below. It is not a win probability.')}</span>}
    </div>}
    {!fan && focus && !pre && <EventInspector event={inspect ? undefined : focus} moment={inspect} events={replay.events} name={people.get(focus.player_id ?? '')?.name} />}
  </section>;
});

/** What each active layer means, its scope and its scale, beside the pitch it describes. */
function LayerKey({ layers, attackingTeam, networkTeam, onTeam }: { layers: Layers; attackingTeam: string; networkTeam: string; onTeam: (team: string) => void }) {
  const name = (team: string) => team === 'harbor' ? 'Harbor' : 'Vale';
  return <div className="layer-key">
    {layers.threat && <span><i className="scale threat" aria-hidden="true" /><b>{t('Threat:')}</b> {t("low → high, from {team}'s attacking direction. A hand-designed grid, not a probability.").replace('{team}', name(attackingTeam))}</span>}
    {layers.density && <span><i className="scale density" aria-hidden="true" /><b>{t('Event density:')}</b> {t('fewer → more recorded actions so far, both teams. Locations of actions only, not tracking.')}</span>}
    {layers.network && <span><b>{t('Passing connections:')}</b>
      <span className="segmented small" role="radiogroup" aria-label={t('Team for passing connections')}>
        {['harbor', 'vale'].map(team => <button key={team} type="button" role="radio" aria-checked={networkTeam === team} onClick={() => onTeam(team)}>
          {networkTeam === team && <span className="thumb" />}{name(team)}</button>)}
      </span>
      {t("Circles at each player's average action position (not a tracked position); line width = completed passes between them.")}</span>}
    {layers.trail && !layers.threat && !layers.density && !layers.network && <span><b>{t('Recent sequence:')}</b> {t('the latest actions of the current passage of play; older ones fade. The moving ball is illustrative.')}</span>}
  </div>;
}

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
  const length = event.start && event.end ? passLength(event.start, event.end) : null;
  const forward = event.start && event.end && event.attacking_direction ? forwardGain(event.start, event.end, event.attacking_direction) : null;
  const difficulty = event.type === 'pass' && event.start && event.end && event.attacking_direction ? passDifficulty(event.start, event.end, event.attacking_direction) : null;
  return <dl className="inspector" aria-label={t('Selected event')}>
    <div><dt>{t('Event')}</dt><dd><b>{eventLabel(event)}</b> · {name ?? '–'}</dd></div>
    <div><dt>{t('Time')}</dt><dd className="num">{clockLabel(event.period, event.match_time_ms)} · P{event.period}</dd></div>
    <div><dt>{t(event.type === 'shot' ? 'Shot length · towards goal' : 'Pass length · forward gain')}</dt><dd className="num">{length === null ? t('not recorded') : `${metricText('pass_distance', length)} m`}{forward === null ? '' : ` · ${forward >= 0 ? '+' : '−'}${metricText('forward_progress', Math.abs(forward))} m`}</dd></div>
    {difficulty && <div><dt>{t('Difficulty indicator')}</dt><dd title="A heuristic from length, forward gain, destination and width. Not a completion probability: no defender or pressure data exists.">{difficulty.score}/100 · {t(difficulty.band)}</dd></div>}
    <div><dt>{t('Attacking')}</dt><dd>{event.attacking_direction === 'positive_x' ? t('the right-hand goal') : event.attacking_direction ? t('the left-hand goal') : '–'}</dd></div>
    <div><dt>{t('Position (m)')}</dt><dd className="num">{event.start ? `${event.start.x}, ${event.start.y}` : '–'}{event.end ? ` → ${event.end.x}, ${event.end.y}` : ''}</dd></div>
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
