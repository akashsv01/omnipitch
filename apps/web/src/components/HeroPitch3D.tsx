import { useEffect, useRef } from 'react';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, Float32BufferAttribute, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera,
  PlaneGeometry, RingGeometry, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';

/** Landing hero: a shallow floating pitch slab with one ILLUSTRATIVE sequence (not match data):
 * the slab settles, the path reveals, the ball moves, the final action is highlighted, then it stops.
 * One renderer, rendered only while something changes, paused when hidden or off screen, disposed on unmount. */
export interface HeroControls { replay: () => void; setPaused: (paused: boolean) => void }

// Pitch metres (105 x 68, x right, y down). The scene centres the pitch on the origin.
const STEPS = [
  { x: 36, y: 47, label: 'Ball won', tone: '#ff806a' },
  { x: 60, y: 29, label: 'Forward pass', tone: '#ff806a' },
  { x: 83, y: 41, label: 'Into the box', tone: '#ff806a' },
  { x: 103.2, y: 35.5, label: 'Shot on target', tone: '#f2cc62' },
];
const TOP = 1.25;
const at = (x: number, y: number, lift = 0) => new Vector3(x - 52.5, TOP + lift, y - 34);
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
// Timeline (ms): settle, then one segment after another, then the highlight.
const SETTLE = 650, SEGMENT = 420, HIGHLIGHT = 520;
const END = SETTLE + SEGMENT * (STEPS.length - 1) + HIGHLIGHT;

