import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Headphones, ShieldCheck } from 'lucide-react';
import { Pitch } from './components/Pitch';
import { BrandMark } from './components/Crest';
import { useReplay } from './lib/useReplay';
import type { Cue, Feed } from './lib/broadcast';
import { API_BASE_URL } from './lib/api';
import { TEAM_META, runningClock } from './lib/format';
import { LanguageContext, UI, setUiLanguage, useLanguage } from './lib/i18n';
import { Narrator, UNAVAILABLE, speechStatus, type SpeechStatus } from './lib/narration';
import type { Audience, Language } from './lib/prefs';
import './broadcast.css';

/** "/overlay" and "/producer": the broadcast output. The playout runs on the server (GET /api/v1/broadcast), one
 * per audience and language, so every overlay and producer shows the same cue at the same time. These views only
 * read it and the shared replay; they have no controls over the match.
 * /overlay is the program output (?clean=1 for a transparent background to key over video); /producer adds the queue,
 * the log and optional spoken commentary. Query: ?audience=fan|analyst&lang=en|es. */
export default function Broadcast({ mode, reduced }: { mode: 'overlay' | 'producer'; reduced: boolean }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const audience: Audience = params.get('audience') === 'analyst' ? 'analyst' : 'fan';
  const language: Language = params.get('lang') === 'es' ? 'es' : 'en';
  const clean = mode === 'overlay' && params.get('clean') === '1';
  setUiLanguage(language);
  const live = useReplay();
  const { replay } = live;
  const feed = useFeed(audience, language);

  useEffect(() => {
    document.documentElement.dataset.route = mode;
    document.documentElement.dataset.clean = clean ? 'true' : 'false';
    document.title = mode === 'overlay' ? 'OmniPitch · Overlay' : 'OmniPitch · Producer';
  }, [mode, clean]);

  if (!replay) return <main className={`bc bc-${mode}`} aria-busy="true"><p className="bc-wait">{live.connection === 'offline' ? (live.connectionError ?? 'The match isn\'t available right now.') : 'Connecting to the match…'}</p></main>;

  // A cue from another run (just after a restart) is never shown over this one.
  const current = feed?.on_air && feed.run_id === replay.state.run_id ? feed.on_air : null;
  const scoreClock = replay.state.replay_status === 'finished' ? 'FT' : runningClock(replay.replay.clock_period, replay.replay.clock_ms);
  const overlay = <div className="bc-program" data-clean={clean || undefined}>
    <div className="bc-bug" aria-label={`Harbor Comets ${replay.state.score.home}, Vale Owls ${replay.state.score.away}, ${scoreClock}`}>
      <span className="brand-mark"><BrandMark /></span>
      <span style={{ color: 'var(--harbor)' }}>{TEAM_META.harbor.short}</span><b>{replay.state.score.home}</b>
      <i>–</i><b>{replay.state.score.away}</b><span style={{ color: 'var(--vale)' }}>{TEAM_META.vale.short}</span>
      <em>{scoreClock}</em>
    </div>
    {!clean && <div className="bc-pitch"><Pitch events={replay.events} roster={replay.replay.roster} animate={!reduced} compact
      highlightIds={current ? current.source_ids : undefined} numbered={!!current} /></div>}
    <div className="bc-third" aria-live="polite">
      <AnimatePresence mode="wait">
        {current && <LowerThird key={current.message_id} cue={current} reduced={reduced} />}
      </AnimatePresence>
    </div>
    <p className="bc-synthetic">{UI[language].synthetic}</p>
  </div>;

  return <LanguageContext.Provider value={language}>
    <main className={`bc bc-${mode}`} lang={language}>
      {mode === 'overlay' ? overlay : <Producer replay={replay} feed={feed} onAir={current} audience={audience} language={language} program={overlay} />}
    </main>
  </LanguageContext.Provider>;
}

