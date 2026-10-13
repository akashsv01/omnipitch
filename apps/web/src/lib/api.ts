import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import eventSchema from '../../../../contracts/schemas/event.schema.json';
import stateSchema from '../../../../contracts/schemas/match-state.schema.json';
import replaySchema from '../../../../contracts/schemas/replay.schema.json';
import type { Event, MatchState, ReplaySnapshot } from '../types/contracts';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const ajv = new Ajv2020();
addFormats(ajv);
const validateState = ajv.compile<MatchState>(stateSchema);
const validateEvent = ajv.compile<Event>(eventSchema);
const validateReplay = ajv.compile<ReplaySnapshot>(replaySchema);

export class ApiError extends Error {
  constructor(message: string, public readonly kind: 'network' | 'http' | 'contract', public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson(path: string, signal?: AbortSignal, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...options, signal: signal ?? AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError(`Cannot reach API at ${API_BASE_URL}. Check that FastAPI is running and CORS is configured.`, 'network');
  }
  if (!response.ok) {
    let message = `API returned HTTP ${response.status}`;
    try {
      const error = await response.json();
      if (typeof error?.detail?.message === 'string') message = error.detail.message;
    } catch { /* Preserve HTTP status for a non-JSON response. */ }
    throw new ApiError(message, 'http', response.status);
  }
  try { return await response.json(); }
  catch { throw new ApiError('API returned invalid JSON.', 'contract'); }
}

export async function fetchDemo(): Promise<{ state: MatchState; events: Event[] }> {
  const [state, response] = await Promise.all([
    getJson('/api/v1/matches/demo/state'), getJson('/api/v1/matches/demo/events'),
  ]);
  if (!validateState(state)) throw new ApiError('Match state does not match the wire contract.', 'contract');
  if (typeof response !== 'object' || response === null || !('events' in response) || !Array.isArray(response.events)) {
    throw new ApiError('Events response does not contain an events array.', 'contract');
  }
  const events: Event[] = [];
  for (const event of response.events) {
    if (!validateEvent(event)) throw new ApiError('An event does not match the wire contract.', 'contract');
    if (event.run_id !== state.run_id || event.match_id !== state.match_id) {
      throw new ApiError('State and events refer to different replay runs.', 'contract');
    }
    events.push(event);
  }
  return { state, events };
}

function replaySnapshot(value: unknown): ReplaySnapshot {
  if (!validateReplay(value)) throw new ApiError('Replay response does not match the wire contract.', 'contract');
  if (value.events.length !== value.state.latest_event_sequence || value.events.length > value.total_events) {
    throw new ApiError('Replay progress is inconsistent.', 'contract');
  }
  for (const [index, event] of value.events.entries()) {
    if (event.run_id !== value.state.run_id || event.match_id !== value.state.match_id || event.sequence !== index + 1) {
      throw new ApiError('Replay event ordering or identity is inconsistent.', 'contract');
    }
  }
  return value;
}

export async function fetchReplay(): Promise<ReplaySnapshot> {
  return replaySnapshot(await getJson('/api/v1/replay'));
}

export async function controlReplay(runId: string, action: 'play' | 'pause' | 'reset'): Promise<ReplaySnapshot> {
  return replaySnapshot(await getJson('/api/v1/replay/control', undefined, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, action }),
  }));
}

export async function loadReplay(runId: string, file: File): Promise<ReplaySnapshot> {
  if (file.size > 1_048_576) throw new ApiError('JSONL files must be at most 1 MiB.', 'contract');
  return replaySnapshot(await getJson(`/api/v1/replay/load?run_id=${encodeURIComponent(runId)}`, undefined, {
    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: file,
  }));
}
