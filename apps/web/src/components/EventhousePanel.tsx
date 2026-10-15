import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, CloudDownload, Database, TriangleAlert } from 'lucide-react';
import type { ReplaySnapshot } from '../types/contracts';
import { fetchEventhouseRun, fetchEventhouseRuns, type EventhouseRunDetail } from '../lib/api';

/** Azure mode only: choose an Eventhouse run, load it into the replay, and show raw/unique rows and KQL parity. */
export function EventhousePanel({ replay, busy, onLoad, compact = false }: {
  replay: ReplaySnapshot; busy: boolean; onLoad: (sourceRunId: string) => void; compact?: boolean;
}) {
  const [runs, setRuns] = useState<{ run_id: string; unique_events: number; raw_rows: number }[]>();
  const [runId, setRunId] = useState(replay.replay.source_run_id ?? '');
  const [detail, setDetail] = useState<EventhouseRunDetail>();
  const [error, setError] = useState<string>();
  const current = replay.replay.source === 'eventhouse' ? replay.replay.source_run_id : null;

  useEffect(() => {
    let active = true;
    fetchEventhouseRuns().then(result => {
      if (!active) return;
      setRuns(result.runs);
      setRunId(value => value || result.runs[0]?.run_id || '');
    }).catch(err => active && setError(err.message));
    return () => { active = false; };
  }, [current]);

  useEffect(() => {
    if (!current || compact) return;
    let active = true;
    fetchEventhouseRun(current).then(result => active && setDetail(result)).catch(err => active && setError(err.message));
    return () => { active = false; };
  }, [current, compact]);

  return <div className="card" style={{ gap: 12 }}>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Database size={17} aria-hidden="true" />Fabric Eventhouse</h3>
    <div className="field-row">
      <label className="field">Run in Eventhouse
        <input list="eventhouse-runs" value={runId} onChange={event => setRunId(event.target.value.trim())} placeholder="run_id" spellCheck={false} />
        <datalist id="eventhouse-runs">{runs?.map(run => <option key={run.run_id} value={run.run_id}>{`${run.unique_events} unique, ${run.raw_rows} rows`}</option>)}</datalist>
      </label>
      <button type="button" className="button primary" disabled={busy || !runId} onClick={() => onLoad(runId)}>
        <CloudDownload size={15} aria-hidden="true" />Load run
      </button>
    </div>
    {runs && runs.length === 0 && <p className="hint">No runs in the table yet. Publish one with the simulator, then wait for Eventstream ingestion.</p>}
    {error && <p className="alert" role="alert" style={{ marginTop: 0 }}><span style={{ display: 'flex', gap: 8 }}><TriangleAlert size={16} />{error}</span></p>}
    {detail && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'grid', gap: 10 }}>
      <div className="stat-pair">
        <div className="stat"><b>{detail.summary.raw_rows}</b><span>rows in Eventhouse</span></div>
        <div className="stat"><b>{detail.summary.unique_events}</b><span>unique events used</span></div>
        <div className="stat"><b>{detail.summary.duplicate_rows}</b><span>duplicate rows ignored</span></div>
      </div>
      <div className="notice" style={detail.parity_ok ? { background: 'rgba(111,211,154,.1)', borderColor: 'rgba(111,211,154,.35)' } : undefined}>
        {detail.parity_ok ? <CheckCircle2 size={16} color="var(--ok)" /> : <TriangleAlert size={16} />}
        <span>{detail.parity_ok ? 'KQL counts and progression match the Python metrics for this run.' : 'KQL and Python metrics disagree. See the rows marked below.'}</span>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Team</th><th>Metric</th><th className="num">KQL</th><th className="num">Python</th><th /></tr></thead>
        <tbody>{detail.parity.map(row => <tr key={`${row.team_id}-${row.metric}`}>
          <td>{row.team_id}</td><td>{row.metric.replace('_', ' ')}</td><td className="num">{row.kql ?? '–'}</td><td className="num">{row.python}</td>
          <td style={{ color: row.match ? 'var(--ok)' : 'var(--danger)' }}>{row.match ? 'match' : 'differs'}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="hint">{detail.source.eventhouse_database}.{detail.source.eventhouse_table} · deduplicated by (run_id, event_id), first ingested copy kept.</p>
    </motion.div>}
  </div>;
}
