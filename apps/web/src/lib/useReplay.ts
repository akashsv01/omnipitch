import { useCallback, useEffect, useRef, useState } from 'react';
import { controlReplay, fetchReplay, generateReplay, loadFromEventhouse, loadReplay, mergeSnapshot, negotiatePush, publicMessage, validatePush } from './api';
import { OFF_STATUS, PushClient, type PushSignal, type PushStatus, type SocketLike } from './push';
import type { ReplaySnapshot, Scenario, Speed } from '../types/contracts';

export type Connection = 'connecting' | 'online' | 'offline';

// The landing page asks for the current snapshot ahead of entry, so the match room can paint real data on
// arrival instead of a long skeleton. It is read-only, used once, and discarded after 15 s.
let primed: { at: number; snapshot: Promise<ReplaySnapshot> } | null = null;
export function prefetchReplay(): Promise<ReplaySnapshot> {
  if (primed && performance.now() - primed.at < 15000) return primed.snapshot;
  const snapshot = fetchReplay(undefined, 0);
  snapshot.catch(() => { primed = null; });
  primed = { at: performance.now(), snapshot };
  return snapshot;
}
function takePrimed() {
  const value = primed && performance.now() - primed.at < 15000 ? primed.snapshot : null;
  primed = null;
  return value;
}

/**
 * Polls the atomic replay snapshot, asking only for events after the last known sequence.
 * Mutations invalidate in-flight polls so an older response never overwrites a newer state.
 */
export function useReplay() {
  const [replay, setReplay] = useState<ReplaySnapshot>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [connectionError, setConnectionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [receivedAt, setReceivedAt] = useState(() => performance.now());
  const latest = useRef<ReplaySnapshot>(undefined);
  const generation = useRef(0);
  const acting = useRef(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const needFull = useRef(false);
  const accept = useCallback((next: ReplaySnapshot) => {
    // Incremental polls only carry new moments; when narrated insights change, fetch everything once.
    const previous = latest.current;
    if (previous && previous.state.run_id === next.state.run_id && next.events_offset > 0
        && previous.insights.version !== next.insights.version) needFull.current = true;
    const merged = mergeSnapshot(latest.current, next);
    latest.current = merged;
    setReplay(merged);
    setReceivedAt(performance.now());
    setConnection('online');
    setConnectionError(undefined);
  }, []);

  // A push only asks for the next snapshot sooner; the snapshot API stays authoritative.
  const kick = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    let again = false;
    kick.current = () => {
      if (!active) return;
      if (polling) { again = true; return; }
      clearTimeout(timer);
      void poll();
    };
    async function poll() {
      polling = true;
      const current = generation.current;
      if (!acting.current) {
        try {
          const known = latest.current;
          const full = needFull.current;
          needFull.current = false;
          const warm = known ? null : takePrimed();
          const next = await (warm ?? fetchReplay(known?.state.run_id, full ? 0 : known?.state.latest_event_sequence ?? 0));
          if (active && current === generation.current) accept(next);
        } catch (error) {
          if (active && current === generation.current) {
            setConnection('offline');
            setConnectionError(publicMessage(error, 'match'));
          }
        }
      }
      polling = false;
      if (!active) return;
      if (again) { again = false; void poll(); return; }
      timer = setTimeout(poll, document.hidden ? 2000 : 450);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [accept, refreshKey]);

  // Web PubSub fast path for the replay's source run (an uploaded file's or an Eventhouse run's ID).
  const [push, setPush] = useState<PushStatus>(OFF_STATUS);
  const pushClient = useRef<PushClient>(undefined);
  if (!pushClient.current) {
    pushClient.current = new PushClient({
      negotiate: negotiatePush,
      openSocket: (url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike,  // Handlers are assigned as properties.
      validate: (envelope): envelope is Parameters<typeof validatePush>[0] => validatePush(envelope),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }, (signal: PushSignal) => {
      if (signal.kind === 'full') needFull.current = true;
      kick.current();
    }, setPush);
  }
  const sourceRunId = replay?.replay.source_run_id ?? null;
  useEffect(() => { pushClient.current?.start(sourceRunId); }, [sourceRunId]);
  useEffect(() => () => pushClient.current?.stop(), []);

  const act = useCallback(async (operation: (runId: string) => Promise<ReplaySnapshot>) => {
    const runId = latest.current?.state.run_id;
    if (acting.current || !runId) return;
    acting.current = true;
    generation.current += 1;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await operation(runId);
      latest.current = undefined; // Control responses are full snapshots.
      accept(next);
    } catch (error) {
      setActionError(publicMessage(error, 'action'));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }, [accept]);

  return {
    replay, connection, connectionError, actionError, busy, receivedAt, push,
    clearActionError: () => setActionError(undefined),
    reconnect: () => { setConnection('connecting'); setRefreshKey(value => value + 1); },
    play: () => act(run => controlReplay(run, { action: 'play' })),
    pause: () => act(run => controlReplay(run, { action: 'pause' })),
    reset: () => act(run => controlReplay(run, { action: 'reset' })),
    setSpeed: (speed: Speed) => act(run => controlReplay(run, { action: 'speed', speed })),
    seek: (elapsed: number) => act(run => controlReplay(run, { action: 'seek', elapsed_ms: Math.max(0, Math.round(elapsed)) })),
    generate: (seed: number, scenario: Scenario) => act(run => generateReplay(run, seed, scenario)),
    load: (file: File) => act(run => loadReplay(run, file)),
    loadEventhouse: (sourceRunId: string) => act(run => loadFromEventhouse(run, sourceRunId)),
  };
}

/** Smoothly interpolated replay position between polls (display only; the API stays authoritative). */
export function useInterpolatedElapsed(replay: ReplaySnapshot | undefined, receivedAt: number) {
  const [now, setNow] = useState(() => performance.now());
  const playing = replay?.state.replay_status === 'playing';
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      if (time - last > 120) { setNow(time); last = time; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  if (!replay) return { elapsed: 0, clockMs: 0 };
  const drift = playing ? Math.min(1500, Math.max(0, now - receivedAt)) * replay.replay.speed : 0;
  const elapsed = Math.min(replay.replay.duration_ms, replay.replay.elapsed_ms + drift);
  return { elapsed, clockMs: replay.replay.clock_ms + (elapsed - replay.replay.elapsed_ms) };
}
