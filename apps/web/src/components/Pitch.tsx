import { useId, useMemo } from 'react';
import { motion } from 'motion/react';
import type { Event, PassLink, Player, PlayerStats } from '../types/contracts';
import { THREAT_GRID, THREAT_MAX } from '../lib/threatGrid';
import { eventLabel, playerIndex, surname, teamTone } from '../lib/format';

export interface PitchLayers { trail: boolean; threat: boolean; density: boolean; network: boolean }

interface PitchProps {
  events: Event[];
  selected?: Event;
  onSelect?: (event: Event) => void;
  layers?: PitchLayers;
  roster?: Player[];
  players?: PlayerStats[];
  network?: { team: string; links: PassLink[] };
  highlightIds?: string[];
  animate?: boolean;
  compact?: boolean;
}

const DEFAULT_LAYERS: PitchLayers = { trail: true, threat: false, density: false, network: false };
const located = (event: Event): event is Event & { start: NonNullable<Event['start']> } => event.start !== null;

/** Fixed 105 x 68 m frame, one viewBox unit per metre; x right, y down. Never rotated at halftime. */
export function Pitch({ events, selected, onSelect, layers = DEFAULT_LAYERS, roster = [], players = [], network,
  highlightIds, animate = true, compact = false }: PitchProps) {
  const id = useId();
  const people = useMemo(() => playerIndex(roster), [roster]);
  const focus = selected ?? [...events].reverse().find(located);
  const trail = useMemo(() => {
    if (highlightIds) return events.filter(event => highlightIds.includes(event.event_id) && located(event));
    if (!focus || !layers.trail) return [];
    const index = events.indexOf(focus);
    const recent = events.slice(Math.max(0, index - 10), index).filter(located);
    return recent.filter(event => event.possession_id === focus.possession_id || event.sequence >= focus.sequence - 3);
  }, [events, focus, layers.trail, highlightIds]);

  const density = useMemo(() => {
    if (!layers.density) return null;
    const cells = Array.from({ length: 12 }, () => new Array<number>(16).fill(0));
    for (const event of events) {
      if (!event.start) continue;
      cells[Math.min(11, Math.floor(event.start.y / 68 * 12))][Math.min(15, Math.floor(event.start.x / 105 * 16))] += 1;
    }
    return { cells, max: Math.max(1, ...cells.flat()) };
  }, [events, layers.density]);

  // Threat grid is team-relative; draw it in the frame of the team in focus.
  const threatFrame = focus?.attacking_direction ?? 'positive_x';
  const description = focus && focus.start
    ? `${eventLabel(focus)} by ${surname(people.get(focus.player_id ?? ''))} (${focus.team_id}) at (${focus.start.x}, ${focus.start.y})${focus.end ? ` to (${focus.end.x}, ${focus.end.y})` : ''} metres. ${focus.attacking_direction === 'positive_x' ? 'Attacking right' : 'Attacking left'}.`
    : 'No located event yet.';
  const directions = useMemo(() => {
    const latest = new Map<string, Event['attacking_direction']>();
    for (const event of events) if (event.team_id && event.attacking_direction && (!focus || event.period === focus.period)) latest.set(event.team_id, event.attacking_direction);
    return latest;
  }, [events, focus]);

  return <figure className="pitch-figure" style={{ margin: 0 }}>
    <svg viewBox="-4 -4 113 76" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>Synthetic match on a 105 by 68 metre pitch</title>
      <desc id={`${id}-desc`}>{description}</desc>
      <defs>
        {(['harbor', 'vale', 'flood'] as const).map(tone => <marker key={tone} id={`${id}-arrow-${tone}`} viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={`var(--${tone})`} />
        </marker>)}
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="#f2c94c" stopOpacity=".9" />
          <stop offset="100%" stopColor="#f2c94c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-vignette`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".18" />
          <stop offset=".25" stopColor="#000" stopOpacity="0" />
          <stop offset=".75" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".22" />
        </linearGradient>
      </defs>
      <rect x="-4" y="-4" width="113" height="76" fill="#183c2e" />
      {Array.from({ length: 12 }, (_, index) => <rect key={index} x={index * 8.75} y="0" width="8.75" height="68" fill={index % 2 ? 'var(--grass)' : 'var(--grass-2)'} />)}
      <rect x="-4" y="-4" width="113" height="76" fill={`url(#${id}-vignette)`} />

      {layers.threat && <g aria-hidden="true">
        {THREAT_GRID.values.map((row, cy) => row.map((value, cx) => {
          const x = threatFrame === 'positive_x' ? cx * 105 / 16 : 105 - (cx + 1) * 105 / 16;
          const y = threatFrame === 'positive_x' ? cy * 68 / 12 : 68 - (cy + 1) * 68 / 12;
          return <rect key={`${cx}-${cy}`} x={x} y={y} width={105 / 16} height={68 / 12} fill="var(--flood)" opacity={(value / THREAT_MAX) * .62} />;
        }))}
      </g>}
      {density && <g aria-hidden="true">
        {density.cells.map((row, cy) => row.map((count, cx) => count ? <rect key={`${cx}-${cy}`} x={cx * 105 / 16 + .25} y={cy * 68 / 12 + .25}
          width={105 / 16 - .5} height={68 / 12 - .5} rx=".8" fill="var(--vale)" opacity={.08 + (count / density.max) * .62} /> : null))}
      </g>}

      <g className="pitch-lines">
        <rect x="0" y="0" width="105" height="68" />
        <path d="M 52.5 0 V 68" />
        <circle cx="52.5" cy="34" r="9.15" />
        <rect x="0" y="13.84" width="16.5" height="40.32" />
        <rect x="88.5" y="13.84" width="16.5" height="40.32" />
        <rect x="0" y="24.84" width="5.5" height="18.32" />
        <rect x="99.5" y="24.84" width="5.5" height="18.32" />
        <path d="M 16.5 26.7 A 9.15 9.15 0 0 1 16.5 41.3 M 88.5 26.7 A 9.15 9.15 0 0 0 88.5 41.3" />
        <path d="M -2 30.34 H 0 M -2 30.34 V 37.66 H 0 M 105 30.34 H 107 V 37.66 H 105" />
      </g>
      <g fill="rgba(234,240,234,.8)"><circle cx="52.5" cy="34" r=".45" /><circle cx="11" cy="34" r=".45" /><circle cx="94" cy="34" r=".45" /></g>

      {!compact && [...directions].map(([team, direction], index) => {
        const right = direction === 'positive_x';
        return <text key={team} x={right ? 3 : 102} y={index ? 66.2 : 2.6} textAnchor={right ? 'start' : 'end'} fontSize="2.3"
          fill={teamTone(team)} style={{ fontFamily: 'var(--sans)', fontWeight: 600 }}>
          {right ? `${team === 'harbor' ? 'Harbor' : 'Vale'} attack →` : `← ${team === 'harbor' ? 'Harbor' : 'Vale'} attack`}
        </text>;
      })}

      {layers.network && network && <PassNetwork links={network.links} team={network.team} players={players} people={people}
        direction={directions.get(network.team) ?? (network.team === 'harbor' ? 'positive_x' : 'negative_x')} />}

      <g>
        {trail.map((event, index) => <EventMark key={`${event.run_id}:${event.event_id}`} event={event} arrowId={`${id}-arrow`}
          opacity={highlightIds ? 1 : .22 + .5 * (index + 1) / trail.length} onSelect={onSelect} />)}
      </g>
      {focus && focus.start && !highlightIds && <g>
        <EventMark event={focus} arrowId={`${id}-arrow`} opacity={1} onSelect={onSelect} focus />
        {/* Keyed so each new event replays the travel; the previous ball unmounts at once. */}
        <Ball key={`${focus.run_id}:${focus.event_id}`} event={focus} animate={animate} glow={`url(#${id}-glow)`} />
        {focus.player_id && !compact && <PlayerTag event={focus} player={people.get(focus.player_id)} />}
      </g>}
    </svg>
  </figure>;
}

