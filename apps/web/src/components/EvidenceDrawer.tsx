import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { num, t } from '../lib/i18n';
import { motion } from 'motion/react';
import { Headphones, Pause, Play, RotateCcw, Square, Volume2, X } from 'lucide-react';
import type { Event, Moment, Player } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, TEAM_META, clockLabel, eventLabel, metricText, playerIndex, runningClock, surname, teamTone } from '../lib/format';
import { AskMoment } from './AskMoment';
import { forwardGain, passDifficulty, passLength } from '../lib/geometry';
import { Narrator, speechStatus, type NarratorState, type SpeechStatus } from '../lib/narration';
import { GENERATION_LABEL, TRIGGER, calculationRows, generation, metricRows, whyItMatters } from '../lib/evidence';
import { DUR, EASE_DRAWER, EASE_OUT, INDICATOR } from '../lib/motion';
import { Pitch, PitchLegend } from './Pitch';
import { RULE_ICON } from './MomentFeed';
import type { CameraMode } from './Tactical3D';
import { UI, localStory, useLanguage, useTr, whyEs } from '../lib/i18n';

// three.js lives in its own chunk and is fetched only when someone opens the 3D view.
const Tactical3D = lazy(() => import('./Tactical3D'));

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch { return false; }
}

/** The source record behind the selected step, as recorded. */
function SourceRecord({ event, name }: { event: Event; name?: string }) {
  return <dl className="source-record" aria-label={t('Source record for the selected step')}>
    <dt>{t('Action')}</dt><dd>{eventLabel(event)}</dd>
    <dt>{t('Player')}</dt><dd>{name ?? '–'}{event.team_id ? ` · ${TEAM_META[event.team_id]?.name ?? ''}` : ''}</dd>
    <dt>{t('Time')}</dt><dd>{clockLabel(event.period, event.match_time_ms)} ({runningClock(event.period, event.match_time_ms)}, {t(event.period === 1 ? 'first half' : 'second half')})</dd>
    {event.start && event.end && event.attacking_direction && <><dt>{t(event.type === 'shot' ? 'Shot' : 'Distance')}</dt>
      <dd>{metricText('pass_distance', passLength(event.start, event.end))} {t('m long')} · {signedMetres(forwardGain(event.start, event.end, event.attacking_direction))} {t('towards goal')}</dd></>}
    {event.type === 'pass' && event.start && event.end && event.attacking_direction && (() => {
      const d = passDifficulty(event.start, event.end, event.attacking_direction);
      return <><dt>{t('Difficulty')}</dt><dd>{d.score}/100, {t(d.band)} {t('(an indicator from length, forward gain, destination and width; not a completion probability)')}</dd></>;
    })()}
    <dt>{t('Pitch position')}</dt><dd>{event.start ? `${event.start.x} ${t('m along')}, ${event.start.y} ${t('m across')}` : t('not recorded')}{event.end ? `, ${t('to')} ${event.end.x} ${t('m along')}, ${event.end.y} ${t('m across')}` : ''}
      {event.attacking_direction ? ` · ${t('attacking')} ${t(event.attacking_direction === 'positive_x' ? 'the right-hand goal' : 'the left-hand goal')}` : ''}</dd>
  </dl>;
}

const signedMetres = (value: number) => `${value >= 0 ? '+' : '−'}${metricText('forward_progress', Math.abs(value))} m`;

/** How this explanation came to be, in plain language: what triggered it, what was measured, who wrote the words. */
function Production({ moment, gen }: { moment: Moment; gen: ReturnType<typeof generation> }) {
  const tr = useTr();
  const explained = {
    ai: "Written by AI from this moment's recorded actions and measurements only, then checked automatically: every number, name and score in it matches the data.",
    rule: 'Written from fixed rules using the measurements above.',
    pending: 'Written from fixed rules for now; an AI-written version may follow once it has been checked.',
    skipped: 'Written from fixed rules; AI writing was not used for this moment.',
    rejected: 'Written from fixed rules, because an AI draft did not match the data and was discarded.',
    failure: 'Written from fixed rules, because AI writing was unavailable.',
    fixture: 'A hand-written example.',
  }[gen];
  return <ol className="production">
    <li><b>{tr('Selected')}</b><span>{tr(TRIGGER[moment.rule])}. {moment.evidence_ids.length} {t(moment.evidence_ids.length === 1 ? 'recorded action supports it.' : 'recorded actions support it.')}</span></li>
    <li><b>{tr('Measured')}</b><span>{moment.metrics.length} {t(moment.metrics.length === 1 ? 'measurement, calculated from those actions.' : 'measurements, calculated from those actions.')}</span></li>
    <li><b>{tr('Written')}</b><span>{t(explained)}</span></li>
  </ol>;
}

