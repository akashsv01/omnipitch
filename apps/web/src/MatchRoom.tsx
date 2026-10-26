import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Database, RefreshCw, SlidersHorizontal, WifiOff, X } from 'lucide-react';
import { AnalysisTabs, type TabRequest } from './components/AnalysisTabs';
import { Brand } from './components/Crest';
import { Filmstrip, type FilmRange } from './components/ControlDock';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { EventhousePanel } from './components/EventhousePanel';
import { MatchStage } from './components/MatchStage';
import { MomentFeed } from './components/MomentFeed';
import { Preferences } from './components/Preferences';
import { ScoreStrip } from './components/Scoreboard';
import { INDICATOR } from './lib/motion';
import { API_BASE_URL } from './lib/api';
import { RULE_LABEL, clockLabel } from './lib/format';
import { usePrefs, type Audience } from './lib/prefs';
import { useInterpolatedElapsed, useReplay } from './lib/useReplay';
import type { Event, Moment, RecapScope } from './types/contracts';

export { prefetchReplay } from './lib/useReplay';

/** The match room (/match). Entering it never resets or starts a shared run: it only reads the replay state. */
export default function MatchRoom({ prefs, updatePrefs, reduced, onHome }: {
  prefs: ReturnType<typeof usePrefs>[0]; updatePrefs: ReturnType<typeof usePrefs>[1]; reduced: boolean; onHome: () => void;
}) {
  const live = useReplay();
  const { replay } = live;
  const latest = useRef({ replay, live });
  latest.current = { replay, live };
  const { elapsed, clockMs } = useInterpolatedElapsed(replay, live.receivedAt);
  const [selectedId, setSelectedId] = useState<string>();
  const [inspectId, setInspectId] = useState<string>();
  const [evidence, setEvidence] = useState<Moment>();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [goal, setGoal] = useState<Event | null>(null);
  const [restoredSeen, setRestoredSeen] = useState(false);
  const goalTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const knownGoals = useRef<{ run?: string; ids: Set<string> }>({ ids: new Set() });

  const runId = replay?.state.run_id;
  const selected = useMemo(() => replay?.events.find(event => event.event_id === selectedId), [replay?.events, selectedId]);
  const inspect = useMemo(() => replay?.moments.find(m => m.moment_id === inspectId) ?? null, [replay?.moments, inspectId]);
  useEffect(() => { setSelectedId(undefined); setEvidence(undefined); setInspectId(undefined); setGoal(null); }, [runId]);
  // A backwards seek can remove the inspected moment; fall back to following live.
  useEffect(() => { if (inspectId && replay && !inspect) setInspectId(undefined); }, [inspectId, inspect, replay]);

  // The goal ribbon: once per canonical goal event, only when it arrives during forward playback (never on load,
  // seek or run change, and never inferred from anything but a validated shot with is_goal).
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
  useEffect(() => () => clearTimeout(goalTimer.current), []);

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
    const { replay: current, live: controls } = latest.current;
    if (!current) return;
    const source = current.events[moment.source_sequence - 1];
    const lead = source && source.period === moment.period ? source.match_time_ms - moment.match_time_ms : 0;
    setSelectedId(undefined);
    setInspectId(undefined);
    void controls.seek(Math.max(0, moment.replay_ms - lead - 6000));
  }, []);

  const jumpToMoment = useCallback((momentId: string, replayMs: number) => {
    const moment = latest.current.replay?.moments.find(m => m.moment_id === momentId);
    if (moment) jumpTo(moment); else void latest.current.live.seek(Math.max(0, replayMs - 6000));
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }, [jumpTo, reduced]);
  const selectEvent = useCallback((event: Event | undefined) => setSelectedId(event?.event_id), []);
  const selectFromAnalysis = useCallback((event: Event) => {
    setInspectId(undefined);
    setSelectedId(event.event_id);
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
  }, [reduced]);
  const chooseMoment = useCallback((moment: Moment | undefined) => { setInspectId(moment?.moment_id); setSelectedId(undefined); }, []);
  const stopInspect = useCallback(() => setInspectId(undefined), []);
  const start = useCallback(() => { void latest.current.live.play(); }, []);
  const loadEventhouse = useCallback((id: string) => latest.current.live.loadEventhouse(id), []);

  // The inspected moment's sequence as a range on the replay timeline (event times relative to the moment's).
  const range = useMemo<FilmRange | null>(() => {
    if (!inspect || !replay) return null;
    const cited = replay.events.filter(e => inspect.evidence_ids.includes(e.event_id) && e.period === inspect.period);
    if (!cited.length) return null;
    const at = (e: Event) => inspect.replay_ms + (e.match_time_ms - inspect.match_time_ms);
    return { from: Math.max(0, at(cited[0]) - 1500), to: at(cited[cited.length - 1]) + 1500,
      label: `${clockLabel(inspect.period, inspect.match_time_ms)} ${RULE_LABEL[inspect.rule]} sequence` };
  }, [inspect, replay]);

  // When a period ends during playback, offer its recap once.
  const [tabRequest, setTabRequest] = useState<TabRequest>();
  const [recapPrompt, setRecapPrompt] = useState<{ text: string; scope: RecapScope } | null>(null);
  const seenPeriodEnds = useRef<{ run?: string; ends: Set<string> }>({ ends: new Set() });
  useEffect(() => {
    if (!replay) return;
    const ends = replay.events.filter(e => e.type === 'period_end').map(e => e.event_id);
    const known = seenPeriodEnds.current;
    const fresh = known.run === replay.state.run_id ? ends.filter(id => !known.ends.has(id)) : [];
    seenPeriodEnds.current = { run: replay.state.run_id, ends: new Set(ends) };
    if (fresh.length && replay.state.replay_status !== 'paused') {
      const period = replay.events.find(e => e.event_id === fresh[fresh.length - 1])?.period;
      setRecapPrompt(period === 2 ? { text: 'Full-time recap is ready', scope: 'full_time' } : { text: 'Half-time recap is ready', scope: 'first_half' });
    }
  }, [replay]);
  const openRecapNow = useCallback(() => {
    setTabRequest({ tab: 'recap', nonce: Date.now() });
    document.getElementById('analysis-title')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, [reduced]);
  const openRecap = () => {
    setTabRequest({ tab: 'recap', nonce: Date.now(), scope: recapPrompt?.scope });
    setRecapPrompt(null);
    setTimeout(() => document.getElementById('analysis-title')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }), 320); // After the banner's exit, or the layout shift cancels a smooth scroll.
  };

  // Announce audience changes once (not on first render); focus stays on the toggle the reader used.
  const [modeNote, setModeNote] = useState('');
  const firstAudience = useRef(prefs.audience);
  useEffect(() => {
    if (prefs.audience === firstAudience.current && !modeNote) return;
    setModeNote(prefs.audience === 'fan' ? 'Fan view: story-led moments.' : 'Analyst view: metrics, sources and layers.');
  }, [prefs.audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const disabled = live.busy || live.connection === 'offline';
  const inspecting = inspect ? `${clockLabel(inspect.period, inspect.match_time_ms)}` : null;

  return <div className="shell" data-audience={prefs.audience}>
    <a className="skip-link" href="#match">Skip to the match</a>
    <header className="nav">
      <Brand onNavigate={onHome} tagline="Match room" />
      <AudienceToggle value={prefs.audience} onChange={audience => updatePrefs({ audience })} />
      <span className="nav-sep" aria-hidden="true" />
      {replay && <SourceBadge replay={replay} />}
      <span className="nav-status" data-state={live.connection} role="status" title="Connection to the match API (separate from the replay state)">
        <span className="dot" aria-hidden="true" /><span className="label">{live.connection === 'online' ? 'Connected' : live.connection === 'offline' ? 'Offline' : 'Connecting'}</span>
      </span>
      <div style={{ position: 'relative' }}>
        <button type="button" className="icon-button" aria-label="Viewing preferences" aria-expanded={prefsOpen} aria-haspopup="dialog"
          onClick={() => setPrefsOpen(open => !open)}><SlidersHorizontal size={17} /></button>
        <AnimatePresence>{prefsOpen && <Preferences prefs={prefs} update={updatePrefs} roster={replay?.replay.roster ?? []} onClose={() => setPrefsOpen(false)} />}</AnimatePresence>
      </div>
    </header>

    {!replay && <Boot offline={live.connection === 'offline'} message={live.connectionError} onRetry={live.reconnect} />}

    {replay && <main id="match" tabIndex={-1}>
      <p className="sr-only" aria-live="polite">{modeNote}</p>
      <h1 className="sr-only">OmniPitch match room: {replay.state.home_team.name} against {replay.state.away_team.name}</h1>
      <ScoreStrip state={replay.state} replay={replay.replay} clockMs={clockMs} inspecting={inspecting} />
      <div className="banner-stack" aria-live="polite">
      <AnimatePresence initial={false}>
        {live.connection === 'offline' && <motion.div key="offline" className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><WifiOff size={16} />{live.connectionError} Showing the last received state; controls return when the API does.</span>
          <button type="button" className="button" onClick={live.reconnect}><RefreshCw size={14} />Retry</button>
        </motion.div>}
        {live.actionError && <motion.div key="action" className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span>{live.actionError}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={live.clearActionError}><X size={15} /></button>
        </motion.div>}
        {recapPrompt && <motion.div key="recap" className="notice recap-prompt" role="status" style={{ justifyContent: 'space-between', alignItems: 'center' }}
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
          <span>{recapPrompt.text}: the score, up to three verified key moments and what the data supports.</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button primary" onClick={openRecap}>Read recap</button>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setRecapPrompt(null)}><X size={15} /></button>
          </span>
        </motion.div>}
        {replay.replay.restored && !restoredSeen && <motion.div key="restored" className="notice" style={{ justifyContent: 'space-between' }}
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span>Restored the saved replay after an API restart: same run, score and moments, paused where it stopped.</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setRestoredSeen(true)}><X size={15} /></button>
        </motion.div>}
      </AnimatePresence>
      </div>

      {replay.replay.backend_mode === 'azure' && replay.replay.source !== 'eventhouse' && <div className="alert" role="status"
        style={{ background: 'var(--amber-soft)', borderColor: 'rgba(242,204,98,.4)', color: 'var(--text)', marginTop: 10, display: 'grid' }}>
        <span><b>Azure mode, but this replay is not Eventhouse data.</b> It is the {replay.replay.source === 'simulator' ? 'local simulator match' : 'uploaded file'} restored at startup. Load a run from Fabric Eventhouse to see cloud data.</span>
        <EventhousePanel replay={replay} busy={live.busy} onLoad={live.loadEventhouse} compact />
      </div>}

      <div className="desk">
        <MatchStage replay={replay} selected={selected} onSelect={selectEvent} prefs={prefs} updatePrefs={updatePrefs}
          goal={goal} animate={!reduced} audience={prefs.audience} inspect={inspect} onStopInspect={stopInspect}
          onStart={start} startDisabled={disabled} />
        <div className="desk-film">
          <Filmstrip replay={replay} elapsed={elapsed} busy={live.busy} disabled={disabled} audience={prefs.audience}
            range={range} onReturn={stopInspect}
            onPlay={live.play} onPause={live.pause} onReset={live.reset} onSpeed={live.setSpeed} onSeek={live.seek}
            onGenerate={live.generate} onLoad={live.load} />
        </div>
        <MomentFeed moments={replay.moments} audience={prefs.audience} favoriteTeam={prefs.favoriteTeam} favoritePlayer={prefs.favoritePlayer}
          roster={replay.replay.roster} chosenId={inspectId} onChoose={chooseMoment} onEvidence={setEvidence} onJump={jumpTo} aiMode={replay.insights.status === 'off' ? 'off' : replay.insights.mode} onRecap={openRecapNow} />
        <div className="desk-analysis">
        <AnalysisTabs replay={replay} audience={prefs.audience} favoritePlayer={prefs.favoritePlayer}
          busy={live.busy} onLoadEventhouse={loadEventhouse} onJumpMoment={jumpToMoment} tabRequest={tabRequest} push={live.push}
          onSelectEvent={selectFromAnalysis} playhead={Math.round(Math.min(1, elapsed / Math.max(1, replay.replay.duration_ms)) * 200) / 200} />
        </div>
      </div>


    </main>}

    {replay && <>
      <footer className="foot">
        <p className="disclosure-line">All teams, players and events are synthetic. {replay.insights.ai > 0
          ? `${replay.insights.ai} moment ${replay.insights.ai === 1 ? 'explanation is' : 'explanations are'} AI-written and passed the code validator (labelled "AI · validated"); the rest are rule-based templates from verified metrics.`
          : replay.insights.mode === 'off' || replay.insights.status === 'off' ? 'Moment explanations are rule-based templates from verified metrics; AI narration does not cover this run.' : 'Moment explanations are rule-based templates for now; AI narration is on but has not produced accepted text for these moments yet (labelled "AI pending").'}</p>
        <details className="disclosure">
          <summary>Data source and diagnostics</summary>
          <div>
            <dl>
              <dt>Events available so far</dt><dd className="num">{replay.state.latest_event_sequence} / {replay.total_events} events</dd>
              <dt>Source</dt><dd>{sourceLabel(replay)}{replay.replay.source_detail ? ` · ${replay.replay.source_detail}` : ''}</dd>
              <dt>Backend</dt><dd>{replay.replay.backend_mode} mode · API {API_BASE_URL}</dd>
              <dt>Run</dt><dd className="mono">{replay.state.run_id}</dd>
              <dt>Narrated insights</dt><dd>{replay.insights.mode === 'off' ? 'off (templates only)' : `${replay.insights.narrated} narrated, ${replay.insights.ai} AI, ${replay.insights.rejected} rejected (${replay.insights.status})`}</dd>
              <dt>Live updates</dt><dd>{live.push.state === 'off' ? 'polling only' : live.push.state}</dd>
            </dl>
          </div>
        </details>
      </footer>

      <AnimatePresence>
        {evidence && <EvidenceDrawer key={evidence.moment_id} moment={evidence} events={replay.events} roster={replay.replay.roster} reduced={reduced}
          audience={prefs.audience} aiMode={replay.insights.status === 'off' ? 'off' : replay.insights.mode} onClose={() => setEvidence(undefined)} onReplay={moment => { setEvidence(undefined); jumpTo(moment); }} />}
      </AnimatePresence>
    </>}
  </div>;
}

