import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Database, RefreshCw, SlidersHorizontal, WifiOff, X } from 'lucide-react';
import { AnalysisTabs } from './components/AnalysisTabs';
import { ControlDock } from './components/ControlDock';
import { BrandMark } from './components/Crest';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { EventhousePanel } from './components/EventhousePanel';
import { MatchStage } from './components/MatchStage';
import { MomentFeed } from './components/MomentFeed';
import { Preferences } from './components/Preferences';
import { Momentum, Scoreboard } from './components/Scoreboard';
import { API_BASE_URL } from './lib/api';
import { usePrefs, type Audience } from './lib/prefs';
import { useInterpolatedElapsed, useReplay } from './lib/useReplay';
import type { Event, Moment } from './types/contracts';
import './style.css';

export default function App() {
  const [prefs, updatePrefs] = usePrefs();
  const systemReduced = useReducedMotion();
  const reduced = prefs.motion === 'reduced' || (prefs.motion === 'system' && !!systemReduced);
  return <MotionConfig reducedMotion={prefs.motion === 'reduced' ? 'always' : prefs.motion === 'full' ? 'never' : 'user'}>
    <div data-motion={reduced ? 'reduced' : 'full'}>
      <Match prefs={prefs} updatePrefs={updatePrefs} reduced={reduced} />
    </div>
  </MotionConfig>;
}

function Match({ prefs, updatePrefs, reduced }: { prefs: ReturnType<typeof usePrefs>[0]; updatePrefs: ReturnType<typeof usePrefs>[1]; reduced: boolean }) {
  const live = useReplay();
  const { replay } = live;
  const { elapsed, clockMs } = useInterpolatedElapsed(replay, live.receivedAt);
  const [selectedId, setSelectedId] = useState<string>();
  const [evidence, setEvidence] = useState<Moment>();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [goal, setGoal] = useState<Event | null>(null);
  const [restoredSeen, setRestoredSeen] = useState(false);
  const goalTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const knownGoals = useRef<{ run?: string; ids: Set<string> }>({ ids: new Set() });

  const runId = replay?.state.run_id;
  const selected = useMemo(() => replay?.events.find(event => event.event_id === selectedId), [replay?.events, selectedId]);
  useEffect(() => { setSelectedId(undefined); setEvidence(undefined); }, [runId]);

  // Celebrate goals that arrive during live playback only, not on load or seek.
  useEffect(() => {
    if (!replay) return;
    const goals = replay.events.filter(event => event.type === 'shot' && event.is_goal);
    const known = knownGoals.current;
    const fresh = known.run === replay.state.run_id ? goals.filter(event => !known.ids.has(event.event_id)) : [];
    knownGoals.current = { run: replay.state.run_id, ids: new Set(goals.map(event => event.event_id)) };
    if (fresh.length && replay.state.replay_status !== 'paused') {
      setGoal(fresh[fresh.length - 1]);
      clearTimeout(goalTimer.current);
      goalTimer.current = setTimeout(() => setGoal(null), 3400);
    }
  }, [replay]);

  const togglePlay = useCallback(() => {
    if (!replay || live.busy) return;
    if (replay.state.replay_status === 'playing') void live.pause(); else if (replay.state.replay_status === 'paused') void live.play();
  }, [replay, live]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.code !== 'Space' || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName) || target.getAttribute('role') === 'slider' || evidence) return;
      event.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, evidence]);

  const jumpTo = useCallback((moment: Moment) => {
    if (!replay) return;
    const source = replay.events[moment.source_sequence - 1];
    const lead = source && source.period === moment.period ? source.match_time_ms - moment.match_time_ms : 0;
    setSelectedId(undefined);
    void live.seek(Math.max(0, moment.replay_ms - lead - 6000));
  }, [replay, live]);

  const disabled = live.busy || live.connection === 'offline';

  return <div className="shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="OmniPitch home"><BrandMark /><span className="brand-name">OmniPitch</span>
        <span className="brand-tag">Synthetic match intelligence</span></a>
      <AudienceToggle value={prefs.audience} onChange={audience => updatePrefs({ audience })} />
      {replay && <SourceBadge replay={replay} />}
      <span className="status-pill" data-state={live.connection} role="status">
        <span className="status-dot" />{live.connection === 'online' ? 'Live link' : live.connection === 'offline' ? 'Offline' : 'Connecting'}
      </span>
      <div style={{ position: 'relative' }}>
        <button type="button" className="icon-button" aria-label="Viewing preferences" aria-expanded={prefsOpen} aria-haspopup="dialog"
          onClick={() => setPrefsOpen(open => !open)}><SlidersHorizontal size={17} /></button>
        <AnimatePresence>{prefsOpen && <Preferences prefs={prefs} update={updatePrefs} roster={replay?.replay.roster ?? []} onClose={() => setPrefsOpen(false)} />}</AnimatePresence>
      </div>
    </header>

    {!replay && <Boot offline={live.connection === 'offline'} message={live.connectionError} onRetry={live.reconnect} />}

    {replay && <>
      <AnimatePresence>
        {live.connection === 'offline' && <motion.div className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><WifiOff size={16} />{live.connectionError} Showing the last received state; controls return when the API does.</span>
          <button type="button" className="button" onClick={live.reconnect}><RefreshCw size={14} />Retry</button>
        </motion.div>}
        {live.actionError && <motion.div className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span>{live.actionError}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={live.clearActionError}><X size={15} /></button>
        </motion.div>}
        {replay.replay.restored && !restoredSeen && <motion.div className="notice" style={{ marginBottom: 12, justifyContent: 'space-between' }}
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span>Restored the saved replay after an API restart: same run, score and moments, paused where it stopped.</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setRestoredSeen(true)}><X size={15} /></button>
        </motion.div>}
      </AnimatePresence>

      {replay.replay.backend_mode === 'azure' && replay.replay.source !== 'eventhouse' && <div className="alert" role="status"
        style={{ background: 'var(--flood-soft)', borderColor: 'rgba(242,201,76,.4)', color: 'var(--chalk)', marginBottom: 12, display: 'grid' }}>
        <span><b>Azure mode, but this replay is not Eventhouse data.</b> It is the {replay.replay.source === 'simulator' ? 'local simulator match' : 'uploaded file'} restored at startup. Load a run from Fabric Eventhouse to see cloud data.</span>
        <EventhousePanel replay={replay} busy={live.busy} onLoad={live.loadEventhouse} compact />
      </div>}

      <Scoreboard state={replay.state} replay={replay.replay} clockMs={clockMs} stats={replay.analysis.teams} goalKey={goal?.event_id ?? null} />
      <Momentum buckets={replay.analysis.momentum} analyst={prefs.audience === 'analyst'} />

      <div className="stage">
        <MatchStage replay={replay} selected={selected} onSelect={event => setSelectedId(event?.event_id)} prefs={prefs} updatePrefs={updatePrefs}
          goal={goal} animate={!reduced} audience={prefs.audience} />
        <MomentFeed moments={replay.moments} audience={prefs.audience} favoriteTeam={prefs.favoriteTeam} favoritePlayer={prefs.favoritePlayer}
          roster={replay.replay.roster} onEvidence={setEvidence} onJump={jumpTo} />
      </div>

      <AnalysisTabs replay={replay} audience={prefs.audience} favoritePlayer={prefs.favoritePlayer}
        busy={live.busy} onLoadEventhouse={live.loadEventhouse}
        onSelectEvent={event => { setSelectedId(event.event_id); window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); }} />

      <footer className="foot">
        <span>All teams, players and events are synthetic. Narratives are deterministic templates from verified metrics; AI narration is not connected yet.</span>
        <span>Run <span className="mono">{replay.state.run_id}</span> · API {API_BASE_URL}</span>
      </footer>

      <ControlDock replay={replay} elapsed={elapsed} busy={live.busy} disabled={disabled}
        onPlay={live.play} onPause={live.pause} onReset={live.reset} onSpeed={live.setSpeed} onSeek={live.seek}
        onGenerate={live.generate} onLoad={live.load} />

      <AnimatePresence>
        {evidence && <EvidenceDrawer key={evidence.moment_id} moment={evidence} events={replay.events} roster={replay.replay.roster} reduced={reduced}
          onClose={() => setEvidence(undefined)} onSelectEvent={event => { setSelectedId(event.event_id); setEvidence(undefined); }} />}
      </AnimatePresence>
    </>}
  </div>;
}

