import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Dices, FileUp, Pause, Play, RotateCcw, Shuffle } from 'lucide-react';
import type { Moment, ReplaySnapshot, Scenario, Speed } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, clockLabel, teamTone } from '../lib/format';
import { INDICATOR, POPOVER } from '../lib/motion';
import { MomentumTrack, momentumSummary } from './Scoreboard';

const SPEEDS: Speed[] = [1, 5, 10, 20, 40, 80];
const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'Build-up, a pressing spell and late pressure' },
  { id: 'high_press', label: 'High press', hint: 'Vale press high all match' },
  { id: 'quiet', label: 'Quiet', hint: 'Low tempo; few chances, few moments' },
];

/** Replay controls in reserved space under the pitch (a fixed bar on phones, with the page padded for it). */
export function ControlDock({ replay, elapsed, busy, disabled, audience, onPlay, onPause, onReset, onSpeed, onSeek, onGenerate, onLoad }: {
  replay: ReplaySnapshot; elapsed: number; busy: boolean; disabled: boolean; audience: Audience;
  onPlay: () => void; onPause: () => void; onReset: () => void; onSpeed: (speed: Speed) => void; onSeek: (ms: number) => void;
  onGenerate: (seed: number, scenario: Scenario) => void; onLoad: (file: File) => void;
}) {
  const { state, replay: info } = replay;
  const playing = state.replay_status === 'playing';
  const finished = state.replay_status === 'finished';
  const [open, setOpen] = useState(false);
  const label = playing ? 'Pause replay' : finished ? 'Replay finished. Reset to watch again' : state.latest_event_sequence ? 'Resume replay' : 'Play replay';
  return <div className="replay-bar" role="region" aria-label="Replay controls">
    <button type="button" className="play" aria-label={label} title={label} disabled={disabled || finished} onClick={playing ? onPause : onPlay}>
      {playing ? <Pause size={19} fill="currentColor" aria-hidden="true" /> : <Play size={19} fill="currentColor" style={{ marginLeft: 2 }} aria-hidden="true" />}
    </button>
    <select className="speed-select" aria-label="Playback speed" value={info.speed} disabled={disabled}
      onChange={event => onSpeed(Number(event.target.value) as Speed)}>
      {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
    </select>
    <Scrubber replay={replay} elapsed={elapsed} disabled={disabled} onSeek={onSeek} audience={audience} />
    <div className="bar-actions">
      <button type="button" className="icon-button bar-reset" onClick={onReset} disabled={disabled} aria-label="Reset run (new run ID)" title="Reset run: same match, new run ID"><RotateCcw size={16} /></button>
      <button type="button" className="icon-button" aria-expanded={open} aria-haspopup="dialog" aria-label="New match" title="New match"
        onClick={() => setOpen(value => !value)} disabled={disabled}><Shuffle size={16} /></button>
      <AnimatePresence>
        {open && <NewMatch current={info} busy={busy} onClose={() => setOpen(false)} onReset={onReset}
          onGenerate={(seed, scenario) => { onGenerate(seed, scenario); setOpen(false); }}
          onLoad={file => { onLoad(file); setOpen(false); }} />}
      </AnimatePresence>
    </div>
  </div>;
}

function Scrubber({ replay, elapsed, disabled, onSeek, audience }: {
  replay: ReplaySnapshot; elapsed: number; disabled: boolean; onSeek: (ms: number) => void; audience: Audience;
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
  const ticks = replay.moments.filter(m => m.rule === 'goal' || m.priority >= 2);
  const now = replay.state.latest_event_sequence ? clockLabel(replay.replay.clock_period, replay.replay.clock_ms) : "0'";
  return <div className="scrub">
    <div ref={track} className="scrub-track" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Replay position"
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
      <MomentumTrack buckets={replay.analysis.momentum} halfFraction={halfFraction} />
      {/* Everything after the playhead has not happened yet in this replay. */}
      <div className="scrub-future" style={{ transform: `scaleX(${1 - fraction})` }} />
      <div className="scrub-rail" />
      <div className="scrub-fill" style={{ transform: `scaleX(${fraction})` }} />
      <div className="scrub-half" style={{ left: `${halfFraction * 100}%` }} title="Half-time" />
      {hover !== null && <div className="scrub-hover" style={{ left: `${hover * 100}%` }} />}
      {ticks.map(moment => <Tick key={moment.moment_id} moment={moment} duration={duration} onSeek={onSeek} disabled={disabled} />)}
      <div className="scrub-head" style={{ left: `${fraction * 100}%` }} />
    </div>
    <div className="scrub-labels">
      <span id="momentum-note">{audience === 'analyst'
        ? <>Bars: illustrative threat added by completed passes per 5 minutes (Harbor above, Vale below). Not a probability. {momentumSummary(replay.analysis.momentum)}.</>
        : <>Bars show who moved the ball into danger: Harbor above, Vale below.</>}</span>
      <span><b>{now}</b></span>
    </div>
  </div>;
}

function Tick({ moment, duration, onSeek, disabled }: { moment: Moment; duration: number; onSeek: (ms: number) => void; disabled: boolean }) {
  return <button type="button" className="scrub-tick" data-rule={moment.rule} tabIndex={-1} disabled={disabled}
    style={{ left: `${(moment.replay_ms / duration) * 100}%`, ['--tone' as string]: teamTone(moment.team_id) }}
    title={`${clockLabel(moment.period, moment.match_time_ms)} ${RULE_LABEL[moment.rule]}: ${moment.insight.headline}`}
    aria-label={`Jump to ${RULE_LABEL[moment.rule]} at ${clockLabel(moment.period, moment.match_time_ms)}`}
    onPointerDown={event => { event.stopPropagation(); onSeek(moment.replay_ms); }}><i /></button>;
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