function EventMark({ event, arrowId, opacity, onSelect, focus = false }: {
  event: Event; arrowId: string; opacity: number; onSelect?: (event: Event) => void; focus?: boolean;
}) {
  if (!event.start) return null;
  const tone = teamTone(event.team_id);
  const label = `${eventLabel(event)}, event ${event.sequence}`;
  const handlers = onSelect ? { onClick: () => onSelect(event), style: { cursor: 'pointer' } } : {};
  if ((event.type === 'pass' || event.type === 'shot') && event.end) {
    const dashed = event.outcome !== 'completed' && event.type === 'pass';
    const shot = event.type === 'shot';
    const marker = `${arrowId}-${shot ? 'flood' : event.team_id === 'vale' ? 'vale' : 'harbor'}`;
    return <g opacity={opacity} {...handlers} aria-label={label}>
      <line x1={event.start.x} y1={event.start.y} x2={event.end.x} y2={event.end.y} stroke={shot ? 'var(--flood)' : tone}
        strokeWidth={focus ? (shot ? .75 : .6) : .4} strokeDasharray={dashed ? '1.2 .9' : undefined} markerEnd={`url(#${marker})`} strokeLinecap="round" />
      <circle cx={event.start.x} cy={event.start.y} r={focus ? .95 : .6} fill="var(--night)" stroke={tone} strokeWidth=".35" />
      {shot && focus && event.is_goal && <GoalRipple x={event.end.x} y={event.end.y} />}
      {/* Wider transparent hit target for pointer users. */}
      {onSelect && <line x1={event.start.x} y1={event.start.y} x2={event.end.x} y2={event.end.y} stroke="transparent" strokeWidth="3" />}
    </g>;
  }
  const { x, y } = event.start;
  return <g opacity={opacity} {...handlers} aria-label={label}>
    {event.type === 'foul'
      ? <rect x={x - .9} y={y - .9} width="1.8" height="1.8" rx=".2" fill="var(--danger)" transform={`rotate(45 ${x} ${y})`} />
      : <path d={`M ${x - 1} ${y - 1} L ${x + 1} ${y + 1} M ${x + 1} ${y - 1} L ${x - 1} ${y + 1}`} stroke={tone} strokeWidth=".55" strokeLinecap="round" />}
    {focus && <circle cx={x} cy={y} r="2.2" fill="none" stroke={tone} strokeWidth=".25" opacity=".7" />}
  </g>;
}

