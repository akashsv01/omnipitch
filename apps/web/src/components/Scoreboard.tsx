import { AnimatePresence, motion } from 'motion/react';
import type { MatchState, MomentumBucket, ReplayInfo } from '../types/contracts';
import { clockLabel, fmt, runningClock, TEAM_META } from '../lib/format';
import { DUR, EASE_OUT } from '../lib/motion';
import { Crest } from './Crest';

/** A score digit that rolls once when the authoritative score changes (never on first render). */
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

export const STATE_LABEL: Record<ReplayState, string> = {
  pre: 'Ready to start', playing: 'Watching replay', paused: 'Paused', half: 'Half-time', finished: 'Full-time',
};

/** Compact match identity and score. Replay state lives here; backend connection lives in the nav;
 * inspecting a past moment is its own state, so it is never confused with "paused". */
export function ScoreStrip({ state, replay, clockMs, inspecting }: {
  state: MatchState; replay: ReplayInfo; clockMs: number; inspecting: string | null;
}) {
  const period = replay.clock_period;
  const status = replayState(state, replay, clockMs);
  const home = TEAM_META[state.home_team.id], away = TEAM_META[state.away_team.id];
  const periodLabel = status === 'pre' ? 'Kick-off' : status === 'half' ? 'Half-time' : status === 'finished' ? 'Full-time' : period === 1 ? 'First half' : 'Second half';
  return <section className="strip" aria-label="Score">
    <div className="strip-match">
      <div className="strip-team">
        <Crest key={`${state.run_id}-h`} team={state.home_team.id} tilt />
        <span className="name">{state.home_team.name}</span><span className="code" aria-hidden="true">{home?.short}</span>
      </div>
      <div className="strip-score" role="status" aria-label={`${state.home_team.name} ${state.score.home}, ${state.away_team.name} ${state.score.away}`}>
        <Digit value={state.score.home} /><span className="sep" aria-hidden="true">–</span><Digit value={state.score.away} />
      </div>
      <div className="strip-team away">
        <Crest key={`${state.run_id}-a`} team={state.away_team.id} tilt />
        <span className="name">{state.away_team.name}</span><span className="code" aria-hidden="true">{away?.short}</span>
      </div>
    </div>
    <div className="strip-clock">
      <b aria-label={`Match clock ${clockLabel(period, clockMs)}`}>{runningClock(period, clockMs)}</b>
      <span className="long">{periodLabel}</span>
      <span className="short">{status === 'pre' ? 'Ready' : status === 'half' ? 'HT' : status === 'finished' ? 'FT' : `${period}H · ${STATE_LABEL[status]}`}</span>
    </div>
    <div className="strip-state" data-state={inspecting ? 'inspecting' : status}>
      <i aria-hidden="true" />{inspecting ? `Inspecting sequence at ${inspecting}` : status === 'paused' ? `Paused at ${runningClock(period, clockMs)}` : STATE_LABEL[status]}
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

export function momentumSummary(buckets: MomentumBucket[]) {
  const { totals } = momentumSlots(buckets);
  return `Harbor ${fmt(totals.harbor, 2)}, Vale ${fmt(totals.vale, 2)}`;
}
