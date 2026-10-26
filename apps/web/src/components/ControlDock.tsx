import { memo, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CornerDownRight, Dices, FileUp, Pause, Play, RotateCcw, Shuffle } from 'lucide-react';
import type { Moment, ReplaySnapshot, Scenario, Speed } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, clockLabel, runningClock, teamTone } from '../lib/format';
import { INDICATOR, POPOVER } from '../lib/motion';
import { momentumSlots, momentumSummary } from './Scoreboard';

const SPEEDS: Speed[] = [1, 5, 10, 20, 40, 80];
const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'Build-up, a pressing spell and late pressure' },
  { id: 'high_press', label: 'High press', hint: 'Vale press high all match' },
  { id: 'quiet', label: 'Quiet', hint: 'Low tempo; few chances, few moments' },
];

/** The replay window of the moment being inspected, on the replay timeline (ms). */
export interface FilmRange { from: number; to: number; label: string }

/** Match filmstrip: a match-time scale with a playhead, the momentum band, moment markers, the inspected
 * sequence range and the replay controls. Reserved space below the stage; a fixed thumb bar on phones. */
export function Filmstrip({ replay, elapsed, busy, disabled, audience, range, onReturn, onPlay, onPause, onReset, onSpeed, onSeek, onGenerate, onLoad }: {
  replay: ReplaySnapshot; elapsed: number; busy: boolean; disabled: boolean; audience: Audience;
  range: FilmRange | null; onReturn: () => void;
  onPlay: () => void; onPause: () => void; onReset: () => void; onSpeed: (speed: Speed) => void; onSeek: (ms: number) => void;
  onGenerate: (seed: number, scenario: Scenario) => void; onLoad: (file: File) => void;
}) {
  const { state, replay: info } = replay;
  const playing = state.replay_status === 'playing';
  const finished = state.replay_status === 'finished';
  const [open, setOpen] = useState(false);
  const label = playing ? 'Pause replay' : finished ? 'Replay finished. Reset to watch again' : state.latest_event_sequence ? 'Resume replay' : 'Play replay';
  // The same running clock as the score strip (26:02, not the broadcast minute 27'), so the two never disagree.
  const now = state.latest_event_sequence ? runningClock(info.clock_period, info.clock_ms) : '00:00';
  return <section className="film" aria-label="Replay controls">
    <div className="film-controls">
      <button type="button" className="play" aria-label={label} title={label} disabled={disabled || finished} onClick={playing ? onPause : onPlay}>
        {playing ? <Pause size={20} fill="currentColor" aria-hidden="true" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 3 }} aria-hidden="true" />}
      </button>
      <select className="speed-select" aria-label="Playback speed" value={info.speed} disabled={disabled}
        onChange={event => onSpeed(Number(event.target.value) as Speed)}>
        {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
      </select>
      <div className="film-sub" style={{ position: 'relative' }}>
        <button type="button" className="icon-button" style={{ width: 34, height: 34 }} onClick={onReset} disabled={disabled} aria-label="Reset run (new run ID)" title="Reset run: same match, new run ID"><RotateCcw size={15} /></button>
        <button type="button" className="icon-button" style={{ width: 34, height: 34 }} aria-expanded={open} aria-haspopup="dialog" aria-label="New match" title="New match"
          onClick={() => setOpen(value => !value)} disabled={disabled}><Shuffle size={15} /></button>
        <AnimatePresence>
          {open && <NewMatch current={info} busy={busy} onClose={() => setOpen(false)} onReset={onReset}
            onGenerate={(seed, scenario) => { onGenerate(seed, scenario); setOpen(false); }}
            onLoad={file => { onLoad(file); setOpen(false); }} />}
        </AnimatePresence>
      </div>
    </div>
    <div className="film-main">
      <div className="film-top">
        <span><b>{now}</b> · {finished ? 'Full-time' : playing ? `Watching replay at ${info.speed}×` : state.latest_event_sequence ? 'Paused' : 'Kick-off'}</span>
        {range && <button type="button" className="text-button back" onClick={onReturn}>
          <CornerDownRight size={14} aria-hidden="true" />Return to replay
        </button>}
      </div>
      <Track replay={replay} elapsed={elapsed} disabled={disabled} onSeek={onSeek} range={range} />
      <p className="film-note" id="momentum-note">{audience === 'analyst'
        ? <>Band: illustrative threat added by completed passes per 5 minutes (Harbor above, Vale below). Not a probability. {momentumSummary(replay.analysis.momentum)}.</>
        : <>The band shows who moved the ball into danger, Harbor above and Vale below. It is not a win probability.</>}</p>
    </div>
  </section>;
}

