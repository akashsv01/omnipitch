import { useId, useMemo } from 'react';
import { motion } from 'motion/react';
import type { Event, PassLink, Player, PlayerStats } from '../types/contracts';
import { THREAT_GRID, THREAT_MAX } from '../lib/threatGrid';
import { clockLabel, eventLabel, playerIndex, surname, teamTone } from '../lib/format';
import { t } from '../lib/i18n';
import { EASE_OUT, travelSeconds } from '../lib/motion';
import { passLength } from '../lib/geometry';

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
  /** Evidence step currently selected in the drawer: drawn emphasised, the rest of the sequence dimmed. */
  emphasisId?: string;
  /** Sequence mode: number the highlighted actions in order and reveal them one after another. */
  numbered?: boolean;
  animate?: boolean;
  /** Replay speed: ball travel shortens as speed rises and stops at 20x so the drawing never lags the replay. */
  speed?: number;
  compact?: boolean;
}

const DEFAULT_LAYERS: PitchLayers = { trail: true, threat: false, density: false, network: false };
const located = (event: Event): event is Event & { start: NonNullable<Event['start']> } => event.start !== null;
const BALL_WIN = new Set(['tackle:won', 'interception:won', 'interception:completed', 'challenge:won']);
const isBallWin = (event: Event) => event.type === 'interception' || BALL_WIN.has(`${event.type}:${event.outcome}`);