/** Evidence for one moment: 1 claim, 2 source sequence, 3 key values, 4 calculation and trigger,
 * 5 sources, limitations and provenance. Fans see the claim and the sequence first, with the numbers and
 * the calculation one click away; analysts see every section open. Same facts either way. */
export function EvidenceDrawer({ moment, events, roster, audience, aiMode, onClose, onReplay, reduced }: {
  moment: Moment; events: Event[]; roster: Player[]; audience: Audience; aiMode: string; onClose: () => void; onReplay: (moment: Moment) => void; reduced: boolean;
}) {
  const tr = useTr();
  const gen = generation(moment, aiMode);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const fan = audience === 'fan';
  const [other, setOther] = useState(false);
  const [step, setStep] = useState<number>();
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [camera, setCamera] = useState<CameraMode>('broadcast');
  const [noGl, setNoGl] = useState<string | null>(null);
  const [localPlaying, setLocalPlaying] = useState(false);
  const people = useMemo(() => playerIndex(roster), [roster]);
  // Keyed by the cited IDs that are present, so polling does not hand the 3D scene a new array every update.
  const evidenceKey = events.filter(event => moment.evidence_ids.includes(event.event_id)).map(event => event.event_id).join(',');
  const evidence = useMemo(() => events.filter(event => moment.evidence_ids.includes(event.event_id)), [evidenceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const located = useMemo(() => evidence.filter(event => event.start), [evidence]);
  const activeIndex = step ?? Math.max(0, located.length - 1);
  const shownView = noGl ? '2d' : view;
  const pick = (index: number) => { if (index < 0) return; setLocalPlaying(false); setStep(current => current === index ? undefined : index); };
  const toggleLocal = () => {
    if (localPlaying) { setLocalPlaying(false); return; }
    setStep(0);
    setLocalPlaying(true);
  };

  // Local sequence replay: one step at a time, then stop. It never touches the shared replay.
  useEffect(() => {
    if (!localPlaying) return;
    const timer = setInterval(() => setStep(current => {
      const next = (current ?? 0) + 1;
      if (next >= located.length) { setLocalPlaying(false); return located.length - 1; }
      return next;
    }), reduced ? 1400 : 1100);
    return () => clearInterval(timer);
  }, [localPlaying, located.length, reduced]);
  useEffect(() => { if (view === '3d' && !webglAvailable()) { console.error('[omnipitch] 3D unavailable: no WebGL'); setNoGl('2d'); } }, [view]);
  const Icon = RULE_ICON[moment.rule];
  const language = useLanguage();
  const story = localStory(moment, roster, language);
  const primary = fan ? story.casual : story.analyst;
  const secondary = fan ? story.analyst : story.casual;
  const rows = metricRows(moment);
  // Listen + replay: the local sequence replay with captions and, when the server has Azure Speech, narration.
  // The text is frozen when it starts, so a later AI upgrade or language switch never changes it mid-play.
  const [listen, setListen] = useState<{ caption: string; language: 'en' | 'es' } | null>(null);
  const [voice, setVoice] = useState<{ state: NarratorState; error: string | null }>({ state: 'idle', error: null });
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const narrator = useRef<Narrator>(undefined);
  narrator.current ??= new Narrator('evidence', (state, error) => setVoice({ state, error }));
  useEffect(() => () => narrator.current?.stop(), []);
  const startListen = () => {
    const spokenLanguage = story.englishOnly ? 'en' : language;
    const caption = `${story.headline}. ${primary}`;
    narrator.current!.prime();  // inside the click: the narration starts after the request returns
    setListen({ caption, language: spokenLanguage });
    setStep(0);
    setLocalPlaying(true);
    void speechStatus().then(status => {
      setSpeech(status);
      if (status.configured) void narrator.current!.speak({ moment_id: moment.moment_id, audience, language: spokenLanguage });
    });
  };
  const stopListen = () => { narrator.current?.stop(); setLocalPlaying(false); setListen(null); };
  // Pause and resume cover both the sequence and the voice: either may still be running after the other ends.
  const listening = localPlaying || voice.state === 'playing' || voice.state === 'loading';
  const pauseListen = () => {
    if (listening) { setLocalPlaying(false); narrator.current?.pause(); }
    else { if (activeIndex < located.length - 1) setLocalPlaying(true); narrator.current?.resume(); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      // Modal: keep keyboard focus inside the drawer.
      const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button, [href], summary, [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter(el => !el.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);

  const slide = reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { transform: 'translateX(100%)' }, animate: { transform: 'translateX(0%)' }, exit: { transform: 'translateX(100%)' } };

  const values = <dl className="value-grid">
    {rows.map(row => <div key={row.name}><dt>{tr(row.label)}</dt><dd>{num(row.shown)}{row.unit && <small>{tr(row.unit)}</small>}</dd></div>)}
  </dl>;
  const calc = <dl className="facts">
    {calculationRows(moment).map(([term, value]) => <div key={term} style={{ display: 'contents' }}><dt>{term}</dt><dd>{value}</dd></div>)}
  </dl>;

  return <>
    <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: DUR.drawer, ease: EASE_OUT }} />
    <motion.aside ref={drawerRef} className="drawer" data-audience={audience} role="dialog" aria-modal="true" aria-labelledby="evidence-title" {...slide}
      transition={{ duration: DUR.drawer, ease: EASE_DRAWER }}>
      <div className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <div className="spot-meta">
            <span className="spot-minute" style={{ fontSize: 24 }}>{clockLabel(moment.period, moment.match_time_ms)}</span>
            <span className="rule-tag"><Icon size={13} aria-hidden="true" />{tr(RULE_LABEL[moment.rule])}</span>
            <span className="mode-badge" data-mode={gen}>{tr(GENERATION_LABEL[gen])}</span>
          </div>
          <h2 id="evidence-title" lang={language}>{story.headline}</h2>
        </div>
        <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={tr('Close evidence')}><X size={18} /></button>
      </div>
      <div className="drawer-body">
        <section className="drawer-section" aria-labelledby="ev-what">
          <h3 id="ev-what"><span className="step">1</span>{tr(fan ? 'What happened, and why it matters' : 'Claim and explanation')}</h3>
          <p className="lead" lang={story.englishOnly ? 'en' : language}>{primary}</p>
          {story.englishOnly && <p className="hint">{UI[language].aiEnglish}</p>}
          <p className="why" lang={language}><b>{UI[language].whyPrefix}</b>{language === 'es' ? whyEs(moment, audience) : whyItMatters(moment, audience)}</p>
          <button type="button" className="text-button quiet" aria-expanded={other} onClick={() => setOther(value => !value)} style={{ justifySelf: 'start' }}>
            {t(`${other ? 'Hide' : 'Show'} the ${fan ? 'analyst' : 'fan'} explanation`)}
          </button>
          {other && <div className="quote"><small>{t(fan ? 'For analysts' : 'For fans')}</small>{secondary}</div>}
        </section>

        <section className="drawer-section" aria-labelledby="ev-sequence">
          <h3 id="ev-sequence"><span className="step">2</span>{tr('Source action sequence')} <span className="hint">{evidence.length} {tr(evidence.length === 1 ? 'recorded event' : 'recorded events')}</span></h3>
          <div className="view-bar">
            <div className="segmented small" role="radiogroup" aria-label={t('Sequence view')}>
              {(['2d', '3d'] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={shownView === mode}
                disabled={mode === '3d' && !!noGl} onClick={() => setView(mode)}>
                {shownView === mode && <motion.span layoutId="view-thumb" className="thumb" transition={INDICATOR} />}{tr(mode === '2d' ? '2D pitch' : '3D replay')}
              </button>)}
            </div>
            {shownView === '3d' && <div className="segmented small" role="radiogroup" aria-label={t('Camera')}>
              {(['broadcast', 'overhead'] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={camera === mode} onClick={() => setCamera(mode)}>
                {camera === mode && <motion.span layoutId="camera-thumb" className="thumb" transition={INDICATOR} />}{tr(mode === 'broadcast' ? 'Angled view' : 'Overhead view')}
              </button>)}
            </div>}
            <span className="spacer" />
            {!listen && <button type="button" className="button" onClick={toggleLocal} disabled={located.length < 2}
              aria-label={t(localPlaying ? 'Pause sequence replay' : 'Play sequence replay')}>
              {localPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{localPlaying ? 'Pause' : tr('Play sequence here')}
            </button>}
            {!listen && <button type="button" className="button" onClick={startListen} disabled={located.length < 1}>
              <Headphones size={15} aria-hidden="true" />{tr('Listen + replay')}</button>}
          </div>
          {listen && <div className="listen" role="region" aria-label="Listen and replay">
            <div className="listen-controls">
              <button type="button" className="button" onClick={pauseListen} disabled={!listening && voice.state !== 'paused' && activeIndex >= located.length - 1}>
                {listening ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{listening ? tr('Pause') : tr('Resume')}</button>
              <button type="button" className="button" onClick={startListen}><RotateCcw size={15} aria-hidden="true" />{tr('Replay')}</button>
              <button type="button" className="button" onClick={stopListen}><Square size={14} aria-hidden="true" />{tr('Stop')}</button>
              <label className="listen-volume"><Volume2 size={15} aria-hidden="true" /><span className="sr-only">Volume</span>
                <input type="range" min="0" max="1" step="0.05" defaultValue={narrator.current?.volume ?? .9}
                  disabled={!speech?.configured} onChange={event => narrator.current?.setVolume(Number(event.target.value))} /></label>
            </div>
            <p className="listen-status" aria-live="polite">{!speech ? 'Preparing…'
              : !speech.configured ? 'Captions only: narration audio is not configured on this server.'
              : voice.state === 'loading' ? 'Loading narration…' : voice.state === 'error' ? `Captions only: ${voice.error}`
              : voice.state === 'ended' ? 'Narration finished.' : 'Narrated with Azure AI Speech from the accepted text.'}</p>
            <p className="listen-caption" lang={listen.language}>{listen.caption}</p>
            {located[activeIndex] && <p className="listen-step">Step {activeIndex + 1} of {located.length}: <b>{eventLabel(located[activeIndex])}</b> · {surname(people.get(located[activeIndex].player_id ?? ''))} · {clockLabel(located[activeIndex].period, located[activeIndex].match_time_ms)}</p>}
          </div>}
          <div className="replay-view">
            {shownView === '3d'
              ? <Suspense fallback={<div className="stage3d" aria-busy="true" />}>
                  <Tactical3D steps={located} active={activeIndex} camera={camera} reduced={reduced} onFallback={reason => { console.error('[omnipitch] 3D fallback', reason); setNoGl('2d'); setView('2d'); }} />
                </Suspense>
              : <Pitch events={events} highlightIds={moment.evidence_ids} emphasisId={located[activeIndex]?.event_id} roster={roster} animate={!reduced} compact numbered
                  onSelect={event => pick(located.findIndex(e => e.event_id === event.event_id))} />}
          </div>
          <p className="view-note">{noGl ? `${t('This browser is showing the 2D replay.')} ` : ''}{t(shownView === '3d'
            ? 'Recorded start and end points on the ground plane, joined by straight lines; the moving ball is illustrative. No player positions, formation or ball height are recorded, so none are shown. Playing here does not change the shared replay.'
            : 'Recorded start and end points joined by straight lines. Playing here does not change the shared replay.')}</p>
          {shownView === '2d' && <PitchLegend compact />}
          <ol className="stepper" aria-label={t('Sequence steps')}>
            {located.map((event, index) => <li key={event.event_id}>
              <button type="button" aria-pressed={activeIndex === index} style={{ ['--tone' as string]: event.type === 'shot' ? 'var(--amber)' : teamTone(event.team_id) }}
                onClick={() => pick(index)}>
                <span className="node">{index + 1}</span>
                <span><b>{eventLabel(event)}</b> · {surname(people.get(event.player_id ?? ''))}</span>
                <span className="hint num">{clockLabel(event.period, event.match_time_ms)}</span>
              </button>
            </li>)}
            {evidence.length < moment.evidence_ids.length && <li className="hint">{t('Some cited events are outside the current replay position.')}</li>}
          </ol>
          {located[activeIndex] && (fan
            ? <details className="disclosure"><summary>{t('Source record for step')} {activeIndex + 1}</summary><div><SourceRecord event={located[activeIndex]} name={people.get(located[activeIndex].player_id ?? '')?.name} /></div></details>
            : <SourceRecord event={located[activeIndex]} name={people.get(located[activeIndex].player_id ?? '')?.name} />)}
          <button type="button" className="button" style={{ justifySelf: 'start' }} onClick={() => onReplay(moment)}>
            <RotateCcw size={15} aria-hidden="true" />{t('Jump the match to')} {clockLabel(moment.period, moment.match_time_ms)}
          </button>
        </section>

        <AskMoment moment={moment} events={events} roster={roster} onSource={id => {
          const index = located.findIndex(event => event.event_id === id);
          if (index >= 0) { pick(index); drawerRef.current?.querySelector('.stepper')?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); }
        }} />

        {fan
          ? <section className="drawer-section" aria-labelledby="ev-more">
              <h3 id="ev-more"><span className="step">3</span>{tr('The numbers behind it')}</h3>
              <details className="disclosure"><summary>{tr('Key values · Metrics behind it')}</summary><div>{values}</div></details>
              <details className="disclosure"><summary>{tr('How it was detected')}</summary><div>{calc}</div></details>
            </section>
          : <>
            <section className="drawer-section" aria-labelledby="ev-values">
              <h3 id="ev-values"><span className="step">3</span>Key values <span className="hint">Metrics behind it</span></h3>
              {values}
              <details className="disclosure">
                <summary>{t('Exact values and formatting')}</summary>
                <div>
                  <table className="metric-table">
                    <thead><tr><th>{t('Metric')}</th><th className="num">{t('Exact value')}</th><th>{t('Unit')}</th></tr></thead>
                    <tbody>{rows.map(row => <tr key={row.name}><td>{tr(row.label)}</td><td className="num">{row.stored}</td><td>{row.unit && tr(row.unit)}</td></tr>)}</tbody>
                  </table>
                  <p className="hint">{t('Values are shown to one decimal, the same as in the story text. Distances are in metres; times in seconds.')}</p>
                </div>
              </details>
            </section>
            <section className="drawer-section" aria-labelledby="ev-calc">
              <h3 id="ev-calc"><span className="step">4</span>{tr('Calculation and trigger')}</h3>
              {calc}
            </section>
          </>}

        <section className="drawer-section" aria-labelledby="ev-limits">
          <h3 id="ev-limits"><span className="step">{fan ? 4 : 5}</span>{tr('What the data can and can\'t say')}</h3>
          <ul className="limitations">{moment.insight.limitations.filter(item => !/^AI narration (is not connected|unavailable)/.test(item)).map(item => <li key={item}>{t(item)}</li>)}</ul>
          <details className="disclosure" open={!fan}>
            <summary>{tr('How this explanation was produced')}</summary>
            <div><Production moment={moment} gen={gen} /></div>
          </details>
          <details className="disclosure">
            <summary>{tr('About these numbers')}</summary>
            <div>
              <dl className="facts">
                <dt>{t('Minutes')}</dt><dd>{t("25' is the 25th minute (24:00–24:59); exact times are shown for each action")}</dd>
                <dt>{t('Pitch')}</dt><dd>{t('A 105 × 68 m pitch; distances are in metres, and "towards goal" uses the attacking team\'s direction')}</dd>
                <dt>{t('Data')}</dt><dd>{t('Recorded on-ball actions only: no player tracking, speed or distance covered')}</dd>
              </dl>
            </div>
          </details>
        </section>
      </div>
    </motion.aside>
  </>;
}
