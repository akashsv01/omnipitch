import { useEffect, useRef } from 'react';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, Float32BufferAttribute, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera,
  PlaneGeometry, RingGeometry, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';
import { HERO_STEPS as STEPS } from '../lib/heroSequence';

/** Landing hero: a shallow pitch slab with one ILLUSTRATIVE sequence (not match data). The slab settles, then the
 * four actions play one at a time: each becomes the active step with its label, earlier steps shrink to numbered
 * markers, and the shot ends in the goal mouth. Then it stops. One renderer, rendered only while something
 * changes, paused when hidden or off screen, disposed on unmount. */
export interface HeroControls { replay: () => void; setPaused: (paused: boolean) => void }

const TONE = { harbor: '#ff806a', shot: '#ebcb70' };
const tone = (index: number) => index === STEPS.length - 1 ? TONE.shot : TONE.harbor;
const TOP = 1.25;
const at = (x: number, y: number, lift = 0) => new Vector3(x - 52.5, TOP + lift, y - 34);
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
// Timeline (ms): settle, then one step per SEGMENT (the path into a step grows during the last GROW ms before it
// becomes active), then the shot's highlight. Slow enough to read each label once.
const SETTLE = 650, SEGMENT = 1000, GROW = 420, HIGHLIGHT = 520;
const stepAt = (index: number) => SETTLE + index * SEGMENT;
const END = stepAt(STEPS.length - 1) + HIGHLIGHT;
const activeAt = (elapsed: number) => elapsed < SETTLE - 120 ? -1 : Math.min(STEPS.length - 1, Math.floor((elapsed - SETTLE) / SEGMENT + 1e-6));

