"""Single-process local replay; elapsed time is authoritative on the API."""
from bisect import bisect_right
from threading import RLock
from time import monotonic
from uuid import uuid4
import json

from fastapi import HTTPException
from pydantic import ValidationError

from .sample_data import sample_events, sample_state
from .schemas import Event, ReplaySnapshot


def replay_error(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def parse_jsonl(text: str) -> list[Event]:
    """Validate the entire input before replacing a run. File order is immaterial."""
    events = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if len(events) == 1000:
            raise replay_error("too_many_events", "Replay is limited to 1000 events.")
        try:
            event = Event.model_validate(json.loads(line))
        except (ValueError, ValidationError):
            raise replay_error("invalid_event", f"Invalid JSON or event contract on line {line_number}.")
        events.append(event)
    if not events:
        raise replay_error("empty_replay", "Choose a JSONL file containing at least one event.")
    source = (events[0].run_id, events[0].match_id)
    if any((event.run_id, event.match_id) != source for event in events):
        raise replay_error("mixed_runs", "All events must belong to one source run and match.")
    if source[1] != "demo" or any(event.team_id not in {"harbor", "vale"} for event in events):
        raise replay_error("unsupported_match", "This local replay supports match demo and teams harbor/vale only.")
    if len({event.event_id for event in events}) != len(events):
        raise replay_error("duplicate_event", "Event IDs must be unique within the source run.")
    events.sort(key=lambda event: event.sequence)
    for index, event in enumerate(events):
        if event.sequence != index + 1:
            raise replay_error("invalid_sequence", "Sequences must be contiguous, starting at 1.")
        if index:
            previous = events[index - 1]
            if event.period < previous.period or (event.period == previous.period and event.match_time_ms < previous.match_time_ms):
                raise replay_error("invalid_clock", "Match time must not decrease within a period; periods must be ordered.")
    return events


class ReplayStore:
    def __init__(self, clock=monotonic):
        self.clock = clock
        self.lock = RLock()
        self._replace(sample_events())

    def _replace(self, source: list[Event]) -> None:
        self.source = source
        run_id = f"replay-{uuid4()}"
        self.events = [event.model_copy(update={"run_id": run_id}) for event in source]
        self.state = sample_state().model_copy(update={
            "run_id": run_id, "state_version": 1, "period": source[0].period,
            "match_time_ms": 0, "latest_event_sequence": 0, "replay_status": "paused",
        })
        # A new period follows the previous period's last event; no invented halftime delay.
        self.schedule = []
        offset = 0
        previous = None
        for event in self.events:
            if previous and previous.period != event.period:
                offset += previous.match_time_ms
            self.schedule.append(offset + event.match_time_ms)
            previous = event
        self.elapsed_ms = 0.0
        self.started_at = None

    def _advance(self) -> None:
        if self.started_at is None:
            return
        elapsed = self.elapsed_ms + max(0, self.clock() - self.started_at) * 1000
        count = bisect_right(self.schedule, elapsed)
        finished = count == len(self.events)
        if count != self.state.latest_event_sequence or finished:
            latest = self.events[count - 1] if count else None
            self.state = self.state.model_copy(update={
                "state_version": self.state.state_version + 1,
                "latest_event_sequence": count,
                "period": latest.period if latest else self.state.period,
                "match_time_ms": latest.match_time_ms if latest else 0,
                "replay_status": "finished" if finished else "playing",
            })
        if finished:
            self.elapsed_ms = float(self.schedule[-1])
            self.started_at = None

    def _snapshot(self) -> ReplaySnapshot:
        self._advance()
        return ReplaySnapshot(state=self.state, events=self.events[:self.state.latest_event_sequence], total_events=len(self.events))

    def snapshot(self) -> ReplaySnapshot:
        with self.lock:
            return self._snapshot()

    def _check_run(self, run_id: str) -> None:
        if self.state.run_id != run_id:
            raise replay_error("stale_run", "Replay changed. Refresh before controlling it.", 409)

    def load(self, text: str, run_id: str) -> ReplaySnapshot:
        source = parse_jsonl(text)
        with self.lock:
            self._check_run(run_id)
            self._replace(source)
            return self._snapshot()

    def control(self, action: str, run_id: str) -> ReplaySnapshot:
        with self.lock:
            self._check_run(run_id)
            self._advance()
            if action == "reset":
                self._replace(self.source)
            elif action == "play" and self.state.replay_status == "paused":
                self.started_at = self.clock()
                self.state = self.state.model_copy(update={"state_version": self.state.state_version + 1, "replay_status": "playing"})
            elif action == "pause" and self.state.replay_status == "playing":
                self.elapsed_ms += max(0, self.clock() - self.started_at) * 1000
                self.started_at = None
                self.state = self.state.model_copy(update={"state_version": self.state.state_version + 1, "replay_status": "paused"})
            return self._snapshot()


replay_store = ReplayStore()