type Snapshot = NonNullable<ReturnType<typeof useReplay>['replay']>;

function sourceLabel(replay: Snapshot) {
  const { backend_mode: mode, source, source_run_id: run, seed, scenario } = replay.replay;
  if (source === 'eventhouse') return `Eventhouse run ${run}`;
  if (mode === 'azure') return 'Azure: no Eventhouse run loaded';
  if (source === 'upload') return 'Uploaded JSONL';
  return `Simulator, seed ${seed} (${scenario?.replace('_', ' ')})`;
}

function SourceBadge({ replay }: { replay: Snapshot }) {
  const { backend_mode: mode, source, source_detail: detail } = replay.replay;
  const label = source === 'eventhouse' ? 'Eventhouse' : mode === 'azure' ? 'Not loaded' : source === 'upload' ? 'Uploaded file' : 'Simulator';
  return <span className="nav-status nav-source" title={`${sourceLabel(replay)}${detail ? ` · ${detail}` : ''}`} data-state={mode === 'azure' && source !== 'eventhouse' ? 'offline' : undefined}>
    <Database size={14} aria-hidden="true" />{label}
  </span>;
}

function AudienceToggle({ value, onChange }: { value: Audience; onChange: (value: Audience) => void }) {
  return <div className="segmented" role="group" aria-label="Audience mode">
    {(['fan', 'analyst'] as const).map(mode => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)}>
      {value === mode && <motion.span layoutId="audience-thumb" className="thumb" transition={INDICATOR} />}
      {mode === 'fan' ? 'Fan view' : 'Analyst view'}
    </button>)}
  </div>;
}

