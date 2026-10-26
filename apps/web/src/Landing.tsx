import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ArrowRight, Pause, Play, RotateCcw } from 'lucide-react';
import { Brand } from './components/Crest';
import type { HeroControls } from './components/HeroPitch3D';
import type { Audience } from './lib/prefs';
import './landing.css';

const HeroPitch3D = lazy(() => import('./components/HeroPitch3D'));

function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') ?? c.getContext('webgl')); } catch { return false; }
}

const AUDIENCES: { id: Audience; label: string; line: string }[] = [
  { id: 'fan', label: 'Fan', line: 'Follow the story' },
  { id: 'analyst', label: 'Analyst', line: 'Explore the evidence' },
];

/** "/" — the landing page. Warm and editorial, deliberately unlike the dark match room it leads into. */
export default function Landing({ audience, reduced, onEnter, prefetch }: {
  audience: Audience; reduced: boolean; onEnter: (audience: Audience) => Promise<void> | void; prefetch: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<Audience>(audience);
  const [leaving, setLeaving] = useState(false);
  const [three, setThree] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [heroState, setHeroState] = useState<'playing' | 'paused' | 'done'>('done');
  const controls = useRef<HeroControls | null>(null);
  const returning = useRef((() => { try { return localStorage.getItem('omnipitch.entered') === '1'; } catch { return false; } })());

  useEffect(() => {
    setThree(webglAvailable() ? 'loading' : 'failed');
    // Fetch the match room while the reader is here, so entering does not wait on the network.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const id = idle ? idle(() => void prefetch()) : window.setTimeout(() => void prefetch(), 1200);
    return () => { if (!idle) clearTimeout(id); };
  }, [prefetch]);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    // Hero copy steps out first (CSS, 160 ms); the pitch then carries into the match stage.
    window.setTimeout(() => { void onEnter(mode); }, reduced ? 0 : 140);
  };

  return <div className="landing" data-leaving={leaving || undefined} data-returning={returning.current || undefined}>
    <a className="skip-link" href="#hero-title">Skip to content</a>
    <header className="l-nav">
      <Brand />
      <nav aria-label="Landing">
        <a href="#how">How it works</a>
        <a className="l-nav-enter" href="/match" onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); enter(); } }}>
          {returning.current ? <><span className="long">Back to the match room</span><span className="short">Match room</span></> : 'Match room'}<ArrowRight size={15} aria-hidden="true" />
        </a>
      </nav>
    </header>

    <main>
      <section className="hero" aria-labelledby="hero-title">
        <InkMotif />
        <div className="hero-copy">
          <p className="eyebrow">Football, seen differently · Synthetic match intelligence</p>
          <h1 id="hero-title"><span>Every move.</span><span>A bigger story.</span></h1>
          <p className="hero-lede">Explore the match. Follow the moments. See the evidence.</p>
          <p className="hero-body">OmniPitch replays a synthetic 90-minute match event by event. Transparent rules flag goals, chances,
            quick breaks and pressing spells, and each one comes with the passes, distances and calculations that triggered it.</p>
          <fieldset className="audience-pick">
            <legend>Enter as</legend>
            {AUDIENCES.map(item => <label key={item.id} data-checked={mode === item.id || undefined}>
              <input type="radio" name="audience" value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} />
              <b>{item.label}</b><span>{item.line}</span>
            </label>)}
          </fieldset>
          <div className="hero-actions">
            <button type="button" className="l-cta" onClick={enter} aria-describedby="hero-disclosure">
              {returning.current ? 'Resume match' : 'Enter match room'}<ArrowRight size={18} aria-hidden="true" />
            </button>
            <a className="l-link" href="#how">See how it works</a>
          </div>
          <p className="l-disclosure" id="hero-disclosure">Synthetic data: every team, player and event is generated. Moments come from
            deterministic rules; their stories are templates, or AI text that is checked in code and labelled as such.</p>
        </div>

        <figure className="hero-stage" aria-label="Illustrative tactical pitch">
          <div className="hero-pitch">
            {three === 'failed' && <HeroPitchFlat />}
            {three !== 'off' && three !== 'failed' && <Suspense fallback={null}>
              <HeroPitch3D reduced={reduced} controls={controls} onReady={() => setThree('ready')} onFail={() => setThree('failed')}
                onState={setHeroState} />
            </Suspense>}
          </div>
          <figcaption>
            <span><i aria-hidden="true" />Illustrative sequence, not match data</span>
            {three === 'ready' && !reduced && <span className="hero-ctrl">
              {heroState === 'done'
                ? <button type="button" onClick={() => controls.current?.replay()}><RotateCcw size={14} aria-hidden="true" />Replay</button>
                : <button type="button" onClick={() => controls.current?.setPaused(heroState === 'playing')}>
                    {heroState === 'playing' ? <><Pause size={14} aria-hidden="true" />Pause</> : <><Play size={14} aria-hidden="true" />Resume</>}
                  </button>}
            </span>}
          </figcaption>
        </figure>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="how-steps">
          <li className="how-1">
            <span className="how-n" aria-hidden="true">01</span>
            <div><h3>Follow the play</h3><p>Every recorded pass, shot and tackle lands on the simulated pitch as it happens. A filmstrip lets you pause, scrub and jump between key moments.</p></div>
            <FollowGraphic /><span className="how-note">Illustrative example</span>
          </li>
          <li className="how-2">
            <span className="how-n" aria-hidden="true">02</span>
            <div><h3>Understand the moment</h3><p>When the events meet a rule, the moment is flagged and explained: what happened and what it changed, in plain words.</p></div>
            <MomentGraphic /><span className="how-note">Illustrative example</span>
          </li>
          <li className="how-3">
            <span className="how-n" aria-hidden="true">03</span>
            <div><h3>Inspect the evidence</h3><p>Open any moment to step through its source actions, the values and the rule that fired, and its limits.</p></div>
            <EvidenceGraphic /><span className="how-note">Illustrative example</span>
          </li>
        </ol>
        <div className="how-end">
          <button type="button" className="l-cta" onClick={enter}>{returning.current ? 'Resume match' : 'Enter match room'}<ArrowRight size={18} aria-hidden="true" /></button>
          <span>as <b>{mode === 'fan' ? 'a Fan' : 'an Analyst'}</b>. You can switch at any time.</span>
        </div>
      </section>
    </main>
    <footer className="l-foot"><Brand /><span>All teams, players and events are synthetic. No live feeds or player tracking are used.</span></footer>
  </div>;
}

