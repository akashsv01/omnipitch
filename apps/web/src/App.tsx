import { useEffect, useState } from 'react';
import { LatestEvent } from './components/LatestEvent';
import { API_BASE_URL, fetchDemo } from './lib/api';
import type { Event, MatchState } from './types/contracts';
import './style.css';

type View =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; state: MatchState; events: Event[] };

export default function App() {
  const [view, setView] = useState<View>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setView({ status: 'loading' });
    fetchDemo().then(data => { if (active) setView({ status: 'success', ...data }); })
      .catch((error: unknown) => { if (active) setView({ status: 'error', message: error instanceof Error ? error.message : 'Unknown request error' }); });
    return () => { active = false; };
  }, [refresh]);

  return <main>
    <header><p className="label">Development scaffold — sample data</p><h1>OmniPitch</h1><p className="subtitle">Synthetic football intelligence</p></header>
    <section>
      <div className="connection"><p role="status" aria-live="polite">Backend: {view.status === 'success' ? 'Connected' : view.status === 'loading' ? 'Connecting…' : 'Connection failed'}</p>
        <button onClick={() => setRefresh(value => value + 1)} disabled={view.status === 'loading'}>Refresh</button></div>
      <p className="muted">{API_BASE_URL}</p>
      {view.status === 'loading' && <p>Loading sample match and events…</p>}
      {view.status === 'error' && <p role="alert" className="error">{view.message}</p>}
      {view.status === 'success' && <>
        <h2>{view.state.home_team.name} vs {view.state.away_team.name}</h2>
        <p className="score">{view.state.score.home} — {view.state.score.away}</p>
        <p>Period {view.state.period} · {view.state.match_time_ms / 1000} seconds · Replay {view.state.replay_status}</p>
        <p className="muted">Run: {view.state.run_id} · All data is synthetic.</p>
      </>}
    </section>
    {view.status === 'success' && <LatestEvent event={view.events.at(-1)} />}
    <footer>Fixed fictional fixtures. Analytics and AI explanations are planned.</footer>
  </main>;
}
