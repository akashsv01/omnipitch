import { memo, useMemo, useRef, useState } from 'react';
import { t } from '../lib/i18n';
import { useTr } from '../lib/i18n';
import { AnimatePresence, motion } from 'motion/react';
import { Dices, FileUp, Pause, Play, RotateCcw, Shuffle } from 'lucide-react';
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
  { id: 'late_surge', label: 'Late surge', hint: 'Vale push for goals in the last half hour (a comeback for some seeds)' },
];

/** The replay window of the moment being inspected, on the replay timeline (ms). */
export interface FilmRange { from: number; to: number; label: string }

/** Match filmstrip: a match-time scale with a playhead, the momentum band, moment markers, the inspected
 * sequence range and the replay controls. Reserved space below the stage; a fixed thumb bar on phones. */
export function Filmstrip({ replay, elapsed, busy, disabled, audience, range, onPlay, onPause, onRestart, onReset, onSpeed, onSeek, onGenerate, onLoad, actions, onChoose }: {
  replay: ReplaySnapshot; elapsed: number; busy: boolean; disabled: boolean; audience: Audience;
  range: FilmRange | null; /** Returning to the replay lives in the Now bar and the moment card. */ onReturn?: () => void;
  /** A marker on the timeline opens its moment: the explanation, its sequence on the pitch and its range here. */
  onChoose: (moment: Moment) => void;
  onPlay: () => void; onPause: () => void; onReset: () => void; onSpeed: (speed: Speed) => void; onSeek: (ms: number) => void;
  /** After full-time: back to kick-off and play the same match (no new run). */
  onRestart: () => void;
  onGenerate: (seed: number, scenario: Scenario) => void; onLoad: (file: File) => void;
  /** Further broadcast controls beside the clock line (live commentary), so every control sits in this one bar. */
  actions?: React.ReactNode;
}) {
  const tr = useTr();
  const { state, replay: info } = replay;
  const playing = state.replay_status === 'playing';
  const finished = state.replay_status === 'finished';
  const [open, setOpen] = useState(false);
  const label = playing ? tr('Pause replay') : finished ? tr('Watch again from kick-off') : state.latest_event_sequence ? tr('Resume replay') : tr('Play replay');
  // The same running clock as the score strip (26:02, not the broadcast minute 27'), so the two never disagree.
  const now = state.latest_event_sequence ? runningClock(info.clock_period, info.clock_ms) : '00:00';
  // One transport row: play on the left, the clock and timeline in the middle, the other controls on the right,
  // all on the same centre line.
  return <section className="film" aria-label={t('Replay controls')}>
    <button type="button" className="play" aria-label={label} title={label} disabled={disabled} onClick={playing ? onPause : finished ? onRestart : onPlay}>
      {playing ? <Pause size={20} fill="currentColor" aria-hidden="true" /> : <Play size={20} fill="currentColor" style={{ marginLeft: 3 }} aria-hidden="true" />}
    </button>
    <div className="film-main">
      <div className="film-top">
        <span><b>{now}</b> · {finished ? 'FT' : playing ? `${tr('Watching replay')} · ${info.speed}×` : state.latest_event_sequence ? tr('Paused') : tr('Kick-off')}</span>
      </div>
      <Track replay={replay} elapsed={elapsed} disabled={disabled} onSeek={onSeek} range={range} onChoose={onChoose} />
      <p className={audience === 'fan' ? 'film-note sr-only' : 'film-note'} id="momentum-note">{audience === 'analyst'
        ? <>{tr('Band: illustrative threat added by completed passes per 5 minutes (Harbor above, Vale below). Not a probability.')} {momentumSummary(replay.analysis.momentum)}.</>
        : <>{tr('The band shows who moved the ball into danger, Harbor above and Vale below. It is not a win probability.')}</>}</p>
    </div>
    <div className="film-tools">
      <select className="speed-select" aria-label={tr('Playback speed')} value={info.speed} disabled={disabled}
        onChange={event => onSpeed(Number(event.target.value) as Speed)}>
        {SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×</option>)}
      </select>
      {/* Match setup (seed, scenario, file upload) is developer tooling: dev server only, never on the public site. */}
      {import.meta.env.DEV && <div className="film-sub" style={{ position: 'relative' }}>
        <button type="button" className="icon-button" aria-expanded={open} aria-haspopup="dialog" aria-label="New match" title="New match"
          onClick={() => setOpen(value => !value)} disabled={disabled}><Shuffle size={15} /></button>
        <AnimatePresence>
          {open && <NewMatch current={info} busy={busy} onClose={() => setOpen(false)} onReset={onReset}
            onGenerate={(seed, scenario) => { onGenerate(seed, scenario); setOpen(false); }}
            onLoad={file => { onLoad(file); setOpen(false); }} />}
        </AnimatePresence>
      </div>}
      {actions}
    </div>
  </section>;
}

