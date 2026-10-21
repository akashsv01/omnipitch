"""Explicit wire models; JSON Schemas in contracts/ are the reference."""
from datetime import datetime
from typing import Annotated, Any, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Identifier = Annotated[str, Field(min_length=1)]
EventType = Literal["pass", "shot", "tackle", "interception", "challenge", "foul", "period_start", "period_end"]
Outcome = Literal["completed", "incomplete", "goal", "saved", "off_target", "blocked", "won", "lost", "committed", "none"]
Direction = Literal["positive_x", "negative_x"]
SCENARIOS = ("standard", "quiet", "high_press")
SPEEDS = (1, 5, 10, 20, 40, 80)
MAX_EVENTS = 2500

ALLOWED_OUTCOMES = {
    "pass": {"completed", "incomplete"}, "shot": {"goal", "saved", "off_target", "blocked"},
    "tackle": {"won", "lost"}, "challenge": {"won", "lost"}, "interception": {"won"}, "foul": {"committed"},
    "period_start": {"none"}, "period_end": {"none"},
}


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RunScoped(WireModel):
    schema_version: Literal["1.1"]
    run_id: Identifier
    match_id: Identifier


class Point(WireModel):
    x: Annotated[float, Field(ge=0, le=105)]
    y: Annotated[float, Field(ge=0, le=68)]


class Event(WireModel):
    schema_version: Literal["1.0", "1.1"]
    run_id: Identifier
    match_id: Identifier
    event_id: Identifier
    sequence: Annotated[int, Field(ge=1)]
    period: Literal[1, 2]
    match_time_ms: Annotated[int, Field(ge=0)]
    emitted_at: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")]
    team_id: Identifier | None = None
    player_id: Identifier | None = None
    possession_id: Identifier | None = None
    type: EventType
    outcome: Outcome
    start: Point | None = None
    end: Point | None = None
    attacking_direction: Direction | None = None
    on_target: bool | None = None
    is_goal: bool | None = None
    synthetic: Literal[True]

    @field_validator("emitted_at")
    @classmethod
    def valid_utc_timestamp(cls, value: str) -> str:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @model_validator(mode="after")
    def consistent_type(self) -> "Event":
        if self.schema_version == "1.0" and (self.type, self.outcome) != ("pass", "completed"):
            raise ValueError("schema 1.0 supports completed passes only")
        if self.outcome not in ALLOWED_OUTCOMES[self.type]:
            raise ValueError(f"outcome {self.outcome} is not valid for {self.type}")
        administrative = self.type in ("period_start", "period_end")
        located = (self.team_id, self.player_id, self.possession_id, self.start, self.attacking_direction)
        if administrative and any(value is not None for value in (*located, self.end, self.on_target, self.is_goal)):
            raise ValueError("period markers carry no team, player or location")
        if not administrative and any(value is None for value in located):
            raise ValueError("team actions need team, player, possession, start and attacking direction")
        if self.type in ("pass", "shot") and self.end is None:
            raise ValueError(f"{self.type} needs an end point")
        if self.type not in ("pass", "shot") and self.end is not None:
            raise ValueError(f"{self.type} has no end point")
        if self.type == "shot":
            expected = {"goal": (True, True), "saved": (True, False)}.get(self.outcome, (False, False))
            if (self.on_target, self.is_goal) != expected:
                raise ValueError("shot on_target/is_goal disagree with outcome")
        elif self.on_target is not None or self.is_goal is not None:
            raise ValueError("on_target/is_goal apply to shots only")
        return self


class Team(WireModel):
    id: Identifier
    name: Identifier


class Score(WireModel):
    home: Annotated[int, Field(ge=0)]
    away: Annotated[int, Field(ge=0)]


class MatchState(RunScoped):
    state_version: Annotated[int, Field(ge=1)]
    period: Literal[1, 2]
    match_time_ms: Annotated[int, Field(ge=0)]
    home_team: Team
    away_team: Team
    score: Score
    latest_event_sequence: Annotated[int, Field(ge=0)]
    replay_status: Literal["paused", "playing", "finished"]
    synthetic: Literal[True]


class Metric(WireModel):
    name: Identifier
    value: float
    unit: Identifier