const Track = memo(function Track({ replay, elapsed, disabled, onSeek, range }: {
  replay: ReplaySnapshot; elapsed: number; disabled: boolean; onSeek: (ms: number) => void; range: FilmRange | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const duration = Math.max(1, replay.replay.duration_ms);
  const fraction = Math.min(1, Math.max(0, elapsed / duration));
  const half = replay.events.find(event => event.type === 'period_end' && event.period === 1);
  // The replay timeline is the two periods back to back; without the first period_end yet, assume an even split.
  const halfFraction = half ? Math.min(.9, Math.max(.1, half.match_time_ms / duration)) : 0.5;
  const fromPointer = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const step = 60_000;
  const elapsedMinutes = Math.floor(elapsed / 60000);
  const totalMinutes = Math.floor(duration / 60000);
  const pins = replay.moments.filter(m => m.rule === 'goal' || m.priority >= 2);
  const ticks = replay.moments.filter(m => m.rule !== 'goal' && m.priority < 2);
  const now = replay.state.latest_event_sequence ? clockLabel(replay.replay.clock_period, replay.replay.clock_ms) : "0'";
  // Match-time labels for a replay position: first half up to the half-time mark, then the second half.
  const matchLabel = (ms: number) => {
    const split = halfFraction * duration;
    return ms <= split ? clockLabel(1, ms) : clockLabel(2, ms - split);
  };
  const near = hover === null ? undefined : replay.moments.find(m => Math.abs(m.replay_ms / duration - hover) < .012);
  return <div ref={track} className="film-track" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Replay position"
    aria-valuemin={0} aria-valuemax={totalMinutes} aria-valuenow={elapsedMinutes}
    aria-valuetext={`Match clock ${now}; ${elapsedMinutes} of ${totalMinutes} replay minutes`} aria-disabled={disabled}
    aria-describedby="momentum-note"
    onPointerDown={event => { if (!disabled) onSeek(fromPointer(event.clientX) * duration); }}
    onPointerMove={event => setHover(fromPointer(event.clientX))} onPointerLeave={() => setHover(null)}
    onKeyDown={event => {
      if (disabled) return;
      const keys: Record<string, number> = { ArrowRight: elapsed + step * (event.shiftKey ? 5 : 1), ArrowLeft: elapsed - step * (event.shiftKey ? 5 : 1), Home: 0, End: duration };
      if (event.key in keys) { event.preventDefault(); onSeek(Math.min(duration, Math.max(0, keys[event.key]))); }
    }}>
    <div className="film-band"><MomentumBand replay={replay} halfFraction={halfFraction} />
      {/* What has been played is lit; the future stays dark. */}
      <div className="film-played" style={{ transform: `scaleX(${fraction})` }} />
    </div>
    <div className="film-ht" style={{ left: `${halfFraction * 100}%` }} title="Half-time" />
    {range && <div className="film-range" title={range.label}
      style={{ left: `${Math.min(range.from, range.to) / duration * 100}%`, width: `${Math.abs(range.to - range.from) / duration * 100}%` }} />}
    {ticks.map(moment => <i key={moment.moment_id} className="film-tick" aria-hidden="true"
      style={{ left: `${(moment.replay_ms / duration) * 100}%`, ['--tone' as string]: teamTone(moment.team_id) }} />)}
    {pins.map(moment => <Pin key={moment.moment_id} moment={moment} duration={duration} onSeek={onSeek} disabled={disabled} />)}
    {hover !== null && <>
      <div className="film-hover" style={{ left: `${hover * 100}%` }} />
      <div className="film-preview" aria-hidden="true" style={{ left: `clamp(60px, ${hover * 100}%, calc(100% - 60px))` }}>
        {matchLabel(hover * duration)}{near ? ` · ${RULE_LABEL[near.rule]}` : ''}
      </div>
    </>}
    <div className="film-head" style={{ left: `${fraction * 100}%` }} />
    {/* Fixed match minutes, placed by the real length of each half (stoppage time included). */}
    <div className="film-scale" aria-hidden="true">
      <span style={{ left: 0 }}>0'</span>
      {[15, 30].map(minute => minute * 60000 < halfFraction * duration - 120000
        && <span key={minute} style={{ left: `${minute * 60000 / duration * 100}%` }}>{minute}'</span>)}
      <span style={{ left: `${halfFraction * 100}%` }}>HT</span>
      {[60, 75].map(minute => halfFraction * duration + (minute - 45) * 60000 < duration - 120000
        && <span key={minute} style={{ left: `${(halfFraction * duration + (minute - 45) * 60000) / duration * 100}%` }}>{minute}'</span>)}
      <span style={{ left: '100%' }}>FT</span>
    </div>
  </div>;
});

/** Static momentum bars (one per 5-minute slot): no spring, so heights can never overshoot below zero. */
function MomentumBand({ replay, halfFraction }: { replay: ReplaySnapshot; halfFraction: number }) {
  const { values, max } = useMemo(() => momentumSlots(replay.analysis.momentum), [replay.analysis.momentum]);
  const x = (index: number) => index < 10 ? index / 10 * halfFraction * 100 : (halfFraction + (index - 10) / 10 * (1 - halfFraction)) * 100;
  const w = (index: number) => (index < 10 ? halfFraction : 1 - halfFraction) * 10 - .5;
  return <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="13" x2="100" y2="13" stroke="rgba(243,243,234,.1)" strokeWidth=".4" vectorEffect="non-scaling-stroke" />
    {values.map((slot, index) => slot.seen && <g key={index}>
      <rect x={x(index) + .25} y={13 - Math.max(0, slot.harbor / max * 12)} width={Math.max(.2, w(index))} height={Math.max(0, slot.harbor / max * 12)} fill="var(--harbor)" opacity=".7" />
      <rect x={x(index) + .25} y={13} width={Math.max(.2, w(index))} height={Math.max(0, slot.vale / max * 12)} fill="var(--vale)" opacity=".7" />
    </g>)}
  </svg>;
}

function Pin({ moment, duration, onSeek, disabled }: { moment: Moment; duration: number; onSeek: (ms: number) => void; disabled: boolean }) {
  const goal = moment.rule === 'goal';
  return <button type="button" className="film-pin" data-rule={moment.rule} tabIndex={-1} disabled={disabled}
    style={{ left: `${(moment.replay_ms / duration) * 100}%`, ['--tone' as string]: teamTone(moment.team_id) }}
    title={`${clockLabel(moment.period, moment.match_time_ms)} ${RULE_LABEL[moment.rule]}: ${moment.insight.headline}`}
    aria-label={`Jump to ${RULE_LABEL[moment.rule]} at ${clockLabel(moment.period, moment.match_time_ms)}`}
    onPointerDown={event => { event.stopPropagation(); onSeek(moment.replay_ms); }}>
    {goal && <b>Goal {clockLabel(moment.period, moment.match_time_ms)}</b>}<i />
  </button>;
}

function NewMatch({ current, busy, onClose, onGenerate, onLoad, onReset }: {
  current: ReplaySnapshot['replay']; busy: boolean; onClose: () => void; onReset: () => void;
  onGenerate: (seed: number, scenario: Scenario) => void; onLoad: (file: File) => void;
}) {
  const [seed, setSeed] = useState(String(current.seed ?? 7));
  const [scenario, setScenario] = useState<Scenario>((current.scenario as Scenario) ?? 'standard');
  const valid = /^\d{1,9}$/.test(seed);
  const azure = current.backend_mode === 'azure';
  return <motion.div className="popover up" role="dialog" aria-label="New match" {...POPOVER}
    style={{ left: 0, right: 'auto', transformOrigin: 'bottom left' }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <h3>Start a new match</h3>
    <div className="field">
      <span>Scenario</span>
      <div className="segmented small" role="radiogroup" aria-label="Scenario">
        {SCENARIOS.map(item => <button key={item.id} type="button" role="radio" aria-checked={scenario === item.id} onClick={() => setScenario(item.id)}>
          {scenario === item.id && <motion.span layoutId="scenario-thumb" className="thumb" transition={INDICATOR} />}{item.label}
        </button>)}
      </div>
      <span className="hint">{SCENARIOS.find(item => item.id === scenario)?.hint}</span>
    </div>
    <div className="field-row">
      <label className="field">Seed
        <input inputMode="numeric" name="seed" autoComplete="off" value={seed} onChange={event => setSeed(event.target.value.replace(/\D/g, '').slice(0, 9))} aria-invalid={!valid} />
      </label>
      <button type="button" className="icon-button" style={{ width: 38, height: 38 }} aria-label="Random seed"
        onClick={() => setSeed(String(Math.floor(Math.random() * 100000)))}><Dices size={17} /></button>
    </div>
    <button type="button" className="button primary" disabled={!valid || busy || azure} onClick={() => onGenerate(Number(seed), scenario)}>Generate match</button>
    {azure && <p className="hint">Azure mode reads matches from Fabric Eventhouse. Publish a run with the simulator CLI, then load it from the Data quality tab.</p>}
    <div style={{ display: 'flex', gap: 8 }}>
      <label className="button file-button" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <FileUp size={15} aria-hidden="true" />Load JSONL
        <input type="file" accept=".jsonl,application/x-ndjson" aria-label="Load JSONL file" disabled={azure} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) onLoad(file);
          }} />
      </label>
      <button type="button" className="button" onClick={() => { onReset(); onClose(); }}><RotateCcw size={15} aria-hidden="true" />Reset run</button>
    </div>
    <p className="hint">Each match is a new run with its own ID. The same seed and scenario always produce the same events.</p>
  </motion.div>;
}