export default function HeroPitch3D({ reduced, onReady, onFail, onState, controls }: {
  reduced: boolean; onReady: () => void; onFail: () => void; onState: (state: 'playing' | 'paused' | 'done') => void;
  controls: React.MutableRefObject<HeroControls | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const cb = useRef({ onReady, onFail, onState });
  cb.current = { onReady, onFail, onState };

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

    scene.add(new HemisphereLight('#fff6e6', '#203a33', 1.6));
    const sun = new DirectionalLight('#ffffff', 1.1);
    sun.position.set(-30, 90, 50);
    scene.add(sun);

    // Cheap contact shadow: a small radial gradient texture on a plane under the slab.
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const g = shadowCanvas.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(20,32,31,.42)'); grad.addColorStop(.6, 'rgba(20,32,31,.16)'); grad.addColorStop(1, 'rgba(20,32,31,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const shadow = new Mesh(keep(new PlaneGeometry(150, 104)), keep(new MeshBasicMaterial({ map: keep(new CanvasTexture(shadowCanvas)), transparent: true, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -7;
    scene.add(shadow);

    // The slab: forest top, darker sides, restrained mowing bands, fine warm-white markings.
    const slab = new Group();
    scene.add(slab);
    const side = keep(new MeshLambertMaterial({ color: '#0f2a21' }));
    const top = keep(new MeshLambertMaterial({ color: '#1b3f31' }));
    slab.add(new Mesh(keep(new BoxGeometry(113, 2.5, 76)), [side, side, top, side, side, side]));
    const band = keep(new MeshLambertMaterial({ color: '#1f4637' }));
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

    // Paths as flat ribbons on the turf (WebGL line width is fixed at 1px); each grows from its start point.
    const ribbons = STEPS.slice(0, -1).map((step, i) => {
      const a = at(step.x, step.y, .06), b = at(STEPS[i + 1].x, STEPS[i + 1].y, .06);
      const length = a.distanceTo(b);
      const geometry = keep(new PlaneGeometry(1, i === STEPS.length - 2 ? .75 : .6));
      geometry.translate(.5, 0, 0);
      const mesh = new Mesh(geometry, keep(new MeshBasicMaterial({ color: STEPS[i + 1].tone })));
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x);
      mesh.position.copy(a);
      mesh.scale.set(.0001, 1, 1);
      slab.add(mesh);
      return { mesh, length, a, b };
    });
    const markers = STEPS.map(step => {
      const dot = new Mesh(keep(new CircleGeometry(1.15, 28)), keep(new MeshBasicMaterial({ color: step.tone, transparent: true, opacity: 0 })));
      dot.rotation.x = -Math.PI / 2;
      dot.position.copy(at(step.x, step.y, .08));
      slab.add(dot);
      return dot;
    });
    const ringMaterial = keep(new MeshBasicMaterial({ color: '#f2cc62', transparent: true, opacity: 0 }));
    const ring = new Mesh(keep(new RingGeometry(2.1, 2.55, 40)), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(at(STEPS[2].x, STEPS[2].y, .09));
    slab.add(ring);
    const ball = new Mesh(keep(new SphereGeometry(.95, 20, 14)), keep(new MeshLambertMaterial({ color: '#fbfaf4' })));
    ball.position.copy(at(STEPS[0].x, STEPS[0].y, .95));
    slab.add(ball);

    let elapsed = reduced ? END : 0;
    let paused = false, visible = !document.hidden, onscreen = true, frame = 0, last = 0;
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

    const pose = () => {
      const s = ease(elapsed / SETTLE);
      slab.position.y = (1 - s) * 7;
      // A slight resting yaw gives the slab an editorial angle; it settles into it from a flatter pose.
      slab.rotation.x = (1 - s) * -.12 + tilt.y;
      slab.rotation.y = -.2 + (1 - s) * .08 + tilt.x;
      shadow.rotation.z = slab.rotation.y;
      shadow.material.opacity = .35 + .65 * s;
      ribbons.forEach((r, i) => {
        const t = ease((elapsed - SETTLE - i * SEGMENT) / SEGMENT);
        r.mesh.scale.x = Math.max(.0001, r.length * t);
      });
      markers.forEach((m, i) => { (m.material as MeshBasicMaterial).opacity = ease((elapsed - SETTLE - (i - .4) * SEGMENT) / 200); });
      // The ball rides the revealed path, only along recorded segment ends of this illustration.
      const progress = Math.min(ribbons.length, Math.max(0, (elapsed - SETTLE) / SEGMENT));
      const index = Math.min(ribbons.length - 1, Math.floor(progress));
      const r = ribbons[index];
      ball.position.copy(r.a.clone().lerp(r.b, ease(progress - index))).setY(TOP + .95);
      const h = (elapsed - SETTLE - ribbons.length * SEGMENT) / HIGHLIGHT;
      ringMaterial.opacity = h <= 0 ? 0 : 1 - .45 * ease(h);
      ring.scale.setScalar(h <= 0 ? .6 : .6 + .4 * ease(h));
    };

    const render = () => {
      pose();
      renderer.render(scene, camera);
      const box = el.getBoundingClientRect();
      const nodes = labels.current?.children;
      STEPS.forEach((step, i) => {
        const node = nodes?.[i] as HTMLElement | undefined;
        if (!node) return;
        const p = at(step.x, step.y, 1.2).applyMatrix4(slab.matrixWorld).project(camera);
        // Neighbouring labels alternate above and below their points so the last two never collide.
        node.style.transform = `translate(${((p.x + 1) / 2) * box.width}px, ${((1 - p.y) / 2) * box.height}px) translate(-50%, ${i === STEPS.length - 1 ? '45%' : '-135%'})`;
        node.style.opacity = String(ease((elapsed - SETTLE - (i - .2) * SEGMENT) / 220));
      });
    };

    const settled = () => elapsed >= END && Math.abs(tilt.x - tilt.tx) < .0005 && Math.abs(tilt.y - tilt.ty) < .0005;
    const loop = (now: number) => {
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (!paused) elapsed = Math.min(END, elapsed + dt);
      tilt.x += (tilt.tx - tilt.x) * .12;
      tilt.y += (tilt.ty - tilt.y) * .12;
      render();
      if (!settled() && !(paused && Math.abs(tilt.x - tilt.tx) < .0005) && visible && onscreen) frame = requestAnimationFrame(loop);
      else { frame = 0; last = 0; if (elapsed >= END) cb.current.onState('done'); }
    };
    const kick = () => { if (!frame && visible && onscreen) frame = requestAnimationFrame(loop); };

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
      cancelAnimationFrame(frame);
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
      {STEPS.map((step, i) => <span key={step.label} style={{ ['--tone' as string]: step.tone }}><b>{i + 1}</b>{step.label}</span>)}
    </div>
  </div>;
}
