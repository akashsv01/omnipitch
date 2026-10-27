import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, RotateCcw } from 'lucide-react';
import { Brand } from './components/Crest';
import type { HeroControls } from './components/HeroPitch3D';
import type { Audience } from './lib/prefs';
import { runningClock } from './lib/format';
import { GOAL, HERO_STEPS, stepDetail } from './lib/heroSequence';
import './landing.css';

const HeroPitch3D = lazy(() => import('./components/HeroPitch3D'));

function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') ?? c.getContext('webgl')); } catch { return false; }
}

const AUDIENCES: { id: Audience; label: string; line: string }[] = [
  { id: 'fan', label: 'Fan', line: 'The story' },
  { id: 'analyst', label: 'Analyst', line: 'The evidence' },
];

/** What the shared replay is doing right now, read from the snapshot the landing page prefetches anyway. */
export interface ReplayPeek { status: 'paused' | 'playing' | 'finished'; seq: number; period: 1 | 2; clockMs: number }

/** The entry label follows the replay's real state, never whether this browser visited before. */
function ctaLabel(peek: ReplayPeek | null) {
  if (!peek) return 'Enter match room';
  if (peek.status === 'finished') return 'Explore finished match';
  if (peek.seq === 0 || (peek.period === 1 && peek.clockMs === 0)) return 'Start demo';
  if (peek.status === 'playing') return 'Join the replay';
  return `Resume replay · ${runningClock(peek.period, peek.clockMs)}`;
}