export default function HeroPitch3D({ reduced, onReady, onFail, onState, onStep, controls }: {
  reduced: boolean; onReady: () => void; onFail: () => void; onState: (state: 'playing' | 'paused' | 'done') => void;
  /** The active step changed (-1 before the first). */
  onStep: (index: number) => void;
  controls: React.MutableRefObject<HeroControls | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const cb = useRef({ onReady, onFail, onState, onStep });
  cb.current = { onReady, onFail, onState, onStep };

  useEffect(() => {
    const el = host.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch { cb.current.onFail(); return; }
    renderer.setPixelRatio(Math.min(1.5, Math.max(1, window.devicePixelRatio || 1)));
    renderer.setClearColor(new Color('#000000'), 0);
    el.prepend(renderer.domElement);
    const canvas = renderer.domElement;
    const onLost = (event: { preventDefault: () => void }) => { event.preventDefault(); cb.current.onFail(); };
    canvas.addEventListener('webglcontextlost', onLost);

    const scene = new Scene();
    const camera = new PerspectiveCamera(28, 1, 1, 600);
    const bag: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(item: T) => { bag.push(item); return item; };

    // Restrained directional lighting: a warm key from the upper left, a cool fill from behind (the stadium light
    // in the page background), and a low hemisphere so the slab's sides read as depth, not as black.
    scene.add(new HemisphereLight('#dfe6ff', '#0b1018', 1.2));
    const key = new DirectionalLight('#fff4e0', 1.25);
    key.position.set(-60, 110, 40);
    scene.add(key);
    const rim = new DirectionalLight('#8aa2ff', .45);
    rim.position.set(40, 30, -80);
    scene.add(rim);

    // Soft contact shadow: a radial gradient texture just under the slab, tighter and darker at its centre.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const g = shadowCanvas.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(2,5,10,.72)'); grad.addColorStop(.55, 'rgba(2,5,10,.34)'); grad.addColorStop(1, 'rgba(2,5,10,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const shadow = new Mesh(keep(new PlaneGeometry(136, 94)), keep(new MeshBasicMaterial({ map: keep(new CanvasTexture(shadowCanvas)), transparent: true, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -4.5;
    scene.add(shadow);

    // The slab: the match room's turf tokens, restrained mowing bands, fine warm-white markings.
    const slab = new Group();
    scene.add(slab);
    const side = keep(new MeshLambertMaterial({ color: '#0b2a21' }));
    const top = keep(new MeshLambertMaterial({ color: '#123b2f' }));
    slab.add(new Mesh(keep(new BoxGeometry(113, 2.5, 76)), [side, side, top, side, side, side]));
    const band = keep(new MeshLambertMaterial({ color: '#144232' }));
    for (let i = 0; i < 12; i += 2) {
      const stripe = new Mesh(keep(new PlaneGeometry(8.75, 68)), band);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(i * 8.75 + 4.375 - 52.5, TOP + .01, 0);
      slab.add(stripe);
    }
    const seg: number[] = [];
    const add = (ax: number, ay: number, bx: number, by: number) => { const a = at(ax, ay, .03), b = at(bx, by, .03); seg.push(a.x, a.y, a.z, b.x, b.y, b.z); };
    const rect = (x: number, y: number, w: number, h: number) => { add(x, y, x + w, y); add(x + w, y, x + w, y + h); add(x + w, y + h, x, y + h); add(x, y + h, x, y); };
    rect(0, 0, 105, 68); add(52.5, 0, 52.5, 68);
    rect(0, 13.84, 16.5, 40.32); rect(88.5, 13.84, 16.5, 40.32); rect(0, 24.84, 5.5, 18.32); rect(99.5, 24.84, 5.5, 18.32);
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2, b = (i + 1) / 64 * Math.PI * 2;
      add(52.5 + Math.cos(a) * 9.15, 34 + Math.sin(a) * 9.15, 52.5 + Math.cos(b) * 9.15, 34 + Math.sin(b) * 9.15);
    }
    const lines = keep(new BufferGeometry());
    lines.setAttribute('position', new Float32BufferAttribute(seg, 3));
    slab.add(new LineSegments(lines, keep(new LineBasicMaterial({ color: '#f3efe5', transparent: true, opacity: .78 }))));

    // The attacked goal: two posts and a bar at real size (7.32 x 2.44 m), so the shot has a legible destination.
    const frame = keep(new MeshLambertMaterial({ color: '#f3f1e9' }));
    const post = keep(new BoxGeometry(.6, 2.44, .6));
    [30.34, 37.66].forEach(y => { const m = new Mesh(post, frame); m.position.copy(at(105.2, y, 1.22)); slab.add(m); });
    const bar = new Mesh(keep(new BoxGeometry(.6, .6, 7.92)), frame);
    bar.position.copy(at(105.2, 34, 2.44));
    slab.add(bar);

    // Paths as flat ribbons on the turf (WebGL line width is fixed at 1px); each grows from its start point.
    const ribbons = STEPS.slice(0, -1).map((step, i) => {
      const a = at(step.x, step.y, .06), b = at(STEPS[i + 1].x, STEPS[i + 1].y, .06);
      const length = a.distanceTo(b);
      const geometry = keep(new PlaneGeometry(1, i === STEPS.length - 2 ? .8 : .6));
      geometry.translate(.5, 0, 0);
      const material = keep(new MeshBasicMaterial({ color: tone(i + 1), transparent: true, opacity: 1 }));
      const mesh = new Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x);
      mesh.position.copy(a);
      mesh.scale.set(.0001, 1, 1);
      slab.add(mesh);
      return { mesh, material, length, a, b };
    });
    const markers = STEPS.map((step, i) => {
      const material = keep(new MeshBasicMaterial({ color: tone(i), transparent: true, opacity: 0 }));
      const dot = new Mesh(keep(new CircleGeometry(1.15, 28)), material);
      dot.rotation.x = -Math.PI / 2;
      dot.position.copy(at(step.x, step.y, .08));
      slab.add(dot);
      return material;
    });
    // The active step's halo; it moves to whichever step is active.
    const haloMaterial = keep(new MeshBasicMaterial({ color: '#f3f1e9', transparent: true, opacity: 0, depthWrite: false }));
    const halo = new Mesh(keep(new RingGeometry(2.2, 2.9, 40)), haloMaterial);
    halo.rotation.x = -Math.PI / 2;
    slab.add(halo);
    const ball = new Mesh(keep(new SphereGeometry(.95, 20, 14)), keep(new MeshLambertMaterial({ color: '#fbfaf4' })));
    slab.add(ball);

    let elapsed = reduced ? END : 0;
    let paused = false, visible = !document.hidden, onscreen = true, raf = 0, last = 0, shown = -2;
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

    const pose = () => {
      const s = ease(elapsed / SETTLE);
      slab.position.y = (1 - s) * 7;
      // A slight resting yaw gives the slab an editorial angle; it settles into it from a flatter pose.
      slab.rotation.x = (1 - s) * -.12 + tilt.y;
      slab.rotation.y = -.2 + (1 - s) * .08 + tilt.x;
      shadow.rotation.z = slab.rotation.y;
      (shadow.material as MeshBasicMaterial).opacity = .35 + .65 * s;
      const active = activeAt(elapsed);
      ribbons.forEach((r, i) => {
        const t = ease((elapsed - (stepAt(i + 1) - GROW)) / GROW);
        r.mesh.scale.x = Math.max(.0001, r.length * t);
        // Paths into earlier steps recede so the active one leads.
        r.material.opacity = i + 1 === active ? 1 : .5;
      });
      markers.forEach((m, i) => { m.opacity = i > active ? 0 : i === active ? 1 : .6; });
      // The ball waits at the active step, then rides the next path while it grows.
      let ballAt = at(STEPS[0].x, STEPS[0].y, .95);
      ribbons.forEach((r, i) => {
        const t = ease((elapsed - (stepAt(i + 1) - GROW)) / GROW);
        if (t > 0) ballAt = r.a.clone().lerp(r.b, t).setY(TOP + .95);
      });
      // The shot rises to the bar's height at the goal mouth, so it reads as a shot, not a pass.
      const shotT = ease((elapsed - (stepAt(STEPS.length - 1) - GROW)) / GROW);
      if (shotT > 0) ballAt.setY(TOP + .95 + Math.sin(shotT * Math.PI / 2) * .9);
      ball.position.copy(ballAt);
      if (active >= 0) {
        const step = STEPS[active];
        halo.position.copy(at(step.x, step.y, .09));
        const h = active === STEPS.length - 1 ? ease((elapsed - stepAt(active)) / HIGHLIGHT) : 1;
        haloMaterial.opacity = .9 - (active === STEPS.length - 1 ? .25 * h : 0);
        halo.scale.setScalar(active === STEPS.length - 1 ? .7 + .3 * h : .85);
        halo.material.color.set(active === STEPS.length - 1 ? TONE.shot : '#f3f1e9');
      } else haloMaterial.opacity = 0;
      return active;
    };

    const render = () => {
      const active = pose();
      renderer.render(scene, camera);
      if (active !== shown) { shown = active; cb.current.onStep(active); }
      // Labels: one full label for the active step, numbered markers for earlier steps, nothing for later ones.
      // Markers sit on their points; the active label sits above its point unless it would cover a marker or
      // leave the frame, in which case it goes below. Both are clamped inside the frame.
      const box = el.getBoundingClientRect();
      const nodes = labels.current?.children;
      if (!nodes) return;
      const points = STEPS.map(step => {
        const p = at(step.x, step.y, .2).applyMatrix4(slab.matrixWorld).project(camera);
        return { x: ((p.x + 1) / 2) * box.width, y: ((1 - p.y) / 2) * box.height };
      });
      const markersOn: { x: number; y: number }[] = [];
      STEPS.forEach((_, i) => {
        const node = nodes[i] as HTMLElement;
        node.dataset.state = i === active ? 'on' : i < active ? 'past' : 'next';
        if (i < active) { markersOn.push(points[i]); node.style.transform = `translate(${points[i].x}px, ${points[i].y}px) translate(-50%, -50%)`; }
      });
      if (active >= 0) {
        const node = nodes[active] as HTMLElement;
        const w = node.offsetWidth, h = node.offsetHeight, p = points[active];
        const x = Math.min(box.width - w / 2 - 6, Math.max(w / 2 + 6, p.x));
        const covers = (top: number) => markersOn.some(m => Math.abs(m.x - x) < w / 2 + 12 && m.y > top - 12 && m.y < top + h + 12);
        let top = p.y - h - 16;
        if (top < 6 || covers(top)) top = p.y + 16;
        if (top + h > box.height - 6 || covers(top)) top = Math.max(6, p.y - h - 16);
        node.style.transform = `translate(${x}px, ${top}px) translateX(-50%)`;
      }
    };

    const settled = () => elapsed >= END && Math.abs(tilt.x - tilt.tx) < .0005 && Math.abs(tilt.y - tilt.ty) < .0005;
    const loop = (now: number) => {
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (!paused) elapsed = Math.min(END, elapsed + dt);
      tilt.x += (tilt.tx - tilt.x) * .12;
      tilt.y += (tilt.ty - tilt.y) * .12;
      render();
      if (!settled() && !(paused && Math.abs(tilt.x - tilt.tx) < .0005) && visible && onscreen) raf = requestAnimationFrame(loop);
      else { raf = 0; last = 0; if (elapsed >= END) cb.current.onState('done'); }
    };
    const kick = () => { if (!raf && visible && onscreen) raf = requestAnimationFrame(loop); };

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // Keep the whole slab in frame on narrow screens by pulling the camera back.
      const distance = camera.aspect < 1.2 ? 285 : 222;
      camera.position.set(0, distance * .66, distance * .75);
      camera.lookAt(0, -6, 4);
      camera.updateProjectionMatrix();
      render();
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(el);
    const seen = new IntersectionObserver(([entry]) => { onscreen = entry.isIntersecting; if (onscreen) kick(); });
    seen.observe(el);
    const onVisibility = () => { visible = !document.hidden; if (visible) kick(); };
    document.addEventListener('visibilitychange', onVisibility);
    // Restrained pointer response: fine pointers only, never under reduced motion.
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches && !reduced;
    const onMove = (event: PointerEvent) => {
      const box = el.getBoundingClientRect();
      tilt.tx = ((event.clientX - box.left) / box.width - .5) * .07;
      tilt.ty = ((event.clientY - box.top) / box.height - .5) * .04;
      kick();
    };
    const onLeave = () => { tilt.tx = 0; tilt.ty = 0; kick(); };
    if (fine) { el.addEventListener('pointermove', onMove); el.addEventListener('pointerleave', onLeave); }

    resize();
    cb.current.onReady();
    cb.current.onState(reduced ? 'done' : 'playing');
    kick();
    controls.current = {
      replay: () => { elapsed = 0; paused = false; cb.current.onState('playing'); kick(); },
      setPaused: next => { paused = next; cb.current.onState(next ? 'paused' : elapsed >= END ? 'done' : 'playing'); if (!next) kick(); },
    };

    return () => {
      controls.current = null;
      cancelAnimationFrame(raf);
      sizes.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      bag.forEach(item => item.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [reduced, controls]);

  return <div className="hero3d" ref={host}>
    <div className="hero3d-labels" ref={labels} aria-hidden="true">
      {STEPS.map((step, i) => <span key={step.key} data-state="next" style={{ ['--tone' as string]: tone(i) }}><b>{i + 1}</b><em>{step.label}</em></span>)}
    </div>
  </div>;
}