/** Fixed 105 x 68 m frame, one viewBox unit per metre; x right, y down. Never rotated at halftime. */
export function Pitch({ events, selected, onSelect, layers = DEFAULT_LAYERS, roster = [], players = [], network,
  highlightIds, emphasisId, numbered = false, animate = true, speed = 1, compact = false }: PitchProps) {
  const id = useId();
  const people = useMemo(() => playerIndex(roster), [roster]);
  const focus = selected ?? [...events].reverse().find(located);
  const trail = useMemo(() => {
    if (highlightIds) return events.filter(event => highlightIds.includes(event.event_id) && located(event));
    if (!focus || !layers.trail) return [];
    const index = events.indexOf(focus);
    const recent = events.slice(Math.max(0, index - 10), index).filter(located);
    // Only the same possession (or the last few actions): never connect unrelated passages of play.
    return recent.filter(event => event.possession_id === focus.possession_id || event.sequence >= focus.sequence - 3);
  }, [events, focus, layers.trail, highlightIds]);

  const badges = useMemo(() => numbered ? badgeSpots(trail) : [], [numbered, trail]);
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
  const sequenceDescription = highlightIds && trail.length
    ? `Sequence of ${trail.length} recorded ${trail.length === 1 ? 'action' : 'actions'}: ${trail.map((event, index) =>
        `${index + 1}, ${eventLabel(event)} by ${surname(people.get(event.player_id ?? ''))} at (${event.start!.x}, ${event.start!.y})`).join('; ')}.`
    : null;
  const description = sequenceDescription ?? (focus && focus.start
    ? `${eventLabel(focus)} by ${surname(people.get(focus.player_id ?? ''))} (${focus.team_id}) at (${focus.start.x}, ${focus.start.y})${focus.end ? ` to (${focus.end.x}, ${focus.end.y})` : ''} metres. ${focus.attacking_direction === 'positive_x' ? 'Attacking right' : 'Attacking left'}.`
    : 'No located event yet.');
  // Attack directions for the period being shown: the highlighted sequence's own period when one is shown
  // (a first-half moment inspected during the second half must not take second-half directions).
  const shownPeriod = (highlightIds ? events.find(event => highlightIds.includes(event.event_id))?.period : undefined) ?? focus?.period;
  const directions = useMemo(() => {
    const latest = new Map<string, Event['attacking_direction']>();
    for (const event of events) if (event.team_id && event.attacking_direction && (!shownPeriod || event.period === shownPeriod)) latest.set(event.team_id, event.attacking_direction);
    return latest;
  }, [events, shownPeriod]);

  return <figure className="pitch-figure" style={{ margin: 0 }}>
    <svg viewBox="-4 -4 113 76" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>Synthetic match on a 105 by 68 metre pitch</title>
      <desc id={`${id}-desc`}>{description}</desc>
      <defs>
        {(['harbor', 'vale', 'flood'] as const).map(tone => <marker key={tone} id={`${id}-arrow-${tone}`} viewBox="0 0 10 10" refX="7" refY="5"
          markerWidth="2.6" markerHeight="2.6" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 L 2 5 z" fill={`var(--${tone})`} />
        </marker>)}
        <radialGradient id={`${id}-glow`}>
          <stop offset="0%" stopColor="#ebcb70" stopOpacity=".75" />
          <stop offset="100%" stopColor="#ebcb70" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-light`} cx="50%" cy="40%" r="70%">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".05" />
          <stop offset="1" stopColor="#000000" stopOpacity=".22" />
        </radialGradient>
      </defs>
      <rect x="-4" y="-4" width="113" height="76" fill="var(--turf-edge)" />
      {Array.from({ length: 12 }, (_, index) => <rect key={index} x={index * 8.75} y="0" width="8.75" height="68" fill={index % 2 ? 'var(--grass)' : 'var(--grass-2)'} />)}
      <rect x="-4" y="-4" width="113" height="76" fill={`url(#${id}-light)`} />

      {layers.threat && <g aria-hidden="true">
        {THREAT_GRID.values.map((row, cy) => row.map((value, cx) => {
          const x = threatFrame === 'positive_x' ? cx * 105 / 16 : 105 - (cx + 1) * 105 / 16;
          const y = threatFrame === 'positive_x' ? cy * 68 / 12 : 68 - (cy + 1) * 68 / 12;
          return <rect key={`${cx}-${cy}`} x={x} y={y} width={105 / 16} height={68 / 12} fill="var(--flood)" opacity={(value / THREAT_MAX) * .5} />;
        }))}
      </g>}
      {density && <g aria-hidden="true">
        {density.cells.map((row, cy) => row.map((count, cx) => count ? <rect key={`${cx}-${cy}`} x={cx * 105 / 16 + .25} y={cy * 68 / 12 + .25}
          width={105 / 16 - .5} height={68 / 12 - .5} rx=".6" fill="var(--vale)" opacity={.06 + (count / density.max) * .55} /> : null))}
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
        <path d="M -1.6 30.34 H 0 M -1.6 30.34 V 37.66 H 0 M 105 30.34 H 106.6 V 37.66 H 105" />
        <path d="M 0 1 A 1 1 0 0 0 1 0 M 104 0 A 1 1 0 0 0 105 1 M 0 67 A 1 1 0 0 1 1 68 M 104 68 A 1 1 0 0 1 105 67" />
      </g>
      <g fill="rgba(243,243,234,.7)"><circle cx="52.5" cy="34" r=".35" /><circle cx="11" cy="34" r=".35" /><circle cx="94" cy="34" r=".35" /></g>

      {/* Direction of attack sits in the margin, outside the field of play, so it never covers an action. */}
      {!compact && [...directions].map(([team, direction], index) => {
        const right = direction === 'positive_x';
        const name = team === 'harbor' ? 'Harbor' : 'Vale';
        return <text key={team} className="pitch-attack" x={right ? 1 : 104} y={index ? 70.9 : -1.3} textAnchor={right ? 'start' : 'end'} fontSize="1.9"
          fill={teamTone(team)} style={{ fontFamily: 'var(--sans)', fontWeight: 600 }}>
          {right ? `${name} ${t('attack')} →` : `← ${name} ${t('attack')}`}
        </text>;
      })}

      {layers.network && network && <PassNetwork links={network.links} team={network.team} players={players} people={people}
        direction={directions.get(network.team) ?? (network.team === 'harbor' ? 'positive_x' : 'negative_x')} />}

      <g>
        {trail.map((event, index) => {
          const mark = <EventMark key={`${event.run_id}:${event.event_id}`} event={event} arrowId={`${id}-arrow`}
            opacity={highlightIds ? (emphasisId && emphasisId !== event.event_id ? .35 : 1) : .18 + .52 * (index + 1) / trail.length}
            weight={highlightIds ? (emphasisId === event.event_id ? 1.6 : 1) : .7 + .3 * (index + 1) / trail.length}
            onSelect={onSelect} focus={emphasisId === event.event_id} />;
          if (!numbered) return mark;
          // Ordered reveal: each step fades in after the one before it (once, on mount).
          return <g key={`${event.run_id}:${event.event_id}`} className="seq-step"
            style={animate ? { animation: `step-in .24s cubic-bezier(.23,1,.32,1) ${Math.min(index, 12) * .09}s both` } : undefined}>
            {mark}
            <StepBadge at={badges[index]} team={event.team_id} n={index + 1} dim={!!emphasisId && emphasisId !== event.event_id} />
          </g>;
        })}
      </g>
      {focus && focus.start && !highlightIds && <g>
        {/* Keyed by event: a new event, seek or run change unmounts the old path and ball, cancelling their animation. */}
        <EventMark key={`mark:${focus.run_id}:${focus.event_id}`} event={focus} arrowId={`${id}-arrow`} opacity={1} weight={1.4} onSelect={onSelect} focus
          draw={animate ? travelSeconds(distance(focus), speed) : 0} />
        <Ball key={`ball:${focus.run_id}:${focus.event_id}`} event={focus} seconds={animate ? travelSeconds(distance(focus), speed) : 0} glow={`url(#${id}-glow)`} />
        {focus.player_id && !compact && <PlayerTag event={focus} player={people.get(focus.player_id)} />}
      </g>}
    </svg>
  </figure>;
}

/** Step badge positions beside each action's recorded start point. Consecutive actions often share a point
 * (a ball win and the pass that follows), so each badge takes the first corner that clears earlier badges. */
function badgeSpots(events: Event[]) {
  const placed: { x: number; y: number }[] = [];
  const corners = [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9], [0, -3.4], [0, 3.4]];
  for (const event of events) {
    if (!event.start) { placed.push({ x: -10, y: -10 }); continue; }
    const options = corners.map(([dx, dy]) => ({ x: Math.min(103.4, Math.max(1.6, event.start!.x + dx)), y: Math.min(66.4, Math.max(1.6, event.start!.y + dy)) }));
    placed.push(options.find(spot => placed.every(other => Math.hypot(other.x - spot.x, other.y - spot.y) > 3.1)) ?? options[0]);
  }
  return placed;
}

function StepBadge({ at, team, n, dim }: { at: { x: number; y: number }; team: string | null; n: number; dim: boolean }) {
  return <g aria-hidden="true" opacity={dim ? .45 : 1} pointerEvents="none">
    <circle cx={at.x} cy={at.y} r="1.45" fill="rgba(9,18,17,.92)" stroke={teamTone(team)} strokeWidth=".22" />
    <text x={at.x} y={at.y + .62} textAnchor="middle" fontSize="1.75" fill="var(--text)" style={{ fontFamily: 'var(--display)', fontWeight: 800 }}>{n}</text>
  </g>;
}

const distance = (event: Event) => event.start && event.end ? passLength(event.start, event.end) : 0;

function EventMark({ event, arrowId, opacity, weight = 1, onSelect, focus = false, draw = 0 }: {
  event: Event; arrowId: string; opacity: number; weight?: number; onSelect?: (event: Event) => void; focus?: boolean; draw?: number;
}) {
  if (!event.start) return null;
  const tone = teamTone(event.team_id);
  const label = `${eventLabel(event)}, ${clockLabel(event.period, event.match_time_ms)}`;
  const handlers = onSelect ? { onClick: () => onSelect(event), className: 'pitch-hit' } : {};
  if ((event.type === 'pass' || event.type === 'shot') && event.end) {
    const lost = event.outcome !== 'completed' && event.type === 'pass';
    const shot = event.type === 'shot';
    const marker = `${arrowId}-${shot ? 'flood' : event.team_id === 'vale' ? 'vale' : 'harbor'}`;
    const stroke = shot ? 'var(--flood)' : tone;
    const width = (shot ? .55 : .42) * weight;
    return <g opacity={opacity} {...handlers} aria-label={label}>
      {/* Recorded start and end points; the straight line between them is a summary, not a tracked path. */}
      <line x1={event.start.x} y1={event.start.y} x2={event.end.x} y2={event.end.y} stroke={stroke}
        strokeWidth={width} strokeDasharray={lost ? '1 .8' : undefined} markerEnd={lost ? undefined : `url(#${marker})`} strokeLinecap="round"
        style={draw && !lost ? { strokeDasharray: '200', strokeDashoffset: 0, animation: `pitch-draw ${draw}s cubic-bezier(.23,1,.32,1) both` } : undefined} />
      <circle cx={event.start.x} cy={event.start.y} r={focus ? .85 : .55} fill="var(--turf-edge)" stroke={stroke} strokeWidth=".3" />
      {lost && <path d={`M ${event.end.x - .8} ${event.end.y - .8} L ${event.end.x + .8} ${event.end.y + .8} M ${event.end.x + .8} ${event.end.y - .8} L ${event.end.x - .8} ${event.end.y + .8}`}
        stroke={tone} strokeWidth=".32" strokeLinecap="round" />}
      {shot && <ShotEnd event={event} />}
      {shot && focus && event.is_goal && <GoalRing x={event.end.x} y={event.end.y} />}
      {/* Wider transparent hit target for pointer users. */}
      {onSelect && <line x1={event.start.x} y1={event.start.y} x2={event.end.x} y2={event.end.y} stroke="transparent" strokeWidth="3" />}
    </g>;
  }
  const { x, y } = event.start;
  const win = isBallWin(event);
  return <g opacity={opacity} {...handlers} aria-label={label}>
    {event.type === 'foul'
      ? <rect x={x - .7} y={y - .9} width="1.4" height="1.8" rx=".2" fill="var(--danger)" />
      : <path d={`M ${x} ${y - 1.1} L ${x + 1.1} ${y} L ${x} ${y + 1.1} L ${x - 1.1} ${y} Z`} fill={win ? tone : '#0e2f23'} stroke={tone} strokeWidth=".3" />}
    {focus && <circle cx={x} cy={y} r="2.2" fill="none" stroke={tone} strokeWidth=".22" opacity=".8" />}
    {onSelect && <circle cx={x} cy={y} r="2.2" fill="transparent" />}
  </g>;
}

/** Shot end symbols: goal = filled ring, saved = bar across the line, wide = open circle, blocked = short bar. */
function ShotEnd({ event }: { event: Event }) {
  const end = event.end!, start = event.start!;
  const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
  if (event.is_goal) return <g><circle cx={end.x} cy={end.y} r="1.05" fill="var(--flood)" stroke="var(--turf-edge)" strokeWidth=".25" /></g>;
  if (event.outcome === 'off_target') return <circle cx={end.x} cy={end.y} r=".8" fill="none" stroke="var(--flood)" strokeWidth=".3" />;
  return <rect x={end.x - .25} y={end.y - 1} width=".5" height="2" rx=".2" fill="var(--flood)" transform={`rotate(${angle} ${end.x} ${end.y})`} />;
}

function Ball({ event, seconds, glow }: { event: Event; seconds: number; glow: string }) {
  const start = event.start!;
  const end = event.end ?? start;
  const to = `translate(${end.x}px, ${end.y}px)`;
  // Illustrative interpolation between two recorded points of the same event only.
  return <motion.g initial={seconds ? { transform: `translate(${start.x}px, ${start.y}px)`, opacity: .6 } : { transform: to, opacity: 1 }}
    animate={{ transform: to, opacity: 1 }} transition={{ duration: seconds, ease: EASE_OUT }}>
    <circle r="2.8" fill={glow} />
    <circle r=".95" fill="#fbfbf4" stroke="var(--turf-edge)" strokeWidth=".22" />
  </motion.g>;
}

/** Once per goal event (keyed by the event via its parent), never looping. */
function GoalRing({ x, y }: { x: number; y: number }) {
  return <motion.circle cx={x} cy={y} fill="none" stroke="var(--flood)" strokeWidth=".35" aria-hidden="true"
    initial={{ r: 1.2, opacity: .9 }} animate={{ r: 7, opacity: 0 }} transition={{ duration: 1.1, ease: EASE_OUT }} />;
}

/** One label for the action in focus, placed on the side away from its own line and kept inside the frame. */
function PlayerTag({ event, player }: { event: Event; player: Player | undefined }) {
  if (!player || !event.start) return null;
  const at = event.start;
  const goingUp = event.end ? event.end.y < at.y : false;
  const label = `${player.shirt} ${surname(player)}`;
  const width = label.length * 1.05 + 2.2;
  const x = Math.min(104.5 - width, Math.max(.5, at.x - width / 2));
  const below = goingUp ? at.y < 63 : at.y < 6;
  const y = below ? at.y + 2.1 : at.y - 4.9;
  return <g className="pitch-tag" aria-hidden="true">
    <rect x={x} y={y} width={width} height="2.8" rx=".7" fill="rgba(9,18,17,.88)" stroke={teamTone(event.team_id)} strokeWidth=".16" />
    <text x={x + width / 2} y={y + 1.98} textAnchor="middle" fontSize="1.7" fill="var(--text)" style={{ fontFamily: 'var(--sans)', fontWeight: 600 }}>{label}</text>
  </g>;
}

/** mean_action_location is in the team's attacking frame; draw it in the team's current direction. */
function PassNetwork({ links, team, players, people, direction }: {
  links: PassLink[]; team: string; players: PlayerStats[]; people: Map<string, Player>; direction: Event['attacking_direction'];
}) {
  const nodes = new Map(players.filter(player => player.team_id === team).map(player => [player.player_id, player]));
  const place = (point: { x: number; y: number }) => direction === 'negative_x' ? { x: 105 - point.x, y: 68 - point.y } : point;
  const max = Math.max(1, ...links.map(link => link.count));
  const tone = teamTone(team);
  return <g aria-label={`${t('Pass network for')} ${team}: ${t('average action locations, not tracking')}`}>
    {links.map(link => {
      const from = nodes.get(link.from);
      const to = nodes.get(link.to);
      if (!from || !to) return null;
      const a = place(from.mean_action_location);
      const b = place(to.mean_action_location);
      return <line key={`${link.from}-${link.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={tone} strokeOpacity={.2 + .5 * link.count / max}
        strokeWidth={.15 + 1 * link.count / max} strokeLinecap="round" />;
    })}
    {[...nodes.values()].map(node => {
      const person = people.get(node.player_id);
      const at = place(node.mean_action_location);
      const r = 1.1 + Math.min(1.4, node.action_count / 40);
      return <g key={node.player_id}>
        <circle cx={at.x} cy={at.y} r={r} fill="var(--turf-edge)" stroke={tone} strokeWidth=".35" />
        <text x={at.x} y={at.y + .62} textAnchor="middle" fontSize="1.7" fill="var(--text)"
          style={{ fontFamily: 'var(--display)', fontWeight: 700 }}>{person?.shirt ?? ''}</text>
      </g>;
    })}
  </g>;
}

/** Symbol key shared by the stage and the evidence drawer. */
export function PitchLegend({ compact = false }: { compact?: boolean }) {
  const swatch = (children: React.ReactNode) => <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">{children}</svg>;
  return <span className="legend">
    <span>{swatch(<line x1="1" y1="6" x2="15" y2="6" stroke="var(--harbor)" strokeWidth="2" />)}Harbor</span>
    <span>{swatch(<line x1="1" y1="6" x2="15" y2="6" stroke="var(--vale)" strokeWidth="2" />)}Vale</span>
    <span>{swatch(<line x1="1" y1="6" x2="15" y2="6" stroke="var(--text-2)" strokeWidth="2" strokeDasharray="3 2" />)}{t('Incomplete pass')}</span>
    <span>{swatch(<><line x1="1" y1="6" x2="12" y2="6" stroke="var(--flood)" strokeWidth="2" /><circle cx="14" cy="6" r="3" fill="var(--flood)" /></>)}{t('Shot / goal')}</span>
    {!compact && <span>{swatch(<path d="M9 1 L14 6 L9 11 L4 6 Z" fill="var(--text-2)" />)}{t('Ball won')}</span>}
    {!compact && <span>{swatch(<rect x="6" y="2" width="6" height="8" rx="1" fill="var(--danger)" />)}{t('Foul')}</span>}
  </span>;
}