/** Static pitch in the slab's pose, shown only when WebGL is unavailable or fails. It is never layered
 * under the 3D slab, so the entrance shows exactly one pitch. */
function HeroPitchFlat() {
  return <svg className="hero-flat" viewBox="-6 -6 117 80" aria-hidden="true">
    <rect x="-4" y="-4" width="113" height="76" rx="1.5" fill="#1b3f31" />
    {Array.from({ length: 6 }, (_, i) => <rect key={i} x={i * 17.5} y="0" width="8.75" height="68" fill="#1f4637" />)}
    <g fill="none" stroke="#f3efe5" strokeOpacity=".78" strokeWidth=".3">
      <rect x="0" y="0" width="105" height="68" /><path d="M52.5 0V68" /><circle cx="52.5" cy="34" r="9.15" />
      <rect x="0" y="13.84" width="16.5" height="40.32" /><rect x="88.5" y="13.84" width="16.5" height="40.32" />
    </g>
    <path d="M36 47 60 29 83 41" fill="none" stroke="#ff806a" strokeWidth=".7" strokeLinecap="round" />
    <path d="M83 41 103.2 35.5" fill="none" stroke="#f2cc62" strokeWidth=".8" strokeLinecap="round" />
    <circle cx="83" cy="41" r="2.3" fill="none" stroke="#f2cc62" strokeWidth=".35" />
    <circle cx="103.2" cy="35.5" r=".95" fill="#fbfaf4" />
  </svg>;
}