/** Polls the shared playout twice a second; a slow response for a different channel is never applied. */
function useFeed(audience: Audience, language: Language) {
  const [feed, setFeed] = useState<Feed | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/broadcast?audience=${audience}&lang=${language}`, { signal: AbortSignal.timeout(8000) });
        if (response.ok) { const next = await response.json() as Feed; if (active && next.audience === audience && next.language === language) setFeed(next); }
      } catch (error) { console.error('[omnipitch] broadcast', error); }
      if (active) timer = setTimeout(poll, document.hidden ? 2000 : 500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [audience, language]);
  return feed;
}

const LOG_LABEL: Record<string, Record<Language, string>> = {
  shown: { en: 'On air', es: 'En antena' }, revised: { en: 'Updated', es: 'Actualizado' }, preempted: { en: 'Replaced', es: 'Sustituido' },
  expired: { en: 'Ended', es: 'Terminado' }, stale: { en: 'Skipped (too old)', es: 'Omitido (antiguo)' }, reset: { en: 'Cleared', es: 'Borrado' },
};

function LowerThird({ cue, reduced }: { cue: Cue; reduced: boolean }) {
  const t = UI[useLanguage()];
  const tone = cue.rule === 'goal' ? 'var(--amber)' : 'var(--cobalt-text)';
  return <motion.section className="bc-cue" data-kind={cue.kind} style={{ ['--tone' as string]: tone }}
    initial={reduced ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
    transition={{ duration: reduced ? 0 : .26, ease: [.23, 1, .32, 1] }}>
    <div className="bc-cue-head">
      <span className="bc-minute">{cue.match_clock.label}</span>
      <h2>{cue.headline}</h2>
    </div>
    <p>{cue.text}</p>
    <footer>
      {cue.measurements.map(m => <span key={m.label}><b>{m.value}{m.unit ? ` ${m.unit}` : ''}</b> {m.label}</span>)}
      <small>{cue.validation === 'passed' ? <><ShieldCheck size={12} aria-hidden="true" /> {t.aiValidated}</> : t.ruleBased}</small>
    </footer>
  </motion.section>;
}

function Producer({ replay, feed, onAir, audience, language, program }: {
  replay: NonNullable<ReturnType<typeof useReplay>['replay']>; feed: Feed | null; onAir: Cue | null; audience: Audience; language: Language; program: React.ReactNode;
}) {
  // Spoken commentary follows the playout: each cue as it airs; a pre-empting goal cancels the line before it.
  const [commentary, setCommentary] = useState(false);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [voice, setVoice] = useState('');
  const narrator = useRef<Narrator>(undefined);
  narrator.current ??= new Narrator('live', (next, error) => setVoice(next === 'error' ? (error ?? UNAVAILABLE) : next));
  useEffect(() => () => narrator.current?.stop(), []);
  useEffect(() => {
    if (!commentary) { narrator.current?.stop(); return; }
    void speechStatus().then(setSpeech);
  }, [commentary]);
  useEffect(() => {
    if (!commentary || !speech?.configured) return;
    if (!onAir) { narrator.current?.stop(); return; }
    void narrator.current!.speak({ moment_id: onAir.moment_id, audience: onAir.audience, language: onAir.language });
  }, [commentary, speech, onAir?.message_id, onAir?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const es = language === 'es';
  const link = (next: Partial<{ audience: Audience; lang: Language; clean: string }>) => `?${new URLSearchParams({ audience, lang: language, ...next })}`;
  const voiceLabel: Record<string, string> = { loading: es ? 'Preparando' : 'Preparing', playing: es ? 'Hablando' : 'Speaking', ended: es ? 'Esperando la próxima' : 'Waiting for the next cue', idle: es ? 'Esperando la próxima' : 'Waiting for the next cue' };
  return <div className="bc-desk">
    <header className="bc-head">
      <h1>{es ? 'Vista de producción' : 'Producer preview'}</h1>
      <nav aria-label={es ? 'Salida' : 'Output'}>
        <a href={link({ audience: 'fan' })} aria-current={audience === 'fan' || undefined}>Fan</a>
        <a href={link({ audience: 'analyst' })} aria-current={audience === 'analyst' || undefined}>{es ? 'Analista' : 'Analyst'}</a>
        <a href={link({ lang: 'en' })} aria-current={language === 'en' || undefined}>EN</a>
        <a href={link({ lang: 'es' })} aria-current={language === 'es' || undefined}>ES</a>
        <a href={`/overlay${link({})}`} target="_blank" rel="noreferrer">{es ? 'Abrir salida de programa' : 'Open program output'}</a>
        <a href={`/overlay${link({ clean: '1' })}`} target="_blank" rel="noreferrer">{es ? 'Overlay limpio' : 'Clean overlay (keyable)'}</a>
        <button type="button" aria-pressed={commentary} onClick={() => { if (!commentary) narrator.current?.prime(); setCommentary(value => !value); }}>
          <Headphones size={14} aria-hidden="true" />{es ? `Narración ${commentary ? 'activada' : 'desactivada'}` : `Audio commentary ${commentary ? 'on' : 'off'}`}</button>
      </nav>
    </header>
    <div className="bc-grid">
      <section aria-label={es ? 'Vista previa' : 'Program preview'} className="bc-monitor">{program}</section>
      <section className="bc-side" aria-label={es ? 'Programación' : 'Schedule'}>
        <dl className="bc-facts">
          <div><dt>{es ? 'Partido' : 'Match'}</dt><dd>{feed?.position.clock ?? '–'} · {replay.state.replay_status === 'playing' ? (es ? `en juego a ${replay.replay.speed}×` : `playing at ${replay.replay.speed}×`) : replay.state.replay_status === 'finished' ? (es ? 'final' : 'full-time') : (es ? 'en pausa' : 'paused')}</dd></div>
          <div><dt>{es ? 'Antigüedad' : 'Freshness'}</dt><dd>{es ? 'Las historias de más de 3 minutos de partido no se emiten' : 'Stories more than 3 match minutes old are not aired'}</dd></div>
          <div><dt>{es ? 'Narración' : 'Commentary'}</dt><dd>{!commentary ? (es ? 'Desactivada (solo empieza al activarla)' : 'Off (starts only when switched on)')
            : !speech ? '…' : !speech.configured ? UNAVAILABLE : voiceLabel[voice] ?? voice}</dd></div>
        </dl>
        <h2>{es ? 'A continuación' : 'Up next'}</h2>
        {!feed?.queue.length ? <p className="hint">{es ? 'Nada en espera.' : 'Nothing waiting.'}</p>
          : <ol className="bc-queue">{feed.queue.map(cue => <li key={cue.message_id}>
              <span>{cue.match_clock.label}</span><b>{cue.headline}</b><small>{cue.kind === 'major' ? (es ? 'Prioridad' : 'Priority') : ''}</small></li>)}</ol>}
        <h2>{es ? 'Registro' : 'Log'}</h2>
        <ol className="bc-log">{(feed?.log ?? []).slice().reverse().map((entry, index) => <li key={index}>
          <span>{LOG_LABEL[entry.event]?.[language] ?? entry.event}</span><b>{entry.clock} {entry.headline}</b><small>{entry.revision > 1 ? (es ? 'Texto IA' : 'AI text') : ''}</small></li>)}</ol>
      </section>
    </div>
  </div>;
}
