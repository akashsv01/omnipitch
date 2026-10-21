import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import eventSchema from '../../../../contracts/schemas/event.schema.json';
import stateSchema from '../../../../contracts/schemas/match-state.schema.json';
import insightSchema from '../../../../contracts/schemas/insight.schema.json';
import momentSchema from '../../../../contracts/schemas/moment.schema.json';
import analysisSchema from '../../../../contracts/schemas/analysis.schema.json';
import replaySchema from '../../../../contracts/schemas/replay.schema.json';
import recapSchema from '../../../../contracts/schemas/recap.schema.json';
import reconciliationSchema from '../../../../contracts/schemas/reconciliation.schema.json';
import pushSchema from '../../../../contracts/schemas/push.schema.json';
import type { Negotiated, PushEnvelope } from './push';
import type { Event, IngestResult, LedgerSummary, MatchState, Recap, RecapScope, ReplaySnapshot, Scenario, Speed } from '../types/contracts';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const ajv = new Ajv2020({ allowUnionTypes: true });
addFormats(ajv);
for (const schema of [eventSchema, stateSchema, insightSchema, momentSchema, analysisSchema, reconciliationSchema]) ajv.addSchema(schema);
const validateState = ajv.compile<MatchState>(stateSchema);
const validateEvent = ajv.getSchema<Event>(eventSchema.$id)!;
const validateReplay = ajv.compile<ReplaySnapshot>(replaySchema);
const validateRecap = ajv.compile<Recap>(recapSchema);
export const validatePush = ajv.compile<PushEnvelope>(pushSchema);

export class ApiError extends Error {
  constructor(message: string, public readonly kind: 'network' | 'http' | 'contract', public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Local endpoints answer from SQLite quickly; live Eventhouse calls make several KQL round trips.
const DEFAULT_TIMEOUT_MS = 8000;
const EVENTHOUSE_TIMEOUT_MS = 45000;

async function getJson(path: string, options: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError(`Can't reach the API at ${API_BASE_URL}. Start FastAPI and check CORS_ORIGINS.`, 'network');
  }
  if (!response.ok) {
    let message = `API returned HTTP ${response.status}`;
    try {
      const error = await response.json();
      if (typeof error?.detail?.message === 'string') message = error.detail.message;
      else if (Array.isArray(error?.detail) && typeof error.detail[0]?.msg === 'string') message = error.detail[0].msg;
    } catch { /* Preserve HTTP status for a non-JSON response. */ }
    throw new ApiError(message, 'http', response.status);
  }
  try { return await response.json(); }
  catch { throw new ApiError('API returned invalid JSON.', 'contract'); }
}

const post = (path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS) => getJson(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}, timeoutMs);

export async function fetchDemo(): Promise<{ state: MatchState; events: Event[] }> {
  const [state, response] = await Promise.all([getJson('/api/v1/matches/demo/state'), getJson('/api/v1/matches/demo/events')]);
  if (!validateState(state)) throw new ApiError('Match state does not match the wire contract.', 'contract');
  if (typeof response !== 'object' || response === null || !('events' in response) || !Array.isArray(response.events)) {
    throw new ApiError('Events response does not contain an events array.', 'contract');
  }
  for (const event of response.events) {
    if (!validateEvent(event)) throw new ApiError('An event does not match the wire contract.', 'contract');
  }
  return { state, events: response.events as Event[] };
}

/** Validate a (possibly incremental) snapshot: events continue from events_offset in order. */
export function checkSnapshot(value: unknown): ReplaySnapshot {
  if (!validateReplay(value)) throw new ApiError('Replay response does not match the wire contract.', 'contract');
  const { state, events, events_offset: offset, total_events: total } = value;
  if (offset + events.length !== state.latest_event_sequence || state.latest_event_sequence > total) {
    throw new ApiError('Replay progress is inconsistent.', 'contract');
  }
  for (const [index, event] of events.entries()) {
    if (event.run_id !== state.run_id || event.match_id !== state.match_id || event.sequence !== offset + index + 1) {
      throw new ApiError('Replay event ordering or identity is inconsistent.', 'contract');
    }
  }
  return value;
}

/** Merge an incremental snapshot into the previous full snapshot for the same run. */
export function mergeSnapshot(previous: ReplaySnapshot | undefined, next: ReplaySnapshot): ReplaySnapshot {
  if (next.events_offset === 0 || !previous || previous.state.run_id !== next.state.run_id) return next;
  const events = [...previous.events.slice(0, next.events_offset), ...next.events];
  const moments = [...previous.moments.filter(moment => moment.source_sequence <= next.events_offset), ...next.moments];
  return { ...next, events, moments, events_offset: 0 };
}

