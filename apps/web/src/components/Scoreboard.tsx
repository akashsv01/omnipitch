import { AnimatePresence, motion } from 'motion/react';
import type { MatchState, MomentumBucket, ReplayInfo } from '../types/contracts';
import { clockLabel, fmt, runningClock, TEAM_META } from '../lib/format';
import { DUR, EASE_OUT } from '../lib/motion';
import { Crest } from './Crest';

/** A score digit that rolls once when the value changes (never on first render). */
function Digit({ value }: { value: number }) {
  return <span className="digit">
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={value} initial={{ transform: 'translateY(-70%)', opacity: 0 }} animate={{ transform: 'translateY(0%)', opacity: 1 }}
        exit={{ transform: 'translateY(70%)', opacity: 0 }} transition={{ duration: DUR.enter, ease: EASE_OUT }}>{value}</motion.span>
    </AnimatePresence>
  </span>;
}

export type ReplayState = 'pre' | 'playing' | 'paused' | 'half' | 'finished';

export function replayState(state: MatchState, replay: ReplayInfo, clockMs: number): ReplayState {
  if (state.replay_status === 'finished') return 'finished';
  if (state.latest_event_sequence === 0) return 'pre';
  if (state.replay_status === 'playing') return 'playing';
  return replay.clock_period === 1 && clockMs >= 45 * 60000 ? 'half' : 'paused';
}

const STATE_LABEL: Record<ReplayState, string> = {
  pre: 'Pre-match', playing: 'Replaying', paused: 'Paused', half: 'Half-time', finished: 'Full-time',
};

/** Compact broadcast scorebug: identities, score, clock and period, and the replay's own state.
 * Connection state is shown separately in the top bar so "paused" is never confused with "offline". */
export function Scorebug({ state, replay, clockMs, goalKey }: {
  state: MatchState; replay: ReplayInfo; clockMs: number; goalKey: string | null;
}) {
  const period = replay.clock_period;
  const status = replayState(state, replay, clockMs);
  const periodLabel = state.latest_event_sequence === 0 ? 'Kick-off 0:00' : period === 1 ? 'First half' : 'Second half';
  const home = TEAM_META[state.home_team.id], away = TEAM_META[state.away_team.id];
  return <section className="scorebug" aria-label="Scorebug">
    <AnimatePresence>
      {goalKey && <motion.div key={goalKey} className="goal-flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 1.2, ease: 'easeOut' }} />}
    </AnimatePresence>
    <span className="bug-stripe" style={{ background: 'var(--harbor)' }} />
    <div className="bug-team">
      <Crest team={state.home_team.id} />
      <span className="bug-name">{state.home_team.name}</span>
      <span className="bug-short" aria-hidden="true">{home?.short}</span>
    </div>
    <div className="bug-score" role="status" aria-label={`${state.home_team.name} ${state.score.home}, ${state.away_team.name} ${state.score.away}`}>
      <Digit value={state.score.home} /><span className="sep" aria-hidden="true">–</span><Digit value={state.score.away} />
    </div>
    <div className="bug-team away">
      <Crest team={state.away_team.id} />
      <span className="bug-name">{state.away_team.name}</span>
      <span className="bug-short" aria-hidden="true">{away?.short}</span>
    </div>
    <span className="bug-stripe" style={{ background: 'var(--vale)' }} />
    <div className="bug-clock">
      <b aria-label={`Match clock ${clockLabel(period, clockMs)}`}>{runningClock(period, clockMs)}</b>
      <span className="long">{status === 'half' ? 'Half-time' : status === 'finished' ? 'Full-time' : periodLabel}</span>
      <span className="short">{status === 'half' ? 'HT' : status === 'finished' ? 'FT' : state.latest_event_sequence === 0 ? 'Pre-match' : `${period}H · ${STATE_LABEL[status]}`}</span>
    </div>
    <div className="bug-state" data-state={status} title="Replay state (connection is shown in the top bar)">
      <i aria-hidden="true" /><span>{STATE_LABEL[status]}</span>
      <span className="sr-only">Replay {STATE_LABEL[status].toLowerCase()}</span>
    </div>
  </section>;
}

export interface MomentumSlot { harbor: number; vale: number; seen: boolean }

/** Twenty 5-minute slots (stoppage folded into each half's last slot) of illustrative threat from completed passes. */
export function momentumSlots(buckets: MomentumBucket[]): { values: MomentumSlot[]; max: number; totals: { harbor: number; vale: number } } {
  const values = Array.from({ length: 20 }, (_, index) => {
    const period = index < 10 ? 1 : 2;
    const matching = buckets.filter(b => b.period === period && Math.min(9, Math.floor(b.start_ms / 300000)) === index % 10);
    return {
      harbor: matching.reduce((sum, b) => sum + (b.threat.harbor ?? 0), 0),
      vale: matching.reduce((sum, b) => sum + (b.threat.vale ?? 0), 0),
      seen: matching.length > 0,
    };
  });
  const totals = values.reduce((sum, v) => ({ harbor: sum.harbor + v.harbor, vale: sum.vale + v.vale }), { harbor: 0, vale: 0 });
  return { values, max: Math.max(.4, ...values.map(v => Math.max(v.harbor, v.vale))), totals };
}

/** Diverging bars drawn behind the scrubber: Harbor above the line, Vale below. Positions follow the replay
 * timeline (first half up to the half-time marker, second half after it). Static SVG: no per-frame animation. */
export function MomentumTrack({ buckets, halfFraction }: { buckets: MomentumBucket[]; halfFraction: number }) {
  const { values, max, totals } = momentumSlots(buckets);
  const width = 1000, mid = 15, scale = 13;
  const slotX = (index: number) => index < 10 ? (index / 10) * halfFraction * width : (halfFraction + ((index - 10) / 10) * (1 - halfFraction)) * width;
  const slotW = (index: number) => (index < 10 ? halfFraction : 1 - halfFraction) * width / 10;
  return <svg className="scrub-momentum" viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" aria-hidden="true"
    data-totals={`${fmt(totals.harbor, 2)}|${fmt(totals.vale, 2)}`}>
    <line x1="0" x2={width} y1={mid} y2={mid} stroke="var(--hairline-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    {values.map((value, index) => {
      const x = slotX(index) + 2, w = Math.max(1, slotW(index) - 4);
      const h = (value.harbor / max) * scale, v = (value.vale / max) * scale;
      return <g key={index}>
        {h > 0 && <rect x={x} y={mid - h} width={w} height={h} rx="1.5" fill="var(--harbor)" opacity=".85" />}
        {v > 0 && <rect x={x} y={mid + 1} width={w} height={v} rx="1.5" fill="var(--vale)" opacity=".85" />}
      </g>;
    })}
  </svg>;
}

export function momentumSummary(buckets: MomentumBucket[]) {
  const { totals } = momentumSlots(buckets);
  return `Harbor ${fmt(totals.harbor, 2)}, Vale ${fmt(totals.vale, 2)}`;
}
