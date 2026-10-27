import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RefreshCw, SlidersHorizontal, WifiOff, X } from 'lucide-react';
import { AnalysisTabs, type TabRequest } from './components/AnalysisTabs';
import { Brand } from './components/Crest';
import { TrustBar } from './components/TrustBar';
import { NowBar } from './components/NowBar';
import { LanguageContext, setUiLanguage, t, useTr } from './lib/i18n';
import { Filmstrip, type FilmRange } from './components/ControlDock';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { MatchStage } from './components/MatchStage';
import { MomentFeed } from './components/MomentFeed';
import { Preferences } from './components/Preferences';
import { ScoreStrip } from './components/Scoreboard';
import { CommentaryBar, CommentarySubtitle } from './components/CommentaryBar';
import { useCommentary } from './lib/useCommentary';
import { INDICATOR } from './lib/motion';
import { RULE_LABEL, clockLabel } from './lib/format';
import { usePrefs, type Audience } from './lib/prefs';
import { useInterpolatedElapsed, useReplay } from './lib/useReplay';
import type { Event, Moment, RecapScope } from './types/contracts';

export { prefetchReplay } from './lib/useReplay';

// The Now bar carries the score and goals a late joiner missed, so the separate catch-up strip is off.
const noop = () => {};

/** The match room (/match). Entering it never resets or starts a shared run: it only reads the replay state. */
export default function MatchRoom({ prefs, updatePrefs, reduced, onHome }: {
  prefs: ReturnType<typeof usePrefs>[0]; updatePrefs: ReturnType<typeof usePrefs>[1]; reduced: boolean; onHome: () => void;
}) {
  setUiLanguage(prefs.language);  // for pure helpers (event names, calculation rows) rendered below
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
  const goalTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const knownGoals = useRef<{ run?: string; ids: Set<string> }>({ ids: new Set() });

  const runId = replay?.state.run_id;
  const selected = useMemo(() => replay?.events.find(event => event.event_id === selectedId), [replay?.events, selectedId]);
  const inspect = useMemo(() => replay?.moments.find(m => m.moment_id === inspectId) ?? null, [replay?.moments, inspectId]);
  useEffect(() => { setSelectedId(undefined); setEvidence(undefined); setInspectId(undefined); setGoal(null); }, [runId]);
  // Evidence for a moment that no longer exists at this replay position (a seek back) is closed, never left stale.
  useEffect(() => {
    if (evidence && replay && !replay.moments.some(m => m.moment_id === evidence.moment_id)) setEvidence(undefined);
  }, [evidence, replay]);
  // Arriving from the landing page: move keyboard focus to the match once it is on screen.
  useEffect(() => {
    if (!replay) return;
    try {
      if (sessionStorage.getItem('omnipitch.focusEntry') !== '1') return;
      sessionStorage.removeItem('omnipitch.focusEntry');
    } catch { return; }
    requestAnimationFrame(() => document.getElementById('match')?.focus({ preventScroll: true }));
  }, [replay]);

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
  const restart = useCallback(async () => { await latest.current.live.seek(0); await latest.current.live.play(); }, []);

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
  // Live commentary; a narrated recap brings the Recap tab to that period (without scrolling the page).
  const showRecap = useCallback((scope: RecapScope) => setTabRequest({ tab: 'recap', nonce: Date.now(), scope }), []);
  const commentary = useCommentary(replay, prefs.audience, prefs.language, prefs.favoritePlayer, showRecap);
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
    setModeNote(t(prefs.audience === 'fan' ? 'Fan view: story-led moments.' : 'Analyst view: metrics, sources and layers.'));
  }, [prefs.audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const disabled = live.busy || live.connection === 'offline';
  const inspecting = inspect ? `${clockLabel(inspect.period, inspect.match_time_ms)}` : null;

  return <LanguageContext.Provider value={prefs.language}><div className="shell" data-audience={prefs.audience}>
    <a className="skip-link" href="#match">{prefs.language === 'es' ? 'Ir al partido' : 'Skip to the match'}</a>
    <header className="nav">
      <Brand onNavigate={onHome} tagline={t('Match room')} />
      <AudienceToggle value={prefs.audience} onChange={audience => updatePrefs({ audience })} />
      <LanguageToggle value={prefs.language} onChange={language => updatePrefs({ language })} />
      <span className="nav-sep" aria-hidden="true" />
      <span className="nav-status" data-state={live.connection} role="status" title={t('Live connection to the match')}>
        <span className="dot" aria-hidden="true" /><span className="label">{t(live.connection === 'online' ? 'Connected' : live.connection === 'offline' ? 'Offline' : 'Connecting')}</span>
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
      <h1 className="sr-only">{t('OmniPitch match room:')} {replay.state.home_team.name} {t('against')} {replay.state.away_team.name}</h1>
      <ScoreStrip state={replay.state} replay={replay.replay} clockMs={clockMs} inspecting={inspecting} badge={<TrustBar replay={replay} />} />
      <NowBar replay={replay} clockMs={clockMs} language={prefs.language} inspect={inspect} disabled={disabled}
        onPlay={live.play} onRestart={restart} onStopInspect={stopInspect} onRecap={openRecapNow} />
      <div className="banner-stack" aria-live="polite">
      <AnimatePresence initial={false}>
        {live.connection === 'offline' && <motion.div key="offline" className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><WifiOff size={16} />{live.connectionError} {t('Showing the last update; controls return when the connection does.')}</span>
          <button type="button" className="button" onClick={live.reconnect}><RefreshCw size={14} />Retry</button>
        </motion.div>}
        {live.actionError && <motion.div key="action" className="alert" role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
          <span>{live.actionError}</span>
          <button type="button" className="icon-button" aria-label={t('Dismiss')} onClick={live.clearActionError}><X size={15} /></button>
        </motion.div>}
        {recapPrompt && <motion.div key="recap" className="notice recap-prompt" role="status" style={{ justifyContent: 'space-between', alignItems: 'center' }}
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
          <span>{t(recapPrompt.text)}: {t('the score, the key moments and the main story.')}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button primary" onClick={openRecap}>{t('Read recap')}</button>
            <button type="button" className="icon-button" aria-label={t('Dismiss')} onClick={() => setRecapPrompt(null)}><X size={15} /></button>
          </span>
        </motion.div>}
      </AnimatePresence>
      </div>

      <div className="desk">
        <MatchStage replay={replay} selected={selected} onSelect={selectEvent} prefs={prefs} updatePrefs={updatePrefs}
          goal={goal} animate={!reduced} audience={prefs.audience} inspect={inspect} onStopInspect={stopInspect}
          onStart={start} startDisabled={disabled} commentary={<CommentaryBar c={commentary} language={prefs.language} />}
          subtitle={<CommentarySubtitle c={commentary} language={prefs.language} />} />
        <div className="desk-film">
          <Filmstrip replay={replay} elapsed={elapsed} busy={live.busy} disabled={disabled} audience={prefs.audience}
            range={range} onReturn={stopInspect} onChoose={chooseMoment}
            onPlay={live.play} onPause={live.pause} onRestart={restart} onReset={live.reset} onSpeed={live.setSpeed} onSeek={live.seek}
            onGenerate={live.generate} onLoad={live.load} actions={<CommentaryBar c={commentary} language={prefs.language} />} />
        </div>
        <MomentFeed moments={replay.moments} audience={prefs.audience} favoriteTeam={prefs.favoriteTeam} favoritePlayer={prefs.favoritePlayer}
          focusMetric={prefs.focusMetric} analysis={replay.analysis} events={replay.events}
          roster={replay.replay.roster} chosenId={inspectId} onChoose={chooseMoment} onEvidence={setEvidence} onJump={jumpTo} aiMode={replay.insights.status === 'off' ? 'off' : replay.insights.mode} onRecap={openRecapNow}
          nowClock={replay.state.latest_event_sequence ? clockLabel(replay.replay.clock_period, replay.replay.clock_ms) : null}
          catchUp={null} state={replay.state} onDismissCatchUp={noop} />
        <div className="desk-analysis">
        <AnalysisTabs replay={replay} audience={prefs.audience} favoritePlayer={prefs.favoritePlayer}
          busy={live.busy} onJumpMoment={jumpToMoment} tabRequest={tabRequest}
          onSelectEvent={selectFromAnalysis} playhead={Math.round(Math.min(1, elapsed / Math.max(1, replay.replay.duration_ms)) * 200) / 200} />
        </div>
      </div>


    </main>}

    {replay && <>
      <footer className="foot">
        <p className="disclosure-line">{t('All teams, players and events are synthetic. Each explanation is labelled: written by AI and checked against the match data, or written from fixed rules.')}</p>
      </footer>

      <AnimatePresence>
        {evidence && <EvidenceDrawer key={evidence.moment_id} moment={evidence} events={replay.events} roster={replay.replay.roster} reduced={reduced}
          audience={prefs.audience} aiMode={replay.insights.status === 'off' ? 'off' : replay.insights.mode} onClose={() => setEvidence(undefined)} onReplay={moment => { setEvidence(undefined); jumpTo(moment); }} />}
      </AnimatePresence>
    </>}
  </div></LanguageContext.Provider>;
}


