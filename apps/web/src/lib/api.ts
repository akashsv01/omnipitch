import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import eventSchema from '../../../../contracts/schemas/event.schema.json';
import stateSchema from '../../../../contracts/schemas/match-state.schema.json';
import type { Event, MatchState } from '../types/contracts';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
const ajv = new Ajv2020();
addFormats(ajv);
const validateState = ajv.compile<MatchState>(stateSchema);
const validateEvent = ajv.compile<Event>(eventSchema);

export class ApiError extends Error {
  constructor(message: string, public readonly kind: 'network' | 'http' | 'contract', public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { signal: signal ?? AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError(`Cannot reach API at ${API_BASE_URL}. Check that FastAPI is running and CORS is configured.`, 'network');
  }
  if (!response.ok) throw new ApiError(`API returned HTTP ${response.status}`, 'http', response.status);
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