/** "Tactical ink": faint oversized pitch geometry off the edges, and one cobalt route from the headline to the
 * slab ending in a coral selected-action dot. Static SVG; the route draws once on first visit, then rests. */
function InkMotif() {
  return <svg className="ink" viewBox="0 0 1360 820" preserveAspectRatio="none" aria-hidden="true">
    <g className="ink-pitch" fill="none">
      <rect x="700" y="120" width="1000" height="880" rx="6" />
      <circle cx="1200" cy="560" r="150" />
    </g>
    <path className="ink-route" d="M600 205 C 680 205, 690 290, 745 340" fill="none" pathLength="1" />
    <circle className="ink-dot" cx="748" cy="343" r="6" />
  </svg>;
}

function FollowGraphic() {
  return <svg className="how-art" viewBox="0 0 320 150" aria-hidden="true">
    <rect x="0" y="0" width="320" height="104" rx="6" fill="#14201f" />
    <g fill="none" stroke="#f3efe5" strokeOpacity=".5" strokeWidth="1"><rect x="10" y="8" width="300" height="88" /><path d="M160 8v88" /><circle cx="160" cy="52" r="18" /></g>
    <path d="M60 70 120 40 182 58 236 34" fill="none" stroke="#ff806a" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="5 5" />
    <path d="M90 30 150 66" fill="none" stroke="#7dd8e7" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="236" cy="34" r="4.5" fill="#fbfaf4" />
    <rect x="0" y="118" width="320" height="10" rx="5" fill="#dce8f1" />
    <rect x="0" y="118" width="196" height="10" rx="5" fill="#3155e7" />
    {[34, 90, 150, 248, 286].map(x => <rect key={x} x={x} y="113" width="2.5" height="20" fill={x === 150 ? '#f2cc62' : '#14201f'} />)}
    <circle cx="196" cy="123" r="8" fill="#3155e7" stroke="#f3efe5" strokeWidth="3" />
  </svg>;
}

function MomentGraphic() {
  return <svg className="how-art" viewBox="0 0 260 150" aria-hidden="true">
    <rect x="0" y="6" width="260" height="138" rx="6" fill="#dce8f1" />
    <rect x="0" y="6" width="5" height="138" fill="#7dd8e7" />
    <text x="22" y="52" fontFamily="var(--display)" fontWeight="900" fontSize="40" fill="#14201f">27'</text>
    <text x="92" y="38" fontFamily="var(--sans)" fontWeight="600" fontSize="12" fill="#3155e7">TRANSITION · EXAMPLE</text>
    <text x="92" y="56" fontFamily="var(--sans)" fontSize="12" fill="#14201f">Shot soon after winning the ball</text>
    <rect x="22" y="78" width="216" height="1" fill="#14201f" opacity=".2" />
    <text x="22" y="110" fontFamily="var(--display)" fontWeight="800" fontSize="28" fill="#14201f">6.5<tspan fontSize="13" fontFamily="var(--sans)"> s</tspan></text>
    <text x="132" y="110" fontFamily="var(--display)" fontWeight="800" fontSize="28" fill="#14201f">3.7<tspan fontSize="13" fontFamily="var(--sans)"> m</tspan></text>
    <text x="22" y="130" fontFamily="var(--sans)" fontSize="11" fill="#44514f">Shot after regain</text>
    <text x="132" y="130" fontFamily="var(--sans)" fontSize="11" fill="#44514f">Forward progression</text>
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
    <rect x="150" y="6" width="110" height="128" rx="6" fill="#14201f" />
    {['event', 'action', 'from', 'to'].map((k, i) => <g key={k}>
      <text x="162" y={32 + i * 28} fontFamily="var(--mono)" fontSize="10" fill="#8aa29b">{k}</text>
      <rect x="204" y={24 + i * 28} width={[44, 34, 40, 40][i]} height="8" rx="2" fill="#f3efe5" opacity=".7" />
    </g>)}
  </svg>;
}
