/** Broadcast cue and feed shapes (contracts/schemas/broadcast-cue.schema.json). The playout itself runs on the
 * server (services/api/app/broadcast.py, GET /api/v1/broadcast), so every screen shows the same cue. */
import type { Moment, Rule } from '../types/contracts';
import type { Audience, Language } from './prefs';

export interface Cue {
  schema_version: 'broadcast-cue-1.0';
  message_id: string;
  revision: number;
  revision_reason: 'template' | 'ai_accepted';
  run_id: string;
  match_id: string;
  moment_id: string;
  rule: Rule;
  kind: 'major' | 'standard';
  match_clock: { period: 1 | 2; match_time_ms: number; label: string };
  replay_ms: number;
  evidence_cutoff_sequence: number;
  source_ids: string[];
  audience: Audience;
  language: Language;
  headline: string;
  text: string;
  measurements: { label: string; value: string; unit?: string }[];
  priority: number;
  display_ms: number;
  stale_after_match_ms: number;
  generation_status: NonNullable<Moment['insight']['generation_status']>;
  validation: 'passed' | 'not_applicable';
  synthetic: true;
}

export interface Feed {
  schema_version: 'broadcast-feed-1.0';
  run_id: string;
  audience: Audience;
  language: Language;
  position: { sequence: number; replay_ms: number; clock: string };
  on_air: Cue | null;
  on_air_for_ms: number | null;
  queue: Cue[];
  log: { at_ms: number; message_id: string; clock: string; headline: string; event: string; revision: number }[];
}