function Ball({ event, animate, glow }: { event: Event; animate: boolean; glow: string }) {
  const start = event.start!;
  const end = event.end ?? start;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const duration = Math.min(.9, .25 + distance / 90);
  return <motion.g initial={animate ? { x: start.x, y: start.y, opacity: 0 } : { x: end.x, y: end.y, opacity: 1 }}
    animate={{ x: end.x, y: end.y, opacity: 1 }}
    transition={{ duration: animate ? duration : 0, ease: [0.22, 1, 0.36, 1] }}>
    <circle r="3.4" fill={glow} />
    <circle r="1.05" fill="#fdfdf8" stroke="#0f1e26" strokeWidth=".25" />
  </motion.g>;
}

function GoalRipple({ x, y }: { x: number; y: number }) {
  return <g aria-hidden="true">
    {[0, .35, .7].map(delay => <motion.circle key={delay} cx={x} cy={y} fill="none" stroke="var(--flood)" strokeWidth=".4"
      initial={{ r: 1, opacity: .9 }} animate={{ r: 9, opacity: 0 }} transition={{ duration: 1.6, delay, repeat: 2, ease: 'easeOut' }} />)}
  </g>;
}

function PlayerTag({ event, player }: { event: Event; player: Player | undefined }) {
  if (!player || !event.start) return null;
  const at = event.start;
  const label = `${player.shirt} ${surname(player)}`;
  const width = label.length * 1.15 + 2.4;
  const x = Math.min(103 - width, Math.max(2, at.x - width / 2));
  const y = at.y > 8 ? at.y - 4.6 : at.y + 2.4;
  return <motion.g initial={{ opacity: 0, y: 1 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25 }} aria-hidden="true">
    <rect x={x} y={y} width={width} height="3.1" rx="1.55" fill="rgba(15,30,38,.88)" stroke={teamTone(event.team_id)} strokeWidth=".2" />
    <text x={x + width / 2} y={y + 2.2} textAnchor="middle" fontSize="1.9" fill="var(--chalk)" style={{ fontFamily: 'var(--sans)', fontWeight: 600 }}>{label}</text>
  </motion.g>;
}

/** mean_action_location is in the team's attacking frame; draw it in the team's current direction. */
function PassNetwork({ links, team, players, people, direction }: {
  links: PassLink[]; team: string; players: PlayerStats[]; people: Map<string, Player>; direction: Event['attacking_direction'];
}) {
  const nodes = new Map(players.filter(player => player.team_id === team).map(player => [player.player_id, player]));
  const place = (point: { x: number; y: number }) => direction === 'negative_x' ? { x: 105 - point.x, y: 68 - point.y } : point;
  const max = Math.max(1, ...links.map(link => link.count));
  const tone = teamTone(team);
  return <g aria-label={`Pass network for ${team}: average action locations, not tracking`}>
    {links.map(link => {
      const from = nodes.get(link.from);
      const to = nodes.get(link.to);
      if (!from || !to) return null;
      const a = place(from.mean_action_location);
      const b = place(to.mean_action_location);
      return <line key={`${link.from}-${link.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone} strokeOpacity={.25 + .55 * link.count / max}
        strokeWidth={.2 + 1.1 * link.count / max} strokeLinecap="round" />;
    })}
    {[...nodes.values()].map(node => {
      const person = people.get(node.player_id);
      const at = place(node.mean_action_location);
      const r = 1.2 + Math.min(1.6, node.action_count / 40);
      return <g key={node.player_id}>
        <circle cx={at.x} cy={at.y} r={r} fill="var(--night)" stroke={tone} strokeWidth=".4" />
        <text x={at.x} y={at.y + .7} textAnchor="middle" fontSize="1.9" fill="var(--chalk)"
          style={{ fontFamily: 'var(--display)', fontWeight: 700 }}>{person?.shirt ?? ''}</text>
      </g>;
    })}
  </g>;
}
