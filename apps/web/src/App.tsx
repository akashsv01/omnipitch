import { useEffect, useRef, useState } from 'react';
import { PassExplorer } from './components/PassExplorer';
import { API_BASE_URL, controlReplay, fetchReplay, loadReplay } from './lib/api';
import type { ReplaySnapshot } from './types/contracts';
import './style.css';

type View =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; replay: ReplaySnapshot };

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown request error';

export default function App() {
  const [view, setView] = useState<View>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = generation.current;
      if (!acting.current) {
        try {
          const replay = await fetchReplay();
          if (active && current === generation.current) {
            setView({ status: 'success', replay });
            setConnectionError(undefined);
          }
        } catch (error) {
          if (active && current === generation.current) {
            const message = errorMessage(error);
            setConnectionError(message);
            setView(previous => previous.status === 'success' ? previous : { status: 'error', message });
          }
        }
      }
      if (active) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  async function act(operation: () => Promise<ReplaySnapshot>) {
    if (acting.current) return;
    acting.current = true;
    generation.current += 1;
    setBusy(true);
    setActionError(undefined);
    try {
      const replay = await operation();
      setView({ status: 'success', replay });
      setConnectionError(undefined);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const replay = view.status === 'success' ? view.replay : undefined;
  const state = replay?.state;
  const disabled = busy || !!connectionError;

  return <main>
    <header><p className="label">Local replay · Synthetic data</p><h1>OmniPitch</h1><p className="subtitle">Synthetic football intelligence</p></header>
    <section>
      <div className="connection"><p role="status" aria-live="polite">Backend: {connectionError ? 'Disconnected' : view.status === 'success' ? 'Connected' : 'Connecting…'}</p>
        <button onClick={() => setRefresh(value => value + 1)} disabled={busy}>Refresh</button></div>
      <p className="muted">{API_BASE_URL}</p>
      {view.status === 'loading' && <p>Loading replay…</p>}
      {view.status === 'error' && <p role="alert" className="error">{view.message}</p>}
      {connectionError && view.status === 'success' && <p role="alert" className="error">{connectionError} Displaying the last received state; controls are disabled until reconnection.</p>}
      {state && replay && <>
        <h2>{state.home_team.name} vs {state.away_team.name}</h2>
        <p className="score">{state.score.home} — {state.score.away}</p>
        <p>Period {state.period} · {(state.match_time_ms / 1000).toFixed(0)} seconds at latest event · Replay {state.replay_status}</p>
        <p className="muted">Run: {state.run_id} · All data is synthetic.</p>
        <div className="replay-controls" aria-label="Replay controls">
          <button disabled={disabled || state.replay_status === 'finished'} onClick={() => void act(() => controlReplay(state.run_id, state.replay_status === 'playing' ? 'pause' : 'play'))}>
            {state.replay_status === 'playing' ? 'Pause' : state.latest_event_sequence > 0 ? 'Resume' : 'Play'}
          </button>
          <button disabled={disabled} onClick={() => void act(() => controlReplay(state.run_id, 'reset'))}>Reset run</button>
          <label className="replay-file">Load JSONL
            <input type="file" accept=".jsonl,application/x-ndjson" disabled={disabled} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void act(() => loadReplay(state.run_id, file));
            }} />
          </label>
        </div>
        <p role="status" aria-live="polite">{state.latest_event_sequence} of {replay.total_events} passes revealed{busy ? ' · Updating…' : ''}</p>
        <progress value={state.latest_event_sequence} max={replay.total_events} aria-label="Replay progress" />
        <p className="muted">Load a simulator JSONL file (up to 1 MiB / 1000 events). Loading and resetting start a new paused run. Recorded event timing controls playback.</p>
      </>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
    </section>
    {replay && <PassExplorer key={replay.state.run_id} events={replay.events} />}
    <footer>Local in-memory replay shared by this API process. Analytics and AI explanations are planned.</footer>
  </main>;
}
