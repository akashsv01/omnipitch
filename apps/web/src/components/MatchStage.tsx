import { memo, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Flame, GitFork, Grid3x3, Route } from 'lucide-react';
import type { Event, ReplaySnapshot } from '../types/contracts';
import type { Audience, Prefs } from '../lib/prefs';
import { clockLabel, eventLabel, playerIndex, surname, teamTone } from '../lib/format';
import { EASE_OUT } from '../lib/motion';
import { Pitch, PitchLegend } from './Pitch';

const LAYERS = [
  { key: 'trail', label: 'Recent play', icon: Route },
  { key: 'threat', label: 'Threat grid', icon: Flame },
  { key: 'density', label: 'Event density', icon: Grid3x3 },
  { key: 'network', label: 'Pass network', icon: GitFork },
] as const;

export const MatchStage = memo(function MatchStage({ replay, selected, onSelect, prefs, updatePrefs, goal, animate, audience }: {
  replay: ReplaySnapshot; selected?: Event; onSelect: (event: Event | undefined) => void; prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void; goal: Event | null; animate: boolean; audience: Audience;
}) {
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const focus = selected ?? [...replay.events].reverse().find(event => event.start);
  const networkTeam = prefs.favoriteTeam ?? focus?.team_id ?? 'harbor';
  const caption = prefs.layers.density ? 'Event density: action locations only, not tracking.'
    : prefs.layers.network ? `${networkTeam === 'harbor' ? 'Harbor' : 'Vale'} pass network: average action locations, not tracked positions.`
    : prefs.layers.threat ? `Threat grid (${focus?.team_id === 'vale' ? 'Vale' : 'Harbor'} frame): hand-designed, not a probability.`
    : 'Lines join recorded points; the moving ball is illustrative.';
  const toggle = (key: keyof Prefs['layers']) => updatePrefs({ layers: {
    ...prefs.layers, [key]: !prefs.layers[key],
    // Threat and density share the turf as heat layers: one at a time keeps both readable.
    ...(key === 'density' && !prefs.layers.density ? { threat: false } : {}), ...(key === 'threat' && !prefs.layers.threat ? { density: false } : {}),
  } });

  return <section className="pitch-stage" aria-labelledby="pitch-title">
    <div className="pitch-toolbar">
      <h2 id="pitch-title">Live pitch <span>· {selected ? 'showing a selected event' : 'following the newest event'}</span></h2>
      <div className="layer-chips" role="group" aria-label="Pitch layers">
        {LAYERS.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="chip" aria-pressed={prefs.layers[key]} onClick={() => toggle(key)}>
          <Icon size={14} aria-hidden="true" />{label}
        </button>)}
      </div>
    </div>
    <div className="pitch-frame">
      <Pitch events={replay.events} selected={selected} onSelect={onSelect} layers={prefs.layers} roster={replay.replay.roster}
        players={replay.analysis.players} network={{ team: networkTeam, links: replay.analysis.pass_network[networkTeam] ?? [] }}
        animate={animate} speed={replay.replay.speed} />
      <AnimatePresence>
        {goal && <motion.div key={goal.event_id} className="goal-banner" aria-hidden="true"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .24, ease: EASE_OUT }}
          style={{ background: `radial-gradient(60% 80% at 50% 50%, color-mix(in srgb, ${teamTone(goal.team_id)} 26%, transparent), transparent 75%)` }}>
          <motion.div initial={animate ? { transform: 'scale(0.92)', opacity: 0 } : false} animate={{ transform: 'scale(1)', opacity: 1 }}
            transition={{ duration: .32, ease: EASE_OUT }}>
            GOAL
            <small>{surname(people.get(goal.player_id ?? ''))} · {goal.team_id === 'harbor' ? 'Harbor Comets' : 'Vale Owls'} · {clockLabel(goal.period, goal.match_time_ms)}</small>
          </motion.div>
        </motion.div>}
      </AnimatePresence>
      {focus && <FocusLine event={focus} name={people.get(focus.player_id ?? '')?.name} audience={audience} pinned={!!selected} onClear={() => onSelect(undefined)} />}
    </div>
    <div className="pitch-caption">
      <span>{caption}</span>
      <PitchLegend />
    </div>
  </section>;
});

/** The action in focus, in words, overlaid at the pitch edge (static under the pitch on phones). */
function FocusLine({ event, name, audience, pinned, onClear }: { event: Event; name?: string; audience: Audience; pinned: boolean; onClear: () => void }) {
  const detail = audience === 'analyst' && event.start
    ? `(${event.start.x}, ${event.start.y})${event.end ? ` → (${event.end.x}, ${event.end.y})` : ''} m · ${event.attacking_direction === 'positive_x' ? 'attacking +x' : 'attacking −x'} · ${event.event_id}`
    : '';
  return <div className="focus-line">
    <i className="team-bar" style={{ background: event.type === 'shot' ? 'var(--flood)' : teamTone(event.team_id) }} aria-hidden="true" />
    <span><b>{eventLabel(event)}</b>{name ? ` by ${name}` : ''}, {clockLabel(event.period, event.match_time_ms)}{detail && <span className="mono"> · {detail}</span>}</span>
    {pinned && <button type="button" className="text-button" onClick={onClear}>Follow live</button>}
  </div>;
}

/** Latest recorded events; selecting one pins it on the pitch. Plain list updates (no per-item animation). */
export const EventTicker = memo(function EventTicker({ replay, selected, onSelect }: { replay: ReplaySnapshot; selected?: Event; onSelect: (event: Event | undefined) => void }) {
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const recent = useMemo(() => replay.events.slice(-14).reverse(), [replay.events]);
  return <div className="ticker" role="group" aria-label="Latest events: select one to show it on the pitch">
    {recent.length === 0 && <span className="hint" style={{ padding: '6px 4px' }}>Events appear here as the replay runs.</span>}
    {recent.map(event => <button key={`${event.run_id}:${event.event_id}`} type="button" className="feed-item"
      aria-pressed={selected?.event_id === event.event_id}
      onClick={() => onSelect(selected?.event_id === event.event_id ? undefined : event)}>
      <b><i className="team-bar" style={{ background: event.type === 'shot' ? 'var(--flood)' : teamTone(event.team_id) }} />{eventLabel(event)}</b>
      <span>{clockLabel(event.period, event.match_time_ms)} {event.player_id ? surname(people.get(event.player_id)) : ''}</span>
    </button>)}
  </div>;
});
