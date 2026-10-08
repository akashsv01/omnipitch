// Aligned manually with contracts/schemas; fixture checks guard against drift.
export interface RunScoped {
  schema_version: '1.0';
  run_id: string;
  match_id: string;
}
export interface Point { x: number; y: number }
export interface Event extends RunScoped {
  event_id: string;
  sequence: number;
  period: 1 | 2;
  match_time_ms: number;
  emitted_at: string;
  team_id: string;
  player_id: string;
  possession_id: string;
  type: 'pass';
  outcome: 'completed';
  start: Point;
  end: Point;
  attacking_direction: 'positive_x' | 'negative_x';
  synthetic: true;
}
export interface MatchState extends RunScoped {
  state_version: number;
  period: 1 | 2;
  match_time_ms: number;
  home_team: { id: string; name: string };
  away_team: { id: string; name: string };
  score: { home: number; away: number };
  latest_event_sequence: number;
  replay_status: 'paused' | 'playing' | 'finished';
  synthetic: true;
}
export interface Insight extends RunScoped {
  moment_id: string;
  headline: string;
  casual_text: string;
  analyst_text: string;
  language: 'en';
  evidence_ids: string[];
  metrics: { name: string; value: number; unit: string }[];
  limitations: string[];
  generation_mode: 'fixture';
}
export interface EventsResponse { events: Event[] }