class Insight(RunScoped):
    moment_id: Identifier
    headline: Identifier
    casual_text: Identifier
    analyst_text: Identifier
    language: Literal["en"]
    evidence_ids: Annotated[list[Identifier], Field(min_length=1)]
    metrics: list[Metric]
    limitations: Annotated[list[Identifier], Field(min_length=1)]
    generation_mode: Literal["fixture", "ai", "fallback"]
    knowledge_source_ids: list[Identifier] = []

    @field_validator("evidence_ids")
    @classmethod
    def unique_evidence(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("evidence_ids must be unique within the run")
        return value


class Moment(WireModel):
    moment_id: Identifier
    run_id: Identifier
    match_id: Identifier
    rule: Literal["goal", "chance", "threat_gain", "transition", "pressing_change"]
    rule_version: Identifier
    metric_version: Identifier
    priority: Annotated[int, Field(ge=1, le=3)]
    team_id: Identifier | None
    player_id: Identifier | None
    period: Literal[1, 2]
    match_time_ms: Annotated[int, Field(ge=0)]
    anchor_sequence: Annotated[int, Field(ge=1)]
    source_sequence: Annotated[int, Field(ge=1)]
    replay_ms: Annotated[int, Field(ge=0)]
    evidence_ids: Annotated[list[Identifier], Field(min_length=1)]
    metrics: list[Metric]
    facts: dict[str, Any]
    limitations: Annotated[list[Identifier], Field(min_length=1)]
    insight: Insight


class Player(WireModel):
    player_id: Identifier
    team_id: Identifier
    name: Identifier
    shirt: Annotated[int, Field(ge=1, le=99)]
    position: Identifier


class TeamStats(WireModel):
    team_id: Identifier
    passes_attempted: int
    passes_completed: int
    completion_pct: float | None
    progression_m: float
    final_third_entries: int
    box_entries: int
    shots: int
    shots_on_target: int
    goals: int
    threat_gained: float
    defensive_actions: int
    turnovers_won: int
    fouls: int
    pass_share_pct: float | None


class PpdaWindow(WireModel):
    team_id: Identifier
    period: Literal[1, 2]
    start_ms: int
    end_ms: int
    opponent_passes: int
    defensive_actions: int
    value: float | None
    status: Literal["ok", "insufficient_sample", "no_defensive_actions"]
    reason: str | None
    zone: Identifier
    metric_version: Identifier
    evidence_ids: list[Identifier]
    closed: bool


class MomentumBucket(WireModel):
    period: Literal[1, 2]
    start_ms: int
    end_ms: int
    threat: dict[str, float]
    shots: dict[str, int]


class PlayerStats(WireModel):
    player_id: Identifier
    team_id: Identifier
    passes: int
    passes_completed: int
    progression_m: float
    threat_gained: float
    shots: int
    goals: int
    defensive_actions: int
    action_count: int
    mean_action_location: Point


class PassLink(WireModel):
    from_: Identifier = Field(alias="from")
    to: Identifier
    count: int
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True, serialize_by_alias=True)


class Analysis(WireModel):
    metric_version: Identifier
    grid_version: Identifier
    through_sequence: Annotated[int, Field(ge=0)]
    teams: dict[str, TeamStats]
    ppda_current: dict[str, PpdaWindow]
    ppda_series: list[PpdaWindow]
    momentum: list[MomentumBucket]
    players: list[PlayerStats]
    pass_network: dict[str, list[PassLink]]


class ReplayInfo(WireModel):
    source: Literal["simulator", "upload", "eventhouse"]
    seed: int | None
    scenario: Identifier | None
    speed: Literal[1, 5, 10, 20, 40, 80]
    elapsed_ms: Annotated[int, Field(ge=0)]
    duration_ms: Annotated[int, Field(ge=0)]
    clock_period: Literal[1, 2]
    clock_ms: Annotated[int, Field(ge=0)]
    restored: bool
    backend_mode: Literal["local", "azure"]
    source_run_id: Identifier | None
    source_detail: str | None
    roster: list[Player]


class InsightSourceStatus(WireModel):
    mode: Literal["off", "cosmos"]
    status: Literal["off", "ok", "error"]
    source_run_id: Identifier | None
    narrated: Annotated[int, Field(ge=0)]
    ai: Annotated[int, Field(ge=0)]
    rejected: Annotated[int, Field(ge=0)]
    error: str | None
    version: Identifier