/** "/" — the landing page, inside the same midnight shell as the match room. */
export default function Landing({ audience, reduced, onEnter, onAudience, peek: peekReplay }: {
  audience: Audience; reduced: boolean; onEnter: (audience: Audience) => Promise<void> | void;
  /** The choice is remembered as soon as it is made, not only on entry. */
  onAudience: (audience: Audience) => void; peek: () => Promise<ReplayPeek | null>;
}) {
  const [mode, setMode] = useState<Audience>(audience);
  const [leaving, setLeaving] = useState(false);
  const [three, setThree] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [heroState, setHeroState] = useState<'playing' | 'paused' | 'done'>('done');
  // The illustration's active step. Without the 3D view (loading, no WebGL, reduced motion) the whole sequence
  // is shown at once, so the preview describes the final step.
  const [step, setStep] = useState(HERO_STEPS.length - 1);
  const [peek, setPeek] = useState<ReplayPeek | null>(null);
  const controls = useRef<HeroControls | null>(null);
  // Only decides whether the entrance plays again; the CTA wording comes from the replay itself.
  const returning = useRef((() => { try { return localStorage.getItem('omnipitch.entered') === '1'; } catch { return false; } })());

  useEffect(() => {
    setThree(webglAvailable() ? 'loading' : 'failed');
    let alive = true;
    // Fetch the match room code and its first snapshot while the reader is here; the CTA works without it.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const run = () => { void peekReplay().then(next => { if (alive) setPeek(next); }).catch(() => undefined); };
    const id = idle ? idle(run) : window.setTimeout(run, 600);
    return () => { alive = false; if (!idle) clearTimeout(id); };
  }, [peekReplay]);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    // Hero copy steps out first (CSS, 140 ms); the pitch then carries into the match stage.
    window.setTimeout(() => { void onEnter(mode); }, reduced ? 0 : 120);
  };
  const pick = (next: Audience) => { setMode(next); onAudience(next); };
  const cta = ctaLabel(peek);
  const shownStep = three === 'ready' ? step : HERO_STEPS.length - 1;

  return <div className="landing" data-leaving={leaving || undefined} data-returning={returning.current || undefined}>
    <a className="skip-link" href="#hero-title">Skip to content</a>
    <header className="l-nav">
      <Brand />
      <nav aria-label="Landing">
        <a href="#how">How it works</a>
        <a className="l-nav-enter" href="/match" onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); enter(); } }}>
          Match room<ArrowRight size={15} aria-hidden="true" />
        </a>
      </nav>
    </header>

    <main>
      <section className="hero" aria-labelledby="hero-title">
        <StadiumMotif />
        <div className="hero-copy">
          <p className="eyebrow">Synthetic match intelligence</p>
          <h1 id="hero-title"><span>Every move.</span><span>A bigger story.</span></h1>
          <p className="hero-lede">Replay a match event by event. Rules flag the moments that matter, and each one shows its evidence.</p>
          <fieldset className="audience-pick">
            <legend>View as</legend>
            {AUDIENCES.map(item => <label key={item.id} data-checked={mode === item.id || undefined}>
              <input type="radio" name="audience" value={item.id} checked={mode === item.id} onChange={() => pick(item.id)} aria-controls="hero-preview" />
              <b>{item.label}</b><span>{item.line}</span>
            </label>)}
          </fieldset>
          <div className="hero-actions">
            <button type="button" className="l-cta" onClick={enter} aria-describedby="hero-disclosure" data-busy={leaving || undefined}>
              {cta}<ArrowRight size={18} aria-hidden="true" />
            </button>
            <a className="l-link" href="#how">How it works</a>
          </div>
          <div className="l-disclosure" id="hero-disclosure">
            <p>All teams, players and events are synthetic.</p>
            <details>
              <summary>How explanations are written</summary>
              <p>Each moment is flagged by a fixed rule. Its explanation is either written from fixed rules, labelled
                Rule-based, or drafted by an AI model and checked in code against the recorded events before it is shown,
                labelled AI · validated. Nothing comes from live feeds or player tracking.</p>
            </details>
          </div>
        </div>

        <figure className="hero-stage" aria-labelledby="hero-stage-caption">
          <div className="hero-pitch">
            {three === 'failed' && <HeroPitchFlat />}
            {three !== 'off' && three !== 'failed' && <Suspense fallback={null}>
              <HeroPitch3D reduced={reduced} controls={controls} onReady={() => setThree('ready')} onFail={() => setThree('failed')}
                onState={setHeroState} onStep={index => setStep(Math.max(0, index))} />
            </Suspense>}
            <HeroPreview mode={mode} step={shownStep} />
          </div>
          <figcaption>
            <span id="hero-stage-caption"><i aria-hidden="true" />Illustrative sequence, not match data</span>
            {three === 'ready' && !reduced && <span className="hero-ctrl">
              {heroState === 'done'
                ? <button type="button" onClick={() => controls.current?.replay()}><RotateCcw size={14} aria-hidden="true" />Replay illustration</button>
                : <button type="button" onClick={() => controls.current?.setPaused(heroState === 'playing')}>
                    {heroState === 'playing' ? <><Pause size={14} aria-hidden="true" />Pause illustration</> : <><Play size={14} aria-hidden="true" />Resume illustration</>}
                  </button>}
            </span>}
          </figcaption>
        </figure>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="how-steps">
          <li>
            <span className="how-n" aria-hidden="true">01</span>
            <h3>Follow the play</h3>
            <p>Passes, shots and tackles land on the pitch as the replay runs. Pause, scrub or jump to a moment.</p>
            <figure className="how-panel"><FollowGraphic /><figcaption>Illustrative example</figcaption></figure>
          </li>
          <li>
            <span className="how-n" aria-hidden="true">02</span>
            <h3>Understand the moment</h3>
            <p>A rule flags the moment, and the explanation says what happened and what it changed.</p>
            <figure className="how-panel"><MomentGraphic /><figcaption>Illustrative example</figcaption></figure>
          </li>
          <li>
            <span className="how-n" aria-hidden="true">03</span>
            <h3>Inspect the evidence</h3>
            <p>Step through the source actions, the values and the rule that fired, in 2D or 3D.</p>
            <figure className="how-panel"><EvidenceGraphic /><figcaption>Illustrative example</figcaption></figure>
          </li>
        </ol>
        <div className="how-end">
          <button type="button" className="l-cta" onClick={enter}>{cta}<ArrowRight size={18} aria-hidden="true" /></button>
          <span>as <b>{mode === 'fan' ? 'a Fan' : 'an Analyst'}</b>. You can switch at any time.</span>
        </div>
      </section>
    </main>
    <footer className="l-foot"><Brand /><span>Synthetic data only. No live feeds or player tracking.</span></footer>
  </div>;
}

