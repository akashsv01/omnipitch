"""Explicit wire models; JSON Schemas in contracts/ are the reference."""
from datetime import datetime
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

Identifier = Annotated[str, Field(min_length=1)]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RunScoped(WireModel):
    schema_version: Literal["1.0"]
    run_id: Identifier
    match_id: Identifier


class Point(WireModel):
    x: Annotated[float, Field(ge=0, le=105)]
    y: Annotated[float, Field(ge=0, le=68)]


class Event(RunScoped):
    event_id: Identifier
    sequence: Annotated[int, Field(ge=1)]
    period: Literal[1, 2]
    match_time_ms: Annotated[int, Field(ge=0)]
    emitted_at: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")]
    team_id: Identifier
    player_id: Identifier
    possession_id: Identifier
    type: Literal["pass"]
    outcome: Literal["completed"]
    start: Point
    end: Point
    attacking_direction: Literal["positive_x", "negative_x"]
    synthetic: Literal[True]

    @field_validator("emitted_at")
    @classmethod
    def valid_utc_timestamp(cls, value: str) -> str:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value


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
    generation_mode: Literal["fixture"]

    @field_validator("evidence_ids")
    @classmethod
    def unique_evidence(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("evidence_ids must be unique within the run")
        return value


class EventsResponse(WireModel):
    events: list[Event]


class HealthResponse(WireModel):
    status: Literal["ok"] = "ok"
    application: Literal["omnipitch-api"] = "omnipitch-api"


class ReplaySnapshot(WireModel):
    state: MatchState
    events: list[Event]
    total_events: Annotated[int, Field(ge=1, le=1000)]


class ReplayControl(WireModel):
    run_id: Identifier
    action: Literal["play", "pause", "reset"]
