import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, RotateCcw, X } from 'lucide-react';
import type { Event, Moment, Player } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, TEAM_META, clockLabel, eventLabel, playerIndex, runningClock, surname, teamTone } from '../lib/format';
import { GENERATION_LABEL, calculationRows, generation, metricRows, whyItMatters } from '../lib/evidence';
import { DUR, EASE_DRAWER, EASE_OUT, INDICATOR } from '../lib/motion';
import { Pitch, PitchLegend } from './Pitch';
import { RULE_ICON } from './MomentFeed';
import type { CameraMode } from './Tactical3D';

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
  return <dl className="source-record" aria-label="Source record for the selected step">
    <dt>Event</dt><dd>{event.event_id} · sequence {event.sequence}</dd>
    <dt>Action</dt><dd>{event.type}{event.outcome ? ` · ${event.outcome}` : ''}{event.is_goal ? ' · goal' : ''}</dd>
    <dt>Player</dt><dd>{name ?? event.player_id ?? 'none'} · {event.team_id ? TEAM_META[event.team_id]?.name ?? event.team_id : 'no team'}</dd>
    <dt>Time</dt><dd>{clockLabel(event.period, event.match_time_ms)} ({runningClock(event.period, event.match_time_ms)}, {event.period === 1 ? 'first' : 'second'} half)</dd>
    <dt>Location</dt><dd>{event.start ? `(${event.start.x}, ${event.start.y})` : 'not recorded'}{event.end ? ` → (${event.end.x}, ${event.end.y})` : ''} m
      {event.attacking_direction ? ` · attacking ${event.attacking_direction === 'positive_x' ? '+x' : '−x'}` : ''}</dd>
  </dl>;
}

/** The actual stages behind one insight, from its own records. No model reasoning is shown or invented. */
function Production({ moment, gen }: { moment: Moment; gen: ReturnType<typeof generation> }) {
  const reason = moment.insight.limitations.find(item => item.startsWith('AI narration unavailable'))?.match(/\(([^)]*)\)/)?.[1];
  const explained = {
    ai: 'The AI model wrote the text from this evidence packet only (moment, metrics, facts and source events).',
    fallback: `An AI attempt did not produce accepted text${reason ? ` (${reason})` : ''}, so the rule-based template is shown.`,
    pending: 'AI narration is switched on, but this moment has not been narrated yet, so the rule-based template is shown.',
    rule: 'A rule-based template filled in from the metrics. No model was involved.',
    fixture: 'A hand-authored test fixture.',
  }[gen];
  const checked = gen === 'ai'
    ? 'Passed the code validator: every number, name, event ID and score claim matches the evidence. The API checks it again before display.'
    : 'Template numbers are copied from the metrics, so there is no model output to check.';
  return <ol className="production">
    <li><b>Detected</b><span>Rule {moment.rule} {moment.rule_version} fired at event {moment.source_sequence}, citing {moment.evidence_ids.length} source {moment.evidence_ids.length === 1 ? 'event' : 'events'}.</span></li>
    <li><b>Measured</b><span>{moment.metrics.length} {moment.metrics.length === 1 ? 'metric' : 'metrics'} calculated in code ({moment.metric_version}).</span></li>
    <li><b>Explained</b><span>{explained}</span></li>
    <li><b>Checked</b><span>{checked}</span></li>
  </ol>;
}

/** Evidence for one moment: 1 claim, 2 source sequence, 3 key values, 4 calculation and trigger,
 * 5 sources, limitations and provenance. Fans see the claim and the sequence first, with the numbers and
 * the calculation one click away; analysts see every section open. Same facts either way. */