class ReplaySnapshot(WireModel):
    state: MatchState
    events: list[Event]
    events_offset: Annotated[int, Field(ge=0)]
    total_events: Annotated[int, Field(ge=1, le=MAX_EVENTS)]
    replay: ReplayInfo
    insights: InsightSourceStatus
    analysis: Analysis
    moments: list[Moment]


class EventsResponse(WireModel):
    events: list[Event]


class EventPage(WireModel):
    run_id: Identifier
    events: list[Event]
    next_after: int | None


class HealthResponse(WireModel):
    status: Literal["ok"] = "ok"
    application: Literal["omnipitch-api"] = "omnipitch-api"


class ReadyResponse(WireModel):
    status: Literal["ready"] = "ready"
    mode: Literal["local", "azure"]
    database: Literal["ok"] = "ok"
    analytics: Literal["python-adapter-local", "python-adapter-over-eventhouse"]
    narration: Literal["fallback-only"] = "fallback-only"
    eventhouse: dict | None = None


class EventhouseLoad(WireModel):
    run_id: Identifier
    source_run_id: Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")]


class ReplayControl(WireModel):
    run_id: Identifier
    action: Literal["play", "pause", "reset", "speed", "seek"]
    speed: Literal[1, 5, 10, 20, 40, 80] | None = None
    elapsed_ms: Annotated[int, Field(ge=0)] | None = None


class GenerateRequest(WireModel):
    run_id: Identifier
    seed: Annotated[int, Field(ge=0, le=2_147_483_647)]
    scenario: Literal["standard", "quiet", "high_press"]


class IngestRejection(WireModel):
    line: int
    event_id: str | None
    code: Identifier
    message: Identifier


class LedgerSummary(WireModel):
    run_id: Identifier
    received: int
    unique_events: int
    duplicates_ignored: int
    conflicts_rejected: int
    invalid_rejected: int
    latest_sequence: int
    missing_sequences: int


class IngestResult(WireModel):
    accepted: int
    duplicates: int
    conflicts: int
    rejected: list[IngestRejection]
    ledger: LedgerSummary


class RecapKeyMoment(WireModel):
    moment_id: Identifier
    rule: Literal["goal", "chance", "threat_gain", "transition", "pressing_change"]
    clock: str
    team_id: Identifier | None
    headline: Identifier
    generation_mode: Literal["fixture", "ai", "fallback"]
    source_sequence: Annotated[int, Field(ge=1)]
    replay_ms: Annotated[int, Field(ge=0)]


class RecapTrend(WireModel):
    supported: bool
    metric: Literal["ppda"] | None
    text: Identifier
    values: dict[str, Any] | None


class RecapPlayerFocus(WireModel):
    player_id: Identifier
    name: Identifier
    team_id: Identifier
    text: Identifier
    metrics: list[Metric]


class Recap(WireModel):
    schema_version: Literal["1.1"]
    run_id: Identifier
    match_id: Identifier
    scope: Literal["first_half", "full_time"]
    status: Literal["provisional", "final"]
    through_sequence: Annotated[int, Field(ge=1)]
    clock: str
    score: Score
    headline: Annotated[str, Field(min_length=1, max_length=90)]
    summary: Annotated[str, Field(min_length=1, max_length=600)]
    key_moments: Annotated[list[RecapKeyMoment], Field(max_length=3)]
    tactical_trend: RecapTrend
    player_focus: RecapPlayerFocus | None
    sources: list[Identifier]
    generation_mode: Literal["ai", "fallback"]
    limitations: Annotated[list[Identifier], Field(min_length=1)]
    recap_version: Identifier


class RecapAIStatus(WireModel):
    mode: Literal["off", "on"]
    status: Literal["off", "waiting", "pending", "ready", "fallback"]
    reason: str | None


class RecapPeriodReconciliation(WireModel):
    period: Literal[1, 2]
    status: Literal["pending", "reconciled", "mismatch", "differs"]
    through_sequence: int | None
    reconciled_at: str | None
    mismatches: int | None


class RecapReconciliation(WireModel):
    mode: Literal["off", "cosmos"]
    status: Literal["off", "not_applicable", "pending", "reconciled", "mismatch", "differs", "error"]
    periods: list[RecapPeriodReconciliation]
    error: str | None


class RecapResponse(WireModel):
    recap: Recap
    ai: RecapAIStatus
    reconciliation: RecapReconciliation
