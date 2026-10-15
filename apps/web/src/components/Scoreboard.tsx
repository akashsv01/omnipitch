import { AnimatePresence, motion } from 'motion/react';
import type { MatchState, MomentumBucket, ReplayInfo, TeamStats } from '../types/contracts';
import { clockLabel, fmt, runningClock } from '../lib/format';
import { Crest } from './Crest';

function Digit({ value, tone }: { value: number; tone: string }) {
  return <span className="digit" style={{ color: tone }}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={value} initial={{ y: '-100%', opacity: 0 }} animate={{ y: '0%', opacity: 1 }} exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}>{value}</motion.span>
    </AnimatePresence>
  </span>;
}

export function Scoreboard({ state, replay, clockMs, stats, goalKey }: {
  state: MatchState; replay: ReplayInfo; clockMs: number; stats: Record<string, TeamStats>; goalKey: string | null;
}) {
  const period = replay.clock_period;
  const finished = state.replay_status === 'finished';
  const atHalf = !finished && state.latest_event_sequence > 0 && period === 1 && clockMs >= 45 * 60000 && state.replay_status !== 'playing';
  const status = finished ? 'Full-time' : state.latest_event_sequence === 0 ? 'Pre-match' : period === 1 ? 'First half' : 'Second half';
  const home = stats[state.home_team.id];
  const away = stats[state.away_team.id];
  return <section className="scoreboard" aria-label="Scoreboard">
    <AnimatePresence>
      {goalKey && <motion.div key={goalKey} className="goal-flash" initial={{ opacity: .7 }} animate={{ opacity: 0 }} transition={{ duration: 1.6 }}
        style={{ background: 'radial-gradient(60% 120% at 50% 50%, rgba(242,201,76,.35), transparent 70%)' }} />}
    </AnimatePresence>
    <div className="side home">
      <Crest team={state.home_team.id} />
      <div style={{ minWidth: 0 }}>
        <div className="team-name">{state.home_team.name}</div>
        <div className="team-sub">Home · {home ? `${home.shots} shots, ${home.shots_on_target} on target` : '–'}</div>
      </div>
    </div>
    <div className="centre">
      <div className="score" aria-live="polite" aria-label={`${state.home_team.name} ${state.score.home}, ${state.away_team.name} ${state.score.away}`}>
        <Digit value={state.score.home} tone="var(--chalk)" />
        <span className="sep">:</span>
        <Digit value={state.score.away} tone="var(--chalk)" />
      </div>
      <div className="clock-row">
        <span className="clock" aria-label={`Match clock ${clockLabel(period, clockMs)}`}>{runningClock(period, clockMs)}</span>
        {state.replay_status === 'playing'
          ? <span className="live-chip"><i />Replaying</span>
          : <span className="period-chip">{atHalf ? 'Half-time' : status}</span>}
      </div>
    </div>
    <div className="side away">
      <Crest team={state.away_team.id} />
      <div style={{ minWidth: 0 }}>
        <div className="team-name">{state.away_team.name}</div>
        <div className="team-sub">Away · {away ? `${away.shots} shots, ${away.shots_on_target} on target` : '–'}</div>
      </div>
    </div>
  </section>;
}

/** Diverging bars: illustrative threat added by completed passes per five-minute bucket. */
export function Momentum({ buckets, analyst }: { buckets: MomentumBucket[]; analyst: boolean }) {
  const slots = 20; // 0-45+ per half -> 10 buckets each, stoppage folded into the last.
  const values = Array.from({ length: slots }, (_, index) => {
    const period = index < 10 ? 1 : 2;
    const bucket = index % 10;
    const matching = buckets.filter(b => b.period === period && Math.min(9, Math.floor(b.start_ms / 300000)) === bucket);
    return {
      harbor: matching.reduce((sum, b) => sum + (b.threat.harbor ?? 0), 0),
      vale: matching.reduce((sum, b) => sum + (b.threat.vale ?? 0), 0),
      seen: matching.length > 0,
    };
  });
  const max = Math.max(.4, ...values.map(v => Math.max(v.harbor, v.vale)));
  const width = 1000;
  const slot = width / slots;
  const totals = values.reduce((sum, v) => ({ harbor: sum.harbor + v.harbor, vale: sum.vale + v.vale }), { harbor: 0, vale: 0 });
  return <section className="momentum" aria-label="Attacking momentum">
    <div className="momentum-head">
      <span><strong>Attacking momentum</strong>{analyst ? ' · illustrative threat added by completed passes, 5-min buckets' : ' · who is moving the ball into danger'}</span>
      {analyst && <span>Harbor {fmt(totals.harbor, 2)} · Vale {fmt(totals.vale, 2)}</span>}
    </div>
    <svg viewBox={`0 -32 ${width} 66`} preserveAspectRatio="none" role="img" aria-label={`Momentum: Harbor ${fmt(totals.harbor, 2)}, Vale ${fmt(totals.vale, 2)} illustrative threat so far`}>
      <line x1="0" x2={width} y1="0" y2="0" stroke="var(--rule-strong)" strokeWidth="1" />
      <line x1={width / 2} x2={width / 2} y1="-30" y2="30" stroke="var(--rule-strong)" strokeDasharray="3 4" />
      {values.map((value, index) => <g key={index}>
        <motion.rect x={index * slot + 4} width={slot - 8} rx="3" fill="var(--harbor)"
          initial={false} animate={{ y: -(value.harbor / max) * 30, height: (value.harbor / max) * 30 }} transition={{ type: 'spring', stiffness: 160, damping: 24 }} />
        <motion.rect x={index * slot + 4} y={1} width={slot - 8} rx="3" fill="var(--vale)"
          initial={false} animate={{ height: (value.vale / max) * 30 }} transition={{ type: 'spring', stiffness: 160, damping: 24 }} />
        {!value.seen && <rect x={index * slot + 4} y="-1" width={slot - 8} height="2" rx="1" fill="var(--rule)" />}
      </g>)}
    </svg>
    <div className="momentum-head" style={{ marginTop: 4, marginBottom: 0 }}>
      <span>0'</span><span>Half-time</span><span>90'</span>
    </div>
  </section>;
}