export function EvidenceDrawer({ moment, events, roster, audience, aiMode, onClose, onReplay, reduced }: {
  moment: Moment; events: Event[]; roster: Player[]; audience: Audience; aiMode: string; onClose: () => void; onReplay: (moment: Moment) => void; reduced: boolean;
}) {
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
  useEffect(() => { if (view === '3d' && !webglAvailable()) { setNoGl('3D needs WebGL, which this browser does not provide.'); } }, [view]);
  const Icon = RULE_ICON[moment.rule];
  const primary = fan ? moment.insight.casual_text : moment.insight.analyst_text;
  const secondary = fan ? moment.insight.analyst_text : moment.insight.casual_text;
  const rows = metricRows(moment);
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
    {rows.map(row => <div key={row.name}><dt>{row.label}</dt><dd>{row.shown}{row.unit && <small>{row.unit}</small>}</dd></div>)}
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
            <span className="rule-tag"><Icon size={13} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
            <span className="mode-badge" data-mode={gen}>{GENERATION_LABEL[gen]}</span>
          </div>
          <h2 id="evidence-title">{moment.insight.headline}</h2>
        </div>
        <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close evidence"><X size={18} /></button>
      </div>
      <div className="drawer-body">
        <section className="drawer-section" aria-labelledby="ev-what">
          <h3 id="ev-what"><span className="step">1</span>{fan ? 'What happened, and why it matters' : 'Claim and explanation'}</h3>
          <p className="lead">{primary}</p>
          <p className="why"><b>Why it matters. </b>{whyItMatters(moment, audience)}</p>
          <button type="button" className="text-button quiet" aria-expanded={other} onClick={() => setOther(value => !value)} style={{ justifySelf: 'start' }}>
            {other ? 'Hide' : 'Show'} the {fan ? 'analyst' : 'fan'} explanation
          </button>
          {other && <div className="quote"><small>For {fan ? 'analysts' : 'fans'}</small>{secondary}</div>}
        </section>

        <section className="drawer-section" aria-labelledby="ev-sequence">
          <h3 id="ev-sequence"><span className="step">2</span>Source action sequence <span className="hint">{evidence.length} recorded {evidence.length === 1 ? 'event' : 'events'}</span></h3>
          <div className="view-bar">
            <div className="segmented small" role="radiogroup" aria-label="Sequence view">
              {(['2d', '3d'] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={shownView === mode}
                disabled={mode === '3d' && !!noGl} onClick={() => setView(mode)}>
                {shownView === mode && <motion.span layoutId="view-thumb" className="thumb" transition={INDICATOR} />}{mode === '2d' ? '2D pitch' : '3D replay'}
              </button>)}
            </div>
            {shownView === '3d' && <div className="segmented small" role="radiogroup" aria-label="Camera">
              {(['broadcast', 'overhead'] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={camera === mode} onClick={() => setCamera(mode)}>
                {camera === mode && <motion.span layoutId="camera-thumb" className="thumb" transition={INDICATOR} />}{mode === 'broadcast' ? 'Angled view' : 'Overhead view'}
              </button>)}
            </div>}
            <span className="spacer" />
            <button type="button" className="button" onClick={toggleLocal} disabled={located.length < 2}
              aria-label={localPlaying ? 'Pause sequence replay' : 'Play sequence replay'}>
              {localPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{localPlaying ? 'Pause' : 'Play sequence'}
            </button>
          </div>
          <div className="replay-view">
            {shownView === '3d'
              ? <Suspense fallback={<div className="stage3d" aria-busy="true" />}>
                  <Tactical3D steps={located} active={activeIndex} camera={camera} reduced={reduced} onFallback={reason => { setNoGl(reason); setView('2d'); }} />
                </Suspense>
              : <Pitch events={events} highlightIds={moment.evidence_ids} emphasisId={located[activeIndex]?.event_id} roster={roster} animate={!reduced} compact numbered
                  onSelect={event => pick(located.findIndex(e => e.event_id === event.event_id))} />}
          </div>
          <p className="view-note">{noGl ? `${noGl} Showing the 2D pitch instead. ` : ''}{shownView === '3d'
            ? 'Recorded start and end points on the ground plane, joined by straight lines; the moving ball is illustrative. No player positions, formation or ball height are recorded, so none are shown. Playing here does not change the shared replay.'
            : 'Recorded start and end points joined by straight lines. Playing here does not change the shared replay.'}</p>
          {shownView === '2d' && <PitchLegend compact />}
          <ol className="stepper" aria-label="Sequence steps">
            {located.map((event, index) => <li key={event.event_id}>
              <button type="button" aria-pressed={activeIndex === index} style={{ ['--tone' as string]: event.type === 'shot' ? 'var(--amber)' : teamTone(event.team_id) }}
                onClick={() => pick(index)}>
                <span className="node">{index + 1}</span>
                <span><b>{eventLabel(event)}</b> · {surname(people.get(event.player_id ?? ''))}</span>
                <span className="hint num">{clockLabel(event.period, event.match_time_ms)}</span>
              </button>
            </li>)}
            {evidence.length < moment.evidence_ids.length && <li className="hint">Some cited events are outside the current replay position.</li>}
          </ol>
          {located[activeIndex] && (fan
            ? <details className="disclosure"><summary>Source record for step {activeIndex + 1}</summary><div><SourceRecord event={located[activeIndex]} name={people.get(located[activeIndex].player_id ?? '')?.name} /></div></details>
            : <SourceRecord event={located[activeIndex]} name={people.get(located[activeIndex].player_id ?? '')?.name} />)}
          <button type="button" className="button" style={{ justifySelf: 'start' }} onClick={() => onReplay(moment)}>
            <RotateCcw size={15} aria-hidden="true" />{fan ? 'Replay moment' : 'Replay this sequence'} from {clockLabel(moment.period, moment.match_time_ms)}
          </button>
        </section>

        {fan
          ? <section className="drawer-section" aria-labelledby="ev-more">
              <h3 id="ev-more"><span className="step">3</span>The numbers behind it</h3>
              <details className="disclosure"><summary>Key values · Metrics behind it</summary><div>{values}</div></details>
              <details className="disclosure"><summary>How it was detected</summary><div>{calc}</div></details>
            </section>
          : <>
            <section className="drawer-section" aria-labelledby="ev-values">
              <h3 id="ev-values"><span className="step">3</span>Key values <span className="hint">Metrics behind it</span></h3>
              {values}
              <details className="disclosure">
                <summary>Exact values and formatting</summary>
                <div>
                  <table className="metric-table">
                    <thead><tr><th>Metric</th><th className="num">Exact value</th><th>Unit</th></tr></thead>
                    <tbody>{rows.map(row => <tr key={row.name}><td>{row.label}</td><td className="num mono">{row.stored}</td><td>{row.unit}</td></tr>)}</tbody>
                  </table>
                  <p className="hint">Displayed values use the same rule as the story text (one decimal below 10, half to even; the exact value at 10 and above), so a sentence and its card always match. Distances are in metres; times in seconds.</p>
                </div>
              </details>
            </section>
            <section className="drawer-section" aria-labelledby="ev-calc">
              <h3 id="ev-calc"><span className="step">4</span>Calculation and trigger</h3>
              {calc}
            </section>
          </>}

        <section className="drawer-section" aria-labelledby="ev-limits">
          <h3 id="ev-limits"><span className="step">{fan ? 4 : 5}</span>Sources, limitations and provenance</h3>
          <ul className="limitations">{moment.insight.limitations.map(item => <li key={item}>{item}</li>)}</ul>
          <details className="disclosure" open={!fan}>
            <summary>How this insight was produced</summary>
            <div><Production moment={moment} gen={gen} /></div>
          </details>
          <details className="disclosure" open={!fan}>
            <summary>Provenance and identifiers</summary>
            <div>
              <dl className="facts">
                <dt>Moment</dt><dd className="mono">{moment.moment_id}</dd>
                <dt>Rule</dt><dd>{moment.rule} {moment.rule_version}</dd>
                <dt>Metric version</dt><dd>{moment.metric_version}</dd>
                <dt>Detected at</dt><dd>event {moment.source_sequence} (anchor {moment.anchor_sequence})</dd>
                <dt>Evidence IDs</dt><dd className="mono">{moment.evidence_ids.join(', ')}</dd>
                <dt>Minute labels</dt><dd>Broadcast convention: 25' is the 25th minute (24:00–24:59); exact times are in each source record</dd>
                <dt>Coordinates</dt><dd>OmniPitch's simulated 105 × 68 m pitch (not a universal size); metrics use the acting team's attacking direction</dd>
                <dt>Knowledge</dt><dd>{moment.insight.knowledge_source_ids.join(', ') || 'none'}</dd>
              </dl>
            </div>
          </details>
        </section>
      </div>
    </motion.aside>
  </>;
}