function SourceBadge({ replay }: { replay: NonNullable<ReturnType<typeof useReplay>['replay']> }) {
  const { backend_mode: mode, source, source_detail: detail } = replay.replay;
  const label = source === 'eventhouse' ? 'Azure · Eventhouse' : mode === 'azure' ? 'Azure · not loaded' : source === 'upload' ? 'Local · uploaded file' : 'Local · simulator';
  return <span className="status-pill" title={detail ?? `Backend mode: ${mode}`} data-state={source === 'eventhouse' ? 'online' : mode === 'azure' ? 'offline' : 'local'}>
    <Database size={14} aria-hidden="true" />{label}
  </span>;
}

function AudienceToggle({ value, onChange }: { value: Audience; onChange: (value: Audience) => void }) {
  return <div className="segmented" role="group" aria-label="Audience mode">
    {(['fan', 'analyst'] as const).map(mode => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)}>
      {value === mode && <motion.span layoutId="audience-thumb" className="thumb" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
      {mode === 'fan' ? 'Fan view' : 'Analyst view'}
    </button>)}
  </div>;
}

function Boot({ offline, message, onRetry }: { offline: boolean; message?: string; onRetry: () => void }) {
  if (offline) {
    return <div className="panel empty" style={{ marginTop: 24, padding: 48 }} role="alert">
      <WifiOff size={28} />
      <strong>Can't reach the match API</strong>
      <span>{message}</span>
      <span className="hint">Start it from the repository root: <span className="mono">uvicorn app.main:app --app-dir services/api --port 8000</span></span>
      <button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} />Try again</button>
    </div>;
  }
  return <div className="boot" aria-busy="true" aria-label="Loading match">
    <div className="skeleton" style={{ height: 112 }} />
    <div className="stage" style={{ marginTop: 0 }}>
      <div className="skeleton" style={{ aspectRatio: '113 / 90' }} />
      <div className="skeleton" style={{ height: 420 }} />
    </div>
  </div>;
}
