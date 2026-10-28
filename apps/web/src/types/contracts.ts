// Aligned manually with contracts/schemas; fixture checks guard against drift.
export interface RunScoped {
  schema_version: '1.1';
  run_id: string;
  match_id: string;
}
export interface Point { x: number; y: number }
export type EventType = 'pass' | 'shot' | 'tackle' | 'interception' | 'challenge' | 'foul' | 'period_start' | 'period_end';
export type Outcome = 'completed' | 'incomplete' | 'goal' | 'saved' | 'off_target' | 'blocked' | 'won' | 'lost' | 'committed' | 'none';
export type Direction = 'positive_x' | 'negative_x';
export interface Event {
  schema_version: '1.0' | '1.1';
  run_id: string;
  match_id: string;
  event_id: string;
  sequence: number;
  period: 1 | 2;
  match_time_ms: number;
  emitted_at: string;
  team_id: string | null;
  player_id: string | null;
  possession_id: string | null;
  type: EventType;
  outcome: Outcome;
  start: Point | null;
  end: Point | null;
  attacking_direction: Direction | null;
  on_target: boolean | null;
  is_goal: boolean | null;
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
export interface Metric { name: string; value: number; unit: string }
export interface Insight extends RunScoped {
  moment_id: string;
  headline: string;
  casual_text: string;
  analyst_text: string;
  language: 'en';
  evidence_ids: string[];
  metrics: Metric[];
  limitations: string[];
  generation_mode: 'fixture' | 'ai' | 'fallback';
  knowledge_source_ids: string[];
  generation_status?: GenerationStatus | null;
  generation_reason?: string | null;
  /** Server-built Spanish (validated AI translation or the rule-based Spanish story). */
  translations?: { es?: { headline: string; casual_text: string; analyst_text: string; generation_status: GenerationStatus; generation_reason?: string | null } } | null;
}
export type GenerationStatus = 'ai_accepted' | 'rule_based' | 'pending' | 'skipped' | 'rejected' | 'provider_failure' | 'fixture';
export type Rule = 'goal' | 'chance' | 'threat_gain' | 'transition' | 'pressing_change';
export interface Moment {
  moment_id: string;
  run_id: string;
  match_id: string;
  rule: Rule;
  rule_version: string;
  metric_version: string;
  priority: number;
  team_id: string | null;
  player_id: string | null;
  period: 1 | 2;
  match_time_ms: number;
  anchor_sequence: number;
  source_sequence: number;
  replay_ms: number;
  evidence_ids: string[];
  metrics: Metric[];
  facts: Record<string, unknown>;
  limitations: string[];
  insight: Insight;
}
export interface Player { player_id: string; team_id: string; name: string; shirt: number; position: string }
export interface TeamStats {
  team_id: string;
  passes_attempted: number;
  passes_completed: number;
  completion_pct: number | null;
  progression_m: number;
  final_third_entries: number;
  box_entries: number;
  shots: number;
  shots_on_target: number;
  goals: number;
  threat_gained: number;
  defensive_actions: number;
  turnovers_won: number;
  fouls: number;
  pass_share_pct: number | null;
}
export interface PpdaWindow {
  team_id: string;
  period: 1 | 2;
  start_ms: number;
  end_ms: number;
  opponent_passes: number;
  defensive_actions: number;
  value: number | null;
  status: 'ok' | 'insufficient_sample' | 'no_defensive_actions';
  reason: string | null;
  zone: string;
  metric_version: string;
  evidence_ids: string[];
  closed: boolean;
}
export interface MomentumBucket { period: 1 | 2; start_ms: number; end_ms: number; threat: Record<string, number>; shots: Record<string, number> }
export interface PlayerStats {
  player_id: string;
  team_id: string;
  passes: number;
  passes_completed: number;
  progression_m: number;
  threat_gained: number;
  shots: number;
  goals: number;
  defensive_actions: number;
  action_count: number;
  mean_action_location: Point;
}
export interface PassLink { from: string; to: string; count: number }
export interface Analysis {
  metric_version: string;
  grid_version: string;
  through_sequence: number;
  teams: Record<string, TeamStats>;
  ppda_current: Record<string, PpdaWindow>;
  ppda_series: PpdaWindow[];
  momentum: MomentumBucket[];
  players: PlayerStats[];
  pass_network: Record<string, PassLink[]>;
}
export interface ReplayInfo {
  source: 'simulator' | 'upload' | 'eventhouse';
  seed: number | null;
  scenario: string | null;
  speed: Speed;
  elapsed_ms: number;
  duration_ms: number;
  clock_period: 1 | 2;
  clock_ms: number;
  restored: boolean;
  backend_mode: 'local' | 'azure';
  source_run_id: string | null;
  source_detail: string | null;
  roster: Player[];
}
export type Speed = 1 | 5 | 10 | 20 | 40 | 80;
export type Scenario = 'standard' | 'quiet' | 'high_press' | 'late_surge';
export interface InsightSourceStatus {
  mode: 'off' | 'cosmos';
  status: 'off' | 'ok' | 'error';
  source_run_id: string | null;
  narrated: number;
  ai: number;
  rejected: number;
  error: string | null;
  version: string;
}
export interface ReplaySnapshot {
  state: MatchState;
  events: Event[];
  events_offset: number;
  total_events: number;
  replay: ReplayInfo;
  insights: InsightSourceStatus;
  analysis: Analysis;
  moments: Moment[];
}
export interface EventsResponse { events: Event[] }
export interface LedgerSummary {
  run_id: string;
  received: number;
  unique_events: number;
  duplicates_ignored: number;
  conflicts_rejected: number;
  invalid_rejected: number;
  latest_sequence: number;
  missing_sequences: number;
}
export interface IngestResult {
  accepted: number;
  duplicates: number;
  conflicts: number;
  rejected: { line: number; event_id: string | null; code: string; message: string }[];
  ledger: LedgerSummary;
}
export type RecapScope = 'first_half' | 'full_time';
export interface RecapKeyMoment {
  moment_id: string; rule: Rule; clock: string; team_id: string | null; headline: string;
  generation_mode: 'fixture' | 'ai' | 'fallback'; source_sequence: number; replay_ms: number;
}
export interface Recap {
  /** Language of the recap text; names, scores and units are not translated. Absent means English. */
  language?: 'en' | 'es';
  /** Team numbers at the recap's cutoff. */
  stats?: { home: RecapStats; away: RecapStats } | null;
  /** Goals with the score after each, whether the leader came from behind, the deciding goal, shots per half. */
  story?: { goals: RecapGoal[]; leader: string | null; came_from_behind: boolean; decisive_goal: RecapGoal | null;
    shots_by_half: { first: { home: number; away: number }; second: { home: number; away: number } } | null } | null;
  schema_version: '1.1';
  run_id: string;
  match_id: string;
  scope: RecapScope;
  status: 'provisional' | 'final';
  through_sequence: number;
  clock: string;
  score: { home: number; away: number };
  headline: string;
  summary: string;
  key_moments: RecapKeyMoment[];
  tactical_trend: { supported: boolean; metric: 'ppda' | null; text: string; values: Record<string, unknown> | null };
  player_focus: { player_id: string; name: string; team_id: string; text: string; metrics: Metric[] } | null;
  sources: string[];
  generation_mode: 'ai' | 'fallback';
  limitations: string[];
  recap_version: string;
}
export interface RecapStats {
  goals: number; shots: number; shots_on_target: number; box_entries: number; final_third_entries: number;
  progression_m: number; completion_pct: number | null; pass_share_pct: number | null; turnovers_won: number;
}

export interface RecapGoal { team_id: string; player_id: string | null; period: number; clock: string; sequence: number; score: { home: number; away: number } }
