import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Flame, GitFork, Grid3x3, Route } from 'lucide-react';
import type { Event, ReplaySnapshot } from '../types/contracts';
import type { Audience, Prefs } from '../lib/prefs';
import { clockLabel, eventLabel, playerIndex, surname, teamTone } from '../lib/format';
import { Pitch } from './Pitch';

const LAYERS = [
  { key: 'trail', label: 'Recent play', icon: Route },
  { key: 'threat', label: 'Threat grid', icon: Flame },
  { key: 'density', label: 'Event density', icon: Grid3x3 },
  { key: 'network', label: 'Pass network', icon: GitFork },
] as const;

export function MatchStage({ replay, selected, onSelect, prefs, updatePrefs, goal, animate, audience }: {
  replay: ReplaySnapshot; selected?: Event; onSelect: (event: Event | undefined) => void; prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void; goal: Event | null; animate: boolean; audience: Audience;
}) {
  const people = useMemo(() => playerIndex(replay.replay.roster), [replay.replay.roster]);
  const recent = useMemo(() => replay.events.slice(-16).reverse(), [replay.events]);
  const focus = selected ?? [...replay.events].reverse().find(event => event.start);
  const networkTeam = prefs.favoriteTeam ?? focus?.team_id ?? 'harbor';
  const caption = prefs.layers.density ? 'Event density uses action locations only, not player tracking.'
    : prefs.layers.network ? `Pass network for ${networkTeam === 'harbor' ? 'Harbor' : 'Vale'}, drawn in their current attacking direction: nodes sit at each player's average action location, not tracked positions.`
    : prefs.layers.threat ? `Illustrative threat grid in ${focus?.team_id === 'vale' ? 'Vale' : 'Harbor'}'s attacking frame. Hand-designed, not a scoring probability.`
    : 'Ball path animates between recorded event locations; it is not observed tracking.';

  return <section className="panel pitch-panel" aria-labelledby="pitch-title">
    <div className="panel-head">
      <div>
        <h2 className="panel-title" id="pitch-title">Live pitch</h2>
        <p className="panel-sub">{selected ? 'Showing a selected event. ' : 'Following the newest event. '}105 × 68 m, fixed frame</p>
      </div>
      <div className="layer-chips" role="group" aria-label="Pitch layers">
        {LAYERS.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="chip" aria-pressed={prefs.layers[key]}
          onClick={() => updatePrefs({ layers: { ...prefs.layers, [key]: !prefs.layers[key], ...(key === 'density' && !prefs.layers.density ? { threat: false } : {}), ...(key === 'threat' && !prefs.layers.threat ? { density: false } : {}) } })}>
          <Icon size={14} aria-hidden="true" />{label}
        </button>)}
      </div>
    </div>
    <div className="pitch-wrap">
      <Pitch events={replay.events} selected={selected} onSelect={onSelect} layers={prefs.layers} roster={replay.replay.roster}
        players={replay.analysis.players} network={{ team: networkTeam, links: replay.analysis.pass_network[networkTeam] ?? [] }} animate={animate} />
      <AnimatePresence>
        {goal && <motion.div key={goal.event_id} className="goal-banner" aria-hidden="true"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .3 }}
          style={{ background: `radial-gradient(70% 90% at 50% 50%, color-mix(in srgb, ${teamTone(goal.team_id)} 32%, transparent), transparent 75%)` }}>
          <motion.div initial={animate ? { scale: .6, y: 30, letterSpacing: '0.3em' } : false} animate={{ scale: 1, y: 0, letterSpacing: '0.02em' }}
            transition={{ type: 'spring', stiffness: 260, damping: 18 }}>
            GOAL
            <small>{surname(people.get(goal.player_id ?? ''))} · {goal.team_id === 'harbor' ? 'Harbor Comets' : 'Vale Owls'} · {clockLabel(goal.period, goal.match_time_ms)}</small>
          </motion.div>
        </motion.div>}
      </AnimatePresence>
    </div>
    <div className="pitch-caption">
      <span>{caption}</span>
      <span className="legend">
        <span><i style={{ background: 'var(--harbor)' }} />Harbor</span>
        <span><i style={{ background: 'var(--vale)' }} />Vale</span>
        <span><i style={{ background: 'var(--flood)' }} />Shot</span>
        <span><i style={{ border: '1.5px dashed var(--chalk-dim)', background: 'transparent' }} />Pass lost</span>
      </span>
    </div>
    {focus && <SelectedLine event={focus} name={people.get(focus.player_id ?? '')?.name} audience={audience} pinned={!!selected} onClear={() => onSelect(undefined)} />}
    <div className="feed" role="group" aria-label="Latest events: select one to show it on the pitch">
      {recent.length === 0 && <span className="hint" style={{ padding: '6px 4px' }}>Events appear here as the replay runs.</span>}
      <AnimatePresence initial={false}>
        {recent.map(event => <motion.button layout="position" key={`${event.run_id}:${event.event_id}`} type="button" className="feed-item"
          aria-pressed={selected?.event_id === event.event_id}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          onClick={() => onSelect(selected?.event_id === event.event_id ? undefined : event)}>
          <b><i className="team-bar" style={{ background: event.type === 'shot' ? 'var(--flood)' : teamTone(event.team_id) }} />{eventLabel(event)}</b>
          <span>{clockLabel(event.period, event.match_time_ms)} {event.player_id ? surname(people.get(event.player_id)) : ''}</span>
        </motion.button>)}
      </AnimatePresence>
    </div>
  </section>;
}

function SelectedLine({ event, name, audience, pinned, onClear }: { event: Event; name?: string; audience: Audience; pinned: boolean; onClear: () => void }) {
  const detail = audience === 'analyst' && event.start
    ? `(${event.start.x}, ${event.start.y})${event.end ? ` → (${event.end.x}, ${event.end.y})` : ''} m · ${event.attacking_direction === 'positive_x' ? 'attacking +x' : 'attacking −x'} · ${event.event_id}`
    : '';
  return <div className="pitch-caption" style={{ color: 'var(--chalk-dim)', alignItems: 'center' }}>
    <span><b style={{ color: 'var(--chalk)', fontWeight: 600 }}>{eventLabel(event)}</b>{name ? ` by ${name}` : ''}, {clockLabel(event.period, event.match_time_ms)}{detail && <span className="mono" style={{ color: 'var(--chalk-faint)' }}> · {detail}</span>}</span>
    {pinned && <button type="button" className="text-button" onClick={onClear}>Follow live</button>}
  </div>;
}
