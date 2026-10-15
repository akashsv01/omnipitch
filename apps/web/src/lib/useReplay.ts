import { useCallback, useEffect, useRef, useState } from 'react';
import { controlReplay, fetchReplay, generateReplay, loadFromEventhouse, loadReplay, mergeSnapshot } from './api';
import type { ReplaySnapshot, Scenario, Speed } from '../types/contracts';

export type Connection = 'connecting' | 'online' | 'offline';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown request error';

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

  const accept = useCallback((next: ReplaySnapshot) => {
    const merged = mergeSnapshot(latest.current, next);
    latest.current = merged;
    setReplay(merged);
    setReceivedAt(performance.now());
    setConnection('online');
    setConnectionError(undefined);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = generation.current;
      if (!acting.current) {
        try {
          const known = latest.current;
          const next = await fetchReplay(known?.state.run_id, known?.state.latest_event_sequence ?? 0);
          if (active && current === generation.current) accept(next);
        } catch (error) {
          if (active && current === generation.current) {
            setConnection('offline');
            setConnectionError(errorMessage(error));
          }
        }
      }
      if (active) timer = setTimeout(poll, document.hidden ? 2000 : 450);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [accept, refreshKey]);

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
      setActionError(errorMessage(error));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }, [accept]);

  return {
    replay, connection, connectionError, actionError, busy, receivedAt,
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