/** Language of the moment explanations. Interface chrome stays in English; AI-written text is English only. */
function LanguageToggle({ value, onChange }: { value: 'en' | 'es'; onChange: (value: 'en' | 'es') => void }) {
  return <div className="segmented small lang-toggle" role="group" aria-label="Explanation language / Idioma de las explicaciones">
    {(['en', 'es'] as const).map(code => <button key={code} type="button" aria-pressed={value === code} lang={code}
      aria-label={code === 'en' ? 'English explanations' : 'Explicaciones en español'} onClick={() => onChange(code)}>
      {value === code && <motion.span layoutId="lang-thumb" className="thumb" transition={INDICATOR} />}{code.toUpperCase()}
    </button>)}
  </div>;
}

function AudienceToggle({ value, onChange }: { value: Audience; onChange: (value: Audience) => void }) {
  const tr = useTr();
  return <div className="segmented" role="group" aria-label="Audience mode">
    {(['fan', 'analyst'] as const).map(mode => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)}>
      {value === mode && <motion.span layoutId="audience-thumb" className="thumb" transition={INDICATOR} />}
      {tr(mode === 'fan' ? 'Fan view' : 'Analyst view')}
    </button>)}
  </div>;
}

function Boot({ offline, message, onRetry }: { offline: boolean; message?: string; onRetry: () => void }) {
  if (offline) {
    return <div className="empty" style={{ marginTop: 24, padding: 48 }} role="alert">
      <WifiOff size={28} />
      <strong>{t("The match isn't available right now")}</strong>
      <span>{message ?? 'Check your connection and try again.'}</span>
      <button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} />{t('Try again')}</button>
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