const Track = memo(function Track({ replay, elapsed, disabled, onSeek, range, onChoose }: {
  replay: ReplaySnapshot; elapsed: number; disabled: boolean; onSeek: (ms: number) => void; range: FilmRange | null; onChoose: (moment: Moment) => void;
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
  return <div ref={track} className="film-track" role="slider" tabIndex={disabled ? -1 : 0} aria-label={t('Replay position')}
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
    <div className="film-ht" style={{ left: `${halfFraction * 100}%` }} title={t('Half-time')} />
    {range && <div className="film-range" title={range.label}
      style={{ left: `${Math.min(range.from, range.to) / duration * 100}%`, width: `${Math.abs(range.to - range.from) / duration * 100}%` }} />}
    {ticks.map(moment => <i key={moment.moment_id} className="film-tick" aria-hidden="true"
      style={{ left: `${(moment.replay_ms / duration) * 100}%`, ['--tone' as string]: teamTone(moment.team_id) }} />)}
    {pins.map((moment, index) => <Pin key={moment.moment_id} moment={moment} duration={duration} onChoose={onChoose}
      crowded={pins.slice(0, index).some(other => other.rule === 'goal' && moment.replay_ms - other.replay_ms < duration * .045)} />)}
    {hover !== null && <>
      <div className="film-hover" style={{ left: `${hover * 100}%` }} />
      <div className="film-preview" aria-hidden="true" style={{ left: `clamp(60px, ${hover * 100}%, calc(100% - 60px))` }}>
        {matchLabel(hover * duration)}{near ? ` · ${t(RULE_LABEL[near.rule])}` : ''}
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
      <rect x={x(index) + .25} y={13 - Math.max(0, slot.harbor / max * 12)} width={Math.max(.2, w(index))} height={Math.max(0, slot.harbor / max * 12)} fill="var(--harbor)" opacity=".55" />
      <rect x={x(index) + .25} y={13} width={Math.max(.2, w(index))} height={Math.max(0, slot.vale / max * 12)} fill="var(--vale)" opacity=".55" />
    </g>)}
  </svg>;
}

/** A goal pin carries its minute and opens its moment; one that would overlap the previous goal's label keeps only its marker (the title still names it). */
function Pin({ moment, duration, onChoose, crowded }: { moment: Moment; duration: number; onChoose: (moment: Moment) => void; crowded: boolean }) {
  const goal = moment.rule === 'goal';
  return <button type="button" className="film-pin" data-rule={moment.rule}
    style={{ left: `${(moment.replay_ms / duration) * 100}%`, ['--tone' as string]: teamTone(moment.team_id) }}
    title={`${clockLabel(moment.period, moment.match_time_ms)} ${t(RULE_LABEL[moment.rule])}`}
    aria-label={`${t('Open')} ${t(RULE_LABEL[moment.rule])} ${t('at')} ${clockLabel(moment.period, moment.match_time_ms)}`}
    onPointerDown={event => event.stopPropagation()} onClick={() => onChoose(moment)}>
    {goal && !crowded && <b><span className="pin-word">{t('Goal')} </span>{clockLabel(moment.period, moment.match_time_ms)}</b>}<i />
  </button>;
}

/** Match setup, kept out of the fan's way: one small button opens it. Locally it generates, loads or restarts a
 * match. In Azure mode, where matches come from Fabric Eventhouse, it says so instead of showing disabled fields. */
function NewMatch({ current, busy, onClose, onGenerate, onLoad, onReset }: {
  current: ReplaySnapshot['replay']; busy: boolean; onClose: () => void; onReset: () => void;
  onGenerate: (seed: number, scenario: Scenario) => void; onLoad: (file: File) => void;
}) {
  const [seed, setSeed] = useState(String(current.seed ?? 7));
  const [scenario, setScenario] = useState<Scenario>((current.scenario as Scenario) ?? 'standard');
  const valid = /^\d{1,9}$/.test(seed);
  const azure = current.backend_mode === 'azure';
  const reset = <button type="button" className="button" aria-label="Restart the match from kick-off" onClick={() => { onReset(); onClose(); }}>
    <RotateCcw size={15} aria-hidden="true" />{azure ? 'Restart this replay' : 'Reset run'}</button>;
  return <motion.div className="popover up" role="dialog" aria-label="New match" {...POPOVER}
    style={{ left: 0, right: 'auto', transformOrigin: 'bottom left' }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <h3>{azure ? 'Match source' : 'Start a new match'}</h3>
    {azure ? <>
      <p className="hint">This deployment replays matches published to Fabric Eventhouse. Generating or uploading matches is turned off here.
        Available replays are listed under <b>Match analysis → Data quality</b>.</p>
      {reset}
      <p className="hint">Restarting returns the match to kick-off for everyone watching.</p>
    </> : <>
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
      <button type="button" className="button primary" disabled={!valid || busy} onClick={() => onGenerate(Number(seed), scenario)}>Generate match</button>
      <div style={{ display: 'flex', gap: 8 }}>
        <label className="button file-button" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <FileUp size={15} aria-hidden="true" />Load JSONL
          <input type="file" accept=".jsonl,application/x-ndjson" aria-label="Load JSONL file" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) onLoad(file);
            }} />
        </label>
        {reset}
      </div>
      <p className="hint">The same seed and scenario always produce the same match.</p>
    </>}
  </motion.div>;
}