/** What the selected audience would see for the illustration's active step: Fan gets one sentence, Analyst the
 * event and the measures computed from the illustration's own coordinates. Same sequence either way. */
function HeroPreview({ mode, step }: { mode: Audience; step: number }) {
  const current = HERO_STEPS[step];
  const detail = stepDetail(step);
  return <div className="hero-preview" id="hero-preview" data-mode={mode}>
    <div className="hero-preview-head">
      <span>{mode === 'fan' ? 'Fan view' : 'Analyst view'} · illustrative</span>
      <ol className="hero-steps" aria-label={`Step ${step + 1} of ${HERO_STEPS.length}`}>
        {HERO_STEPS.map((item, i) => <li key={item.key} data-state={i === step ? 'on' : i < step ? 'past' : 'next'} title={item.label} />)}
      </ol>
    </div>
    <div key={mode} className="hero-preview-body">
      <p className="hero-preview-step"><b>{step + 1}</b>{current.label}</p>
      {mode === 'fan'
        ? <p className="hero-preview-story">{current.story}</p>
        : <>
            <dl className="hero-preview-facts">
              {detail.rows.map(row => <div key={row.term}><dt>{row.term}</dt><dd>{row.value}</dd></div>)}
            </dl>
            <details className="hero-preview-workings">
              <summary>Coordinates and calculation</summary>
              {detail.workings.map(line => <p key={line}>{line}</p>)}
            </details>
          </>}
    </div>
  </div>;
}

/** Static pitch in the slab's pose, shown only when WebGL is unavailable or fails: the complete sequence. */
function HeroPitchFlat() {
  const path = HERO_STEPS.slice(0, -1).map(s => `${s.x} ${s.y}`).join(' ');
  const entry = HERO_STEPS[HERO_STEPS.length - 2];
  return <svg className="hero-flat" viewBox="-6 -6 117 80" aria-hidden="true">
    <rect x="-4" y="-4" width="113" height="76" rx="1.5" fill="#123b2f" />
    {Array.from({ length: 6 }, (_, i) => <rect key={i} x={i * 17.5} y="0" width="8.75" height="68" fill="#144232" />)}
    <g fill="none" stroke="#f3f1e9" strokeOpacity=".75" strokeWidth=".3">
      <rect x="0" y="0" width="105" height="68" /><path d="M52.5 0V68" /><circle cx="52.5" cy="34" r="9.15" />
      <rect x="0" y="13.84" width="16.5" height="40.32" /><rect x="88.5" y="13.84" width="16.5" height="40.32" />
    </g>
    <path d="M105 30.34v7.32" stroke="#f3f1e9" strokeWidth="1.1" />
    <path d={`M${path}`} fill="none" stroke="#ff806a" strokeWidth=".7" strokeLinecap="round" strokeLinejoin="round" />
    <path d={`M${entry.x} ${entry.y} ${GOAL.x} ${GOAL.y}`} fill="none" stroke="#ebcb70" strokeWidth=".8" strokeLinecap="round" />
    {HERO_STEPS.slice(0, -1).map(s => <circle key={s.key} cx={s.x} cy={s.y} r=".9" fill="#ff806a" />)}
    <circle cx={GOAL.x} cy={GOAL.y} r="2.3" fill="none" stroke="#ebcb70" strokeWidth=".35" />
    <circle cx={GOAL.x - .6} cy={GOAL.y} r=".95" fill="#fbfaf4" />
  </svg>;
}

/** One motif: an oversized centre circle and halfway line, cropped, behind the pitch, with a restrained blue light
 * under the slab. Static and decorative. */
function StadiumMotif() {
  return <svg className="stadium" viewBox="0 0 1360 820" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <radialGradient id="stadium-light" cx="68%" cy="48%" r="38%">
        <stop offset="0" stopColor="#7f9bff" stopOpacity=".2" />
        <stop offset=".6" stopColor="#3155e7" stopOpacity=".05" />
        <stop offset="1" stopColor="#0b1018" stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect width="1360" height="820" fill="url(#stadium-light)" />
    <g className="stadium-mark" fill="none">
      <circle cx="925" cy="400" r="380" />
      <path d="M925 -40V860" />
    </g>
  </svg>;
}