function Boot({ offline, message, onRetry }: { offline: boolean; message?: string; onRetry: () => void }) {
  if (offline) {
    return <div className="empty" style={{ marginTop: 24, padding: 48 }} role="alert">
      <WifiOff size={28} />
      <strong>Can't reach the match API</strong>
      <span>{message}</span>
      <span className="hint">Start it from the repository root: <span className="mono">uvicorn app.main:app --app-dir services/api --port 8000</span></span>
      <button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} />Try again</button>
    </div>;
  }
  // Same geometry as the loaded desk, so nothing jumps when the match arrives.
  return <div aria-busy="true" aria-label="Loading match">
    <div className="skeleton" style={{ height: 'var(--strip-h)', marginTop: 8 }} />
    <div className="desk">
      <div className="desk-stage"><div className="skeleton" style={{ height: 32 }} />
        {/* A pitch outline, not a grey block: the landing pitch lands on it, then the live pitch replaces it. */}
        <div className="pitch-frame"><div className="pitch-wrap boot-pitch"><svg viewBox="-4 -4 113 76" aria-hidden="true">
          <g className="pitch-lines"><rect x="0" y="0" width="105" height="68" /><path d="M 52.5 0 V 68" /><circle cx="52.5" cy="34" r="9.15" />
            <rect x="0" y="13.84" width="16.5" height="40.32" /><rect x="88.5" y="13.84" width="16.5" height="40.32" /></g>
        </svg></div></div></div>
      <div className="desk-film"><div className="skeleton" style={{ height: 'var(--film-h)' }} /></div>
      <div className="desk-spot"><div className="skeleton" style={{ height: 420 }} /></div>
    </div>
  </div>;
}