export async function fetchReplay(runId?: string, afterSequence = 0): Promise<ReplaySnapshot> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}&after_sequence=${afterSequence}` : '';
  return checkSnapshot(await getJson(`/api/v1/replay${query}`));
}

type ControlAction = { action: 'play' | 'pause' | 'reset' } | { action: 'speed'; speed: Speed } | { action: 'seek'; elapsed_ms: number };

export async function controlReplay(runId: string, command: ControlAction): Promise<ReplaySnapshot> {
  return checkSnapshot(await post('/api/v1/replay/control', { run_id: runId, ...command }));
}

export async function generateReplay(runId: string, seed: number, scenario: Scenario): Promise<ReplaySnapshot> {
  return checkSnapshot(await post('/api/v1/replay/generate', { run_id: runId, seed, scenario }));
}

export async function loadReplay(runId: string, file: File): Promise<ReplaySnapshot> {
  if (file.size > 2 * 1_048_576) throw new ApiError('JSONL files must be at most 2 MiB.', 'contract');
  return checkSnapshot(await getJson(`/api/v1/replay/load?run_id=${encodeURIComponent(runId)}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: file,
  }));
}

export async function ingestEvents(runId: string, events: Event[]): Promise<IngestResult> {
  const result = await getJson(`/api/v1/runs/${encodeURIComponent(runId)}/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: events.map(event => JSON.stringify(event)).join('\n'),
  });
  return result as IngestResult;
}

export interface LedgerView { summary: LedgerSummary; diagnostics: { event_id: string | null; code: string; message: string; received_at: string }[] }

export async function fetchLedger(runId: string): Promise<LedgerView> {
  return await getJson(`/api/v1/runs/${encodeURIComponent(runId)}/ledger`) as LedgerView;
}

export interface EventhouseRunDetail {
  run_id: string;
  source: Record<string, string | null>;
  summary: { raw_rows: number; unique_events: number; duplicate_rows: number; first_sequence: number | null; last_sequence: number | null; last_ingested: string | null };
  events_read: number;
  contiguous_through: number;
  parity: { team_id: string; metric: string; python: number; kql: number | null; match: boolean }[];
  parity_ok: boolean;
}

export async function fetchEventhouseRuns(): Promise<{ runs: { run_id: string; unique_events: number; raw_rows: number; last_ingested: string }[] }> {
  return await getJson('/api/v1/eventhouse/runs', {}, EVENTHOUSE_TIMEOUT_MS) as never;
}

export async function fetchEventhouseRun(runId: string): Promise<EventhouseRunDetail> {
  return await getJson(`/api/v1/eventhouse/runs/${encodeURIComponent(runId)}`, {}, EVENTHOUSE_TIMEOUT_MS) as EventhouseRunDetail;
}

export async function loadFromEventhouse(runId: string, sourceRunId: string): Promise<ReplaySnapshot> {
  return checkSnapshot(await post('/api/v1/replay/eventhouse', { run_id: runId, source_run_id: sourceRunId }, EVENTHOUSE_TIMEOUT_MS));
}

export interface RecapAIStatus { mode: 'off' | 'on'; status: 'off' | 'waiting' | 'pending' | 'ready' | 'fallback'; reason: string | null }
export interface RecapResult { recap: Recap; ai: RecapAIStatus }

/** null means the recap is not available yet (period not started); errors are thrown. */
/**
 * Web PubSub client URL for one source run (GET /api/v1/negotiate). null when the API has no push configured
 * (404, or 503 push_not_configured): the page then stays on polling.
 */
export async function negotiatePush(runId: string): Promise<Negotiated | null> {
  let value: unknown;
  try {
    value = await getJson(`/api/v1/negotiate?run_id=${encodeURIComponent(runId)}`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
    throw error;
  }
  const negotiated = value as Negotiated;
  if (!negotiated || typeof negotiated.url !== 'string' || !/^wss:\/\//.test(negotiated.url) || typeof negotiated.group !== 'string') {
    throw new ApiError('Negotiate response must carry a wss:// url and a group.', 'contract');
  }
  return negotiated;
}

export async function fetchRecap(scope: RecapScope): Promise<RecapResult | null> {
  let value: unknown;
  try {
    value = await getJson(`/api/v1/replay/recap?scope=${scope}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  const result = value as RecapResult;
  if (!result || !validateRecap(result.recap)) throw new ApiError('Recap does not match the wire contract.', 'contract');
  return result;
}