function FollowGraphic() {
  return <svg className="how-art" viewBox="0 0 320 150" aria-hidden="true">
    <rect x="0" y="0" width="320" height="104" rx="6" fill="#123b2f" />
    <g fill="none" stroke="#f3f1e9" strokeOpacity=".55" strokeWidth="1"><rect x="10" y="8" width="300" height="88" /><path d="M160 8v88" /><circle cx="160" cy="52" r="18" /></g>
    <path d="M60 70 120 40 182 58 236 34" fill="none" stroke="#ff806a" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="5 5" />
    <path d="M90 30 150 66" fill="none" stroke="#7dd8e7" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="236" cy="34" r="4.5" fill="#fbfaf4" />
    <rect x="0" y="118" width="320" height="10" rx="5" fill="#d8dee8" />
    <rect x="0" y="118" width="196" height="10" rx="5" fill="#3155e7" />
    {[34, 90, 150, 248, 286].map(x => <rect key={x} x={x} y="113" width="2.5" height="20" fill={x === 150 ? '#b8901c' : '#14201f'} />)}
    <circle cx="196" cy="123" r="8" fill="#3155e7" stroke="#f3efe5" strokeWidth="3" />
  </svg>;
}

function MomentGraphic() {
  return <svg className="how-art" viewBox="0 0 260 150" aria-hidden="true">
    <rect x="0" y="6" width="5" height="138" fill="#2fa7bb" />
    <text x="20" y="52" fontFamily="var(--display)" fontWeight="900" fontSize="40" fill="#14201f">27'</text>
    <text x="90" y="38" fontFamily="var(--sans)" fontWeight="600" fontSize="12" fill="#2443c4">TRANSITION · EXAMPLE</text>
    <text x="90" y="56" fontFamily="var(--sans)" fontSize="12" fill="#14201f">Shot soon after winning the ball</text>
    <rect x="20" y="78" width="220" height="1" fill="#14201f" opacity=".2" />
    <text x="20" y="110" fontFamily="var(--display)" fontWeight="800" fontSize="28" fill="#14201f">6.5<tspan fontSize="13" fontFamily="var(--sans)"> s</tspan></text>
    <text x="130" y="110" fontFamily="var(--display)" fontWeight="800" fontSize="28" fill="#14201f">3.7<tspan fontSize="13" fontFamily="var(--sans)"> m</tspan></text>
    <text x="20" y="130" fontFamily="var(--sans)" fontSize="11" fill="#3d4a48">Shot after regain</text>
    <text x="130" y="130" fontFamily="var(--sans)" fontSize="11" fill="#3d4a48">Forward progression</text>
  </svg>;
}

function EvidenceGraphic() {
  return <svg className="how-art" viewBox="0 0 260 150" aria-hidden="true">
    {[0, 1, 2].map(i => <g key={i}>
      {i < 2 && <rect x="17" y={30 + i * 40} width="2" height="26" fill="#14201f" opacity=".3" />}
      <circle cx="18" cy={20 + i * 40} r="13" fill={i === 1 ? '#3155e7' : '#f3efe5'} stroke="#3155e7" strokeWidth="2" />
      <text x="18" y={25 + i * 40} textAnchor="middle" fontFamily="var(--display)" fontWeight="800" fontSize="15" fill={i === 1 ? '#f3efe5' : '#14201f'}>{i + 1}</text>
      <text x="42" y={25 + i * 40} fontFamily="var(--sans)" fontWeight={i === 1 ? 600 : 400} fontSize="13" fill="#14201f">{['Interception', 'Pass · 27 m', 'Shot saved'][i]}</text>
    </g>)}
    <rect x="150" y="6" width="110" height="128" rx="6" fill="#121b27" />
    {['event', 'action', 'from', 'to'].map((k, i) => <g key={k}>
      <text x="162" y={32 + i * 28} fontFamily="var(--mono)" fontSize="10" fill="#8f9cb0">{k}</text>
      <rect x="204" y={24 + i * 28} width={[44, 34, 40, 40][i]} height="8" rx="2" fill="#f3f1e9" opacity=".7" />
    </g>)}
  </svg>;
}
