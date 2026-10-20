import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpenText, Info, RefreshCw, Sparkles, UserRound } from 'lucide-react';
import type { RecapScope, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { fetchRecap, type RecapResult } from '../lib/api';
import { METRIC_LABEL, RULE_LABEL, fmt, teamTone } from '../lib/format';
import { RULE_ICON } from './MomentFeed';

const SCOPES: { id: RecapScope; label: string }[] = [{ id: 'first_half', label: 'First half' }, { id: 'full_time', label: 'Full time' }];

/** Halftime / full-time recap: verified moments only, clickable to replay, with an honest author label. */
export function RecapPanel({ replay, audience, onJump, request }: {
  replay: ReplaySnapshot; audience: Audience; onJump: (momentId: string, replayMs: number) => void;
  request?: { nonce: number; scope?: RecapScope };
}) {
  const secondHalf = replay.events.some(event => event.period === 2);
  // period_start of the second half arrives with the first half's period_end; switch only once play resumes.
  const secondHalfPlay = replay.events.some(event => event.period === 2 && !event.type.startsWith('period_'));
  const [scope, setScope] = useState<RecapScope>(secondHalfPlay ? 'full_time' : 'first_half');
  const [result, setResult] = useState<RecapResult | null>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const seq = replay.state.latest_event_sequence;
  const lastFetch = useRef({ seq: -1, run: '', scope: '' as RecapScope | '' });
  const playing = replay.state.replay_status === 'playing';

  useEffect(() => { if (secondHalfPlay) setScope('full_time'); }, [secondHalfPlay]);
  useEffect(() => { if (request?.scope && request.scope !== scope) { setResult(undefined); setScope(request.scope); } }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on demand, never debounced: snapshots arrive faster than any debounce at high replay speeds.
  const inFlight = useRef(false);
  const wanted = useRef({ run: '', scope });
  wanted.current = { run: replay.state.run_id, scope };
  useEffect(() => {
    const prev = lastFetch.current;
    const stale = prev.run !== replay.state.run_id || prev.scope !== scope || Math.abs(seq - prev.seq) >= 20
      || (!playing && seq !== prev.seq) || nonce > 0 || (result === null && seq !== prev.seq);
    if (!stale || inFlight.current) return;
    if (seq === 0 || (scope === 'full_time' && !secondHalf)) {  // Nothing to recap yet: no request, no 404.
      lastFetch.current = { seq, run: replay.state.run_id, scope };
      setNonce(0);
      setResult(null);
      return;
    }
    inFlight.current = true;
    lastFetch.current = { seq, run: replay.state.run_id, scope };
    setNonce(0);
    const asked = { run: replay.state.run_id, scope };
    const current = () => wanted.current.run === asked.run && wanted.current.scope === asked.scope;
    fetchRecap(scope).then(next => { if (current()) { setResult(next); setError(undefined); } })
      .catch(err => { if (current()) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { inFlight.current = false; if (!current()) setNonce(n => n + 1); });
  }, [scope, seq, playing, replay.state.run_id, nonce, secondHalf]);

  // While the AI rewrite is running, check back every two seconds.
  useEffect(() => {
    if (result?.ai.status !== 'pending') return;
    const timer = setTimeout(() => setNonce(n => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [result]);

  const recap = result?.recap;
  const ai = result?.ai;
  const author = !recap ? null : recap.generation_mode === 'ai' ? { label: 'AI-written, checked', mode: 'ai' }
    : ai?.status === 'pending' ? { label: 'Writing with AI…', mode: 'pending' }
    : ai?.status === 'fallback' ? { label: 'Template (AI recap rejected)', mode: 'fallback' }
    : { label: 'Template', mode: 'fallback' };

  return <div className="recap" aria-live="polite">
    <div className="recap-toolbar">
      <div className="segmented small" role="radiogroup" aria-label="Recap period">
        {SCOPES.map(item => <button key={item.id} type="button" role="radio" aria-checked={scope === item.id}
          disabled={item.id === 'full_time' && !secondHalf} onClick={() => { if (item.id !== scope) { setResult(undefined); setScope(item.id); } }}>
          {scope === item.id && <motion.span layoutId="recap-scope" className="thumb" />}{item.label}
        </button>)}
      </div>
      {recap && <span className="recap-status" data-status={recap.status}>
        {recap.status === 'final' ? 'Final' : `Provisional · ${recap.clock}`}
      </span>}
      {author && <span className="author-tag" data-mode={author.mode} title={ai?.reason ?? undefined}>
        {author.mode === 'ai' && <Sparkles size={11} aria-hidden="true" />}{author.label}
      </span>}
      <button type="button" className="icon-button" style={{ marginLeft: 'auto' }} aria-label="Refresh recap"
        onClick={() => setNonce(n => n + 1)}><RefreshCw size={15} /></button>
    </div>

    {error && <p className="alert" role="alert">{error}</p>}
    {result === null && <div className="empty"><BookOpenText size={22} /><strong>No recap yet</strong>
      <span>{scope === 'first_half' ? 'The first-half recap appears once the match kicks off.' : 'The full-time recap appears once the second half starts.'}</span></div>}
    {result === undefined && !error && <div className="skeleton" style={{ height: 180 }} aria-busy="true" />}

    <AnimatePresence mode="wait" initial={false}>
      {recap && <motion.div key={`${recap.scope}-${recap.status}-${recap.generation_mode}`} className="recap-body"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .22 }}>
        <div className="recap-head">
          <div className="recap-score" aria-label={`Score ${recap.score.home} to ${recap.score.away}`}>
            <span style={{ color: 'var(--harbor)' }}>HAR</span><b>{recap.score.home}</b><i>–</i><b>{recap.score.away}</b><span style={{ color: 'var(--vale)' }}>VAL</span>
          </div>
          <h3>{recap.headline}</h3>
        </div>
        <p className="recap-summary">{recap.summary}</p>

        <section className="recap-section" aria-label="Key moments">
          <h4>Key moments</h4>
          {recap.key_moments.length === 0 ? <p className="hint">No verified moments in this period yet.</p>
            : <ol className="recap-moments">
              {recap.key_moments.map(km => {
                const Icon = RULE_ICON[km.rule];
                return <li key={km.moment_id}>
                  <button type="button" onClick={() => onJump(km.moment_id, km.replay_ms)} style={{ ['--tone' as string]: teamTone(km.team_id) }}
                    title="Replay from this moment">
                    <span className="minute">{km.clock}</span>
                    <span className="rule-tag"><Icon size={12} aria-hidden="true" />{RULE_LABEL[km.rule]}</span>
                    <span className="recap-moment-text">{km.headline}</span>
                    <span className="author-tag" data-mode={km.generation_mode}>{km.generation_mode === 'ai' ? 'AI' : 'Template'}</span>
                  </button>
                </li>;
              })}
            </ol>}
        </section>

        <div className="grid-2">
          <section className="card recap-card" data-supported={recap.tactical_trend.supported}>
            <h4>{recap.tactical_trend.supported ? 'Tactical trend' : 'Tactical trend: not enough data'}</h4>
            <p>{recap.tactical_trend.text}</p>
            {audience === 'analyst' && recap.tactical_trend.values && <p className="hint mono">
              {JSON.stringify(recap.tactical_trend.values)}</p>}
          </section>
          <section className="card recap-card">
            <h4><UserRound size={14} aria-hidden="true" /> Player focus</h4>
            <p>{recap.player_focus ? recap.player_focus.text : 'No player actions recorded yet.'}</p>
            {audience === 'analyst' && recap.player_focus && <div className="metric-chips">
              {recap.player_focus.metrics.map(m => <span key={m.name} className="metric-chip">{METRIC_LABEL[m.name] ?? m.name.replace('_', ' ')}<b>{fmt(m.value)}</b>{m.unit}</span>)}
            </div>}
          </section>
        </div>

        {audience === 'analyst' && <section className="recap-section">
          <h4>Sources and limitations</h4>
          <p className="hint">Through event {recap.through_sequence} · {recap.recap_version} · sources: <span className="mono">{recap.sources.join(', ') || 'none'}</span></p>
          <ul className="limitations">{recap.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        </section>}
        {audience === 'fan' && <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Info size={13} aria-hidden="true" />Built only from recorded events and verified moments. Switch to Analyst view for sources.</p>}
      </motion.div>}
    </AnimatePresence>
  </div>;
}
