import { useEffect, useRef } from 'react';
import {
  BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry, Color, DirectionalLight, Float32BufferAttribute, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera,
  PlaneGeometry, RingGeometry, Scene, SphereGeometry, Vector3, WebGLRenderer,
} from 'three';
import type { Event } from '../types/contracts';

/** Tactical replay in 3D, loaded only when someone asks for it. It draws exactly what the 2D view draws:
 * recorded start and end points on the ground plane, joined by straight lines. No players, formations or
 * ball height are invented; the ball marker sits on the turf. One renderer per mount, rendered on demand,
 * paused while the tab is hidden or the view is off screen, and fully disposed on unmount. */
export type CameraMode = 'broadcast' | 'overhead';

const TONE: Record<string, string> = { harbor: '#d29a8c', vale: '#9bbcc2', shot: '#cdbb92' };
const toWorld = (x: number, y: number, lift = 0) => new Vector3(x - 52.5, lift, y - 34);

export default function Tactical3D({ steps, active, camera, reduced, onFallback }: {
  steps: Event[]; active: number; camera: CameraMode; reduced: boolean; onFallback: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const api = useRef<{ setActive: (index: number) => void; setCamera: (mode: CameraMode) => void } | null>(null);
  const fallback = useRef(onFallback);
  fallback.current = onFallback;

  useEffect(() => {
    const el = host.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    } catch {
      fallback.current('WebGL could not start in this browser.');
      return;
    }
    renderer.setPixelRatio(Math.min(1.5, Math.max(1, window.devicePixelRatio || 1)));
    renderer.setClearColor(new Color('#0b1018'));
    el.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    const onLost = (event: { preventDefault: () => void }) => { event.preventDefault(); fallback.current('The 3D view lost its graphics context.'); };
    canvas.addEventListener('webglcontextlost', onLost);

    const scene = new Scene();
    const cam = new PerspectiveCamera(34, 1, 1, 600);
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item; };

    // A shallow slab (105 x 68 m field, 4 m margin) with simple lighting and a cheap contact shadow:
    // a tiny radial-gradient texture under the slab instead of a shadow map.
    scene.add(new HemisphereLight('#e9e7df', '#14202c', 1.5));
    const sun = new DirectionalLight('#ffffff', 1);
    sun.position.set(-30, 90, 50);
    scene.add(sun);
    const shade = document.createElement('canvas');
    shade.width = shade.height = 64;
    const g = shade.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    const shadow = new Mesh(keep(new PlaneGeometry(150, 104)), keep(new MeshBasicMaterial({ map: keep(new CanvasTexture(shade)), transparent: true, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -5;
    scene.add(shadow);
    const side = keep(new MeshLambertMaterial({ color: '#152822' }));
    const top = keep(new MeshLambertMaterial({ color: '#1a302a' }));
    const slab = new Mesh(keep(new BoxGeometry(113, 2, 76)), [side, side, top, side, side, side]);
    slab.position.y = -1;
    scene.add(slab);
    for (let i = 0; i < 12; i += 2) {
      const stripe = new Mesh(keep(new PlaneGeometry(8.75, 68)), keep(new MeshLambertMaterial({ color: '#1c342e' })));
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(i * 8.75 + 4.375 - 52.5, .005, 0);
      scene.add(stripe);
    }
    const chalk = keep(new LineBasicMaterial({ color: '#f3efe5', transparent: true, opacity: .6 }));
    const seg: number[] = [];
    const add = (ax: number, ay: number, bx: number, by: number) => { const a = toWorld(ax, ay, .02), b = toWorld(bx, by, .02); seg.push(a.x, a.y, a.z, b.x, b.y, b.z); };
    const rect = (x: number, y: number, w: number, h: number) => { add(x, y, x + w, y); add(x + w, y, x + w, y + h); add(x + w, y + h, x, y + h); add(x, y + h, x, y); };
    rect(0, 0, 105, 68); add(52.5, 0, 52.5, 68);
    rect(0, 13.84, 16.5, 40.32); rect(88.5, 13.84, 16.5, 40.32); rect(0, 24.84, 5.5, 18.32); rect(99.5, 24.84, 5.5, 18.32);
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2, b = (i + 1) / 48 * Math.PI * 2;
      add(52.5 + Math.cos(a) * 9.15, 34 + Math.sin(a) * 9.15, 52.5 + Math.cos(b) * 9.15, 34 + Math.sin(b) * 9.15);
    }
    const lineGeo = keep(new BufferGeometry());
    lineGeo.setAttribute('position', new Float32BufferAttribute(seg, 3));
    scene.add(new LineSegments(lineGeo, chalk));

    // The sequence: one path and one start marker per recorded action, on the plane.
    const paths = new Group();
    scene.add(paths);
    const items = steps.filter(step => step.start).map((step, index) => {
      const tone = TONE[step.type === 'shot' ? 'shot' : step.team_id ?? ''] ?? '#afbdb7';
      const start = toWorld(step.start!.x, step.start!.y, .06);
      const end = step.end ? toWorld(step.end.x, step.end.y, .06) : start.clone();
      // A flat ribbon on the turf (WebGL lines are 1 px), grown from the recorded start towards the recorded end.
      const material = keep(new MeshBasicMaterial({ color: tone, transparent: true, opacity: 1 }));
      const geometry = keep(new PlaneGeometry(1, step.type === 'shot' ? .75 : .55));
      geometry.translate(.5, 0, 0);
      const line = new Mesh(geometry, material);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -Math.atan2(end.z - start.z, end.x - start.x);
      line.position.copy(start);
      const length = Math.max(.0001, start.distanceTo(end));
      const dotMaterial = keep(new MeshBasicMaterial({ color: tone, transparent: true, opacity: 1 }));
      const dot = new Mesh(keep(new CircleGeometry(.8, 24)), dotMaterial);
      dot.rotation.x = -Math.PI / 2;
      dot.position.copy(start).setY(.07);
      paths.add(line, dot);
      return { step, index, start, end, line, length, material, dotMaterial };
    });
    const ball = new Mesh(keep(new SphereGeometry(.7, 20, 14)), keep(new MeshBasicMaterial({ color: '#fbfbf4' })));
    scene.add(ball);
    const halo = new Mesh(keep(new RingGeometry(1.5, 2.1, 32)), keep(new MeshBasicMaterial({ color: '#e9e7df', transparent: true, opacity: .85, depthWrite: false })));
    halo.rotation.x = -Math.PI / 2;
    scene.add(halo);

    let current = Math.min(active, items.length - 1);
    let mode: CameraMode = camera;
    let draw = 1;             // 0–1 progress of the active step's path (illustrative interpolation)
    let frame = 0;
    let visible = !document.hidden;
    let onscreen = true;

    const placeCamera = () => {
      // Fixed cameras that always show the complete pitch, so the sequence is seen in context. On narrow
      // frames the camera steps back just far enough for both touchlines to stay in view.
      const back = Math.max(1, 1.55 / Math.max(.4, cam.aspect));
      if (mode === 'overhead') { cam.position.set(0, 150 * back, .01); cam.lookAt(0, 0, 0); }
      else { cam.position.set(0, 104 * back, 126 * back); cam.lookAt(0, -16, 16); }
    };

    const render = () => {
      if (!visible || !onscreen) return;
      items.forEach(item => {
        const on = item.index === current, past = item.index < current;
        item.material.opacity = on ? 1 : past ? .42 : .12;
        item.dotMaterial.opacity = on ? 1 : past ? .5 : .18;
        item.line.scale.x = on ? Math.max(.0001, item.length * draw) : item.length;
        item.line.scale.y = on ? 1.7 : 1;
        if (on) { ball.position.copy(item.start.clone().lerp(item.end, draw)).setY(.7); halo.position.copy(item.start).setY(.08); }
      });
      renderer.render(scene, cam);
      // Numbered HTML labels at each step's recorded start point.
      const box = el.getBoundingClientRect();
      const nodes = labels.current?.children;
      // Consecutive actions often share a point (a ball win and the next pass): later labels step aside.
      const placed: { x: number; y: number }[] = [];
      items.forEach((item, i) => {
        const node = nodes?.[i] as HTMLElement | undefined;
        if (!node) return;
        const p = item.start.clone().project(cam);
        let x = ((p.x + 1) / 2) * box.width;
        const py = ((1 - p.y) / 2) * box.height;
        const y = py < 34 ? py + 10 : py - 28;
        while (placed.some(o => Math.abs(o.x - x) < 24 && Math.abs(o.y - y) < 20)) x += 26;
        x = Math.min(box.width - 14, Math.max(14, x));
        placed.push({ x, y });
        node.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`;
        node.classList.toggle('dim', item.index > current);
        node.classList.toggle('on', item.index === current);
      });
    };

    const animateStep = () => {
      cancelAnimationFrame(frame);
      if (reduced || !visible || !onscreen) { draw = 1; render(); return; }
      const begin = performance.now();
      const tick = (now: number) => {
        draw = Math.min(1, (now - begin) / 420);
        draw = 1 - Math.pow(1 - draw, 3);
        render();
        if (draw < 1) frame = requestAnimationFrame(tick);
      };
      draw = 0;
      frame = requestAnimationFrame(tick);
    };

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
      placeCamera();
      render();
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(el);
    const seen = new IntersectionObserver(([entry]) => { onscreen = entry.isIntersecting; if (onscreen) render(); else cancelAnimationFrame(frame); });
    seen.observe(el);
    const onVisibility = () => { visible = !document.hidden; if (visible) render(); else cancelAnimationFrame(frame); };
    document.addEventListener('visibilitychange', onVisibility);

    placeCamera();
    resize();
    animateStep();
    api.current = {
      setActive: index => { current = Math.min(index, items.length - 1); animateStep(); },
      setCamera: next => { mode = next; placeCamera(); render(); },
    };

    return () => {
      api.current = null;
      cancelAnimationFrame(frame);
      sizes.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      disposables.forEach(item => item.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
    // The scene is built once per sequence; step and camera changes go through `api` without rebuilding.
  }, [steps, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.current?.setActive(active); }, [active]);
  useEffect(() => { api.current?.setCamera(camera); }, [camera]);

  return <div className="stage3d" ref={host}>
    <div className="labels3d" ref={labels} aria-hidden="true">
      {steps.filter(step => step.start).map((step, index) => <span key={step.event_id} className="label3d"
        style={{ ['--tone' as string]: TONE[step.type === 'shot' ? 'shot' : step.team_id ?? ''] ?? '#afbdb7' }}>{index + 1}</span>)}
    </div>
  </div>;
}
