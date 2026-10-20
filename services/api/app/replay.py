"""Single-process local replay; elapsed time is authoritative on the API.

Revealed events flow into the SQLite ledger (idempotent by run/event identity), analysis is
computed from the revealed prefix, and detected moments are created conditionally. Replay
position is persisted, so restarting the API restores the run paused at the same point.
"""
from bisect import bisect_right
import json
from threading import RLock
from time import monotonic
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError

from .analysis import analyse, moments_with_insights
from .db import Database
from .insight_overlay import InsightOverlay
from .sample_data import AWAY, HOME, roster, sample_state, simulate_match
from .schemas import MAX_EVENTS, SPEEDS, Event, ReplaySnapshot

DEFAULT_SEED = 7
DEFAULT_SCENARIO = "standard"
DEFAULT_SPEED = 20
KNOWN_TEAMS = {HOME["id"], AWAY["id"]}


def replay_error(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def parse_events(text: str) -> tuple[list[Event], list[dict]]:
    """Parse JSONL leniently: returns valid events and per-line rejections."""
    events, rejected = [], []
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if len(events) + len(rejected) >= MAX_EVENTS:
            raise replay_error("too_many_events", f"Input is limited to {MAX_EVENTS} events.")
        event_id = None
        try:
            raw = json.loads(line)
            event_id = raw.get("event_id") if isinstance(raw, dict) else None
            events.append(Event.model_validate(raw))
        except (ValueError, ValidationError) as exc:
            message = exc.errors()[0]["msg"] if isinstance(exc, ValidationError) else "Invalid JSON."
            rejected.append({"line": line_number, "event_id": event_id if isinstance(event_id, str) else None,
                             "code": "invalid_event", "message": f"Line {line_number}: {message}", "payload": line[:2000]})
    return events, rejected


def parse_jsonl(text: str) -> list[Event]:
    """Validate the entire input before replacing a run. File order is immaterial."""
    events, rejected = parse_events(text)
    if rejected:
        raise replay_error("invalid_event", f"Invalid JSON or event contract on line {rejected[0]['line']}.")
    if not events:
        raise replay_error("empty_replay", "Choose a JSONL file containing at least one event.")
    source = (events[0].run_id, events[0].match_id)
    if any((event.run_id, event.match_id) != source for event in events):
        raise replay_error("mixed_runs", "All events must belong to one source run and match.")
    if any(event.team_id is not None and event.team_id not in KNOWN_TEAMS for event in events):
        raise replay_error("unsupported_match", "This local replay supports teams harbor and vale only.")
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
    def __init__(self, clock=monotonic, db: Database | None = None, source: list[Event] | None = None,
                 backend_mode: str = "local", overlay: InsightOverlay | None = None):
        self.clock = clock
        self.backend_mode = backend_mode
        self.overlay = overlay or InsightOverlay(None)
        self.lock = RLock()
        self.db = db or Database()
        self._cache: tuple | None = None
        self.restored = False
        if source is not None:
            self._replace(source, {"source": "upload", "seed": None, "scenario": None})
        elif not self._restore():
            self._replace(self._simulate(DEFAULT_SEED, DEFAULT_SCENARIO),
                          {"source": "simulator", "seed": DEFAULT_SEED, "scenario": DEFAULT_SCENARIO})

    @staticmethod
    def _simulate(seed: int, scenario: str) -> list[Event]:
        return [Event.model_validate(e) for e in simulate_match(seed, scenario, run_id=f"sim-{seed}-{scenario}")]

    # Run lifecycle --------------------------------------------------------
    def _replace(self, source: list[Event], meta: dict, run_id: str | None = None, speed: int = DEFAULT_SPEED) -> None:
        self.source = source
        self.meta = meta
        run_id = run_id or f"replay-{uuid4()}"
        self.events = [event.model_copy(update={"run_id": run_id}) for event in source]
        self.dicts = [event.model_dump(mode="json") for event in self.events]
        first = self.events[0]
        self.state = sample_state().model_copy(update={
            "schema_version": "1.1", "run_id": run_id, "match_id": first.match_id, "state_version": 1,
            "period": first.period, "match_time_ms": 0, "latest_event_sequence": 0, "replay_status": "paused",
        })
        # A new period follows the previous period's last event; no invented halftime delay.
        self.schedule, self.period_offset = [], {first.period: 0}
        offset, previous = 0, None
        for event in self.events:
            if previous and previous.period != event.period:
                offset += previous.match_time_ms
                self.period_offset[event.period] = offset
            self.schedule.append(offset + event.match_time_ms)
            previous = event
        self.speed = speed
        self.elapsed_ms = 0.0
        self.started_at = None
        self.ingested_through = 0
        self._cache = None
        self.db.save_run(run_id, first.match_id, meta, [e.model_dump(mode="json") for e in source])
        self._persist()

    def _persist(self) -> None:
        self.db.save_replay_state(self.state.run_id, {
            "elapsed_ms": self._elapsed(), "speed": self.speed, "status": self.state.replay_status,
            "state_version": self.state.state_version, "meta": self.meta})

    def _restore(self) -> bool:
        saved = self.db.load_replay_state()
        if not saved:
            return False
        run_id = self.db.connection.execute("SELECT run_id FROM replay_state WHERE id = 1").fetchone()[0]
        loaded = self.db.load_run(run_id)
        if loaded is None:
            return False
        meta, source = loaded
        try:
            events = [Event.model_validate(e) for e in source]
        except ValidationError:
            return False
        self._replace(events, meta, run_id=run_id, speed=saved["speed"])
        self.ingested_through = self.db.ledger_summary(run_id)["latest_sequence"]
        self.elapsed_ms = float(saved["elapsed_ms"])
        self._reveal(int(self.elapsed_ms), "finished" if saved["status"] == "finished" else "paused",
                     version=saved["state_version"] + 1)
        self.restored = True
        self._persist()
        return True

    # Clock ----------------------------------------------------------------
    def _elapsed(self) -> float:
        running = (self.clock() - self.started_at) * 1000 * self.speed if self.started_at is not None else 0
        return min(self.elapsed_ms + max(0, running), float(self.schedule[-1]))

    def _reveal(self, elapsed: float, status: str, version: int | None = None) -> None:
        count = bisect_right(self.schedule, elapsed)
        latest = self.events[count - 1] if count else None
        self.state = self.state.model_copy(update={
            "state_version": version or self.state.state_version + 1,
            "latest_event_sequence": count,
            "period": latest.period if latest else self.events[0].period,
            "match_time_ms": latest.match_time_ms if latest else 0,
            "score": self._score(count), "replay_status": status,
        })
        if count > self.ingested_through:
            self.db.ingest(self.state.run_id, self.dicts[self.ingested_through:count])
            self.ingested_through = count

    def _score(self, count: int) -> dict:
        home = away = 0
        for event in self.events[:count]:
            if event.type == "shot" and event.is_goal:
                home += event.team_id == HOME["id"]
                away += event.team_id == AWAY["id"]
        return self.state.score.model_copy(update={"home": home, "away": away})

    def _advance(self) -> None:
        if self.started_at is None:
            return
        elapsed = self._elapsed()
        count = bisect_right(self.schedule, elapsed)
        finished = count == len(self.events)
        if count != self.state.latest_event_sequence or finished:
            self._reveal(elapsed, "finished" if finished else "playing")
            if finished:
                self.elapsed_ms = float(self.schedule[-1])
                self.started_at = None
            self._persist()

    # Snapshot -------------------------------------------------------------
    def _analysis(self) -> tuple[dict, list[dict]]:
        count = self.state.latest_event_sequence
        key = (self.state.run_id, count)
        if self._cache and self._cache[0] == key:
            return self._cache[1], self._cache[2]
        revealed = self.dicts[:count]
        moments = moments_with_insights(revealed, self.state.run_id, self.state.match_id)
        self.db.save_moments(self.state.run_id, moments)
        # Serve stored moments: evidence frozen at detection time stays authoritative.
        stored = self.db.moments(self.state.run_id, through_sequence=count)
        for moment in stored:
            moment["replay_ms"] = self.schedule[moment["source_sequence"] - 1]
        analysis = analyse(revealed)
        self._cache = (key, analysis, stored)
        return analysis, stored

    def _snapshot(self, run_id: str | None = None, after_sequence: int = 0) -> ReplaySnapshot:
        self._advance()
        count = self.state.latest_event_sequence
        offset = after_sequence if run_id == self.state.run_id and 0 <= after_sequence <= count else 0
        analysis, moments = self._analysis()
        moments, insights = self.overlay.apply(moments, self.dicts[:count], self.meta.get("source_run_id"))
        elapsed = self._elapsed()
        latest = self.events[count - 1] if count else self.events[0]
        clock_period = latest.period
        clock_ms = max(latest.match_time_ms if count else 0, int(elapsed - self.period_offset.get(clock_period, 0)))
        if count < len(self.events) and self.events[count].period != clock_period and latest.type == "period_end":
            clock_ms = latest.match_time_ms
        return ReplaySnapshot.model_validate({
            "state": self.state.model_dump(mode="json"),
            "events": self.dicts[offset:count], "events_offset": offset, "total_events": len(self.events),
            "replay": {"source": self.meta["source"], "seed": self.meta.get("seed"), "scenario": self.meta.get("scenario"),
                       "speed": self.speed, "elapsed_ms": int(elapsed), "duration_ms": self.schedule[-1],
                       "clock_period": clock_period, "clock_ms": clock_ms, "restored": self.restored,
                       "backend_mode": self.backend_mode, "source_run_id": self.meta.get("source_run_id"),
                       "source_detail": self.meta.get("detail"),
                       "roster": [{k: p[k] for k in ("player_id", "team_id", "name", "shirt", "position")} for p in roster()]},
            "insights": insights,
            "analysis": analysis, "moments": [m for m in moments if m["source_sequence"] > offset],
        }, strict=False)

    def recap_inputs(self) -> tuple[list[dict], list[dict]]:
        """Revealed events and verified moments (with narrated insights where valid), for recaps."""
        with self.lock:
            self._advance()
            count = self.state.latest_event_sequence
            _, moments = self._analysis()
            moments, _ = self.overlay.apply(moments, self.dicts[:count], self.meta.get("source_run_id"))
            return self.dicts[:count], moments

    def snapshot(self, run_id: str | None = None, after_sequence: int = 0) -> ReplaySnapshot:
        with self.lock:
            return self._snapshot(run_id, after_sequence)

    # Commands -------------------------------------------------------------
    def _check_run(self, run_id: str) -> None:
        if self.state.run_id != run_id:
            raise replay_error("stale_run", "Replay changed. Refresh before controlling it.", 409)

    def load(self, text: str, run_id: str) -> ReplaySnapshot:
        source = parse_jsonl(text)
        with self.lock:
            self._check_run(run_id)
            # Keep the file's own run ID as the source, so narrated insights for that run can be shown.
            self._replace(source, {"source": "upload", "seed": None, "scenario": None,
                                   "source_run_id": source[0].run_id}, speed=self.speed)
            self.restored = False
            return self._snapshot()

    def load_eventhouse(self, run_id: str, source_run_id: str, events: list[dict], detail: str) -> ReplaySnapshot:
        """Replace the replay with deduplicated Eventhouse rows, keeping the cloud run_id as the replay identity."""
        if not events:
            raise replay_error("empty_run", f"Eventhouse has no events for run {source_run_id}.", 404)
        source = parse_jsonl("\n".join(json.dumps(event) for event in events))
        if any(event.run_id != source_run_id for event in source):
            raise replay_error("mixed_runs", "Eventhouse returned rows from another run.", 502)
        with self.lock:
            self._check_run(run_id)
            self._replace(source, {"source": "eventhouse", "seed": None, "scenario": None, "source_run_id": source_run_id,
                                   "detail": detail}, run_id=source_run_id, speed=self.speed)
            # Rows already in the local ledger for this run are not re-counted as duplicates.
            self.ingested_through = self.db.ledger_summary(source_run_id)["latest_sequence"]
            self.restored = False
            return self._snapshot()

    def generate(self, run_id: str, seed: int, scenario: str) -> ReplaySnapshot:
        source = self._simulate(seed, scenario)
        with self.lock:
            self._check_run(run_id)
            self._replace(source, {"source": "simulator", "seed": seed, "scenario": scenario}, speed=self.speed)
            self.restored = False
            return self._snapshot()

    def control(self, action: str, run_id: str, speed: int | None = None, elapsed_ms: int | None = None) -> ReplaySnapshot:
        with self.lock:
            self._check_run(run_id)
            self._advance()
            status = self.state.replay_status
            if action == "reset":
                self._replace(self.source, self.meta, speed=self.speed)
                self.restored = False
            elif action == "play" and status == "paused":
                self.started_at = self.clock()
                self.state = self.state.model_copy(update={"state_version": self.state.state_version + 1, "replay_status": "playing"})
            elif action == "pause" and status == "playing":
                self.elapsed_ms = self._elapsed()
                self.started_at = None
                self.state = self.state.model_copy(update={"state_version": self.state.state_version + 1, "replay_status": "paused"})
            elif action == "speed":
                if speed not in SPEEDS:
                    raise replay_error("invalid_speed", f"Speed must be one of {', '.join(map(str, SPEEDS))}.")
                if self.started_at is not None:
                    self.elapsed_ms = self._elapsed()
                    self.started_at = self.clock()
                self.speed = speed
                self.state = self.state.model_copy(update={"state_version": self.state.state_version + 1})
            elif action == "seek":
                if elapsed_ms is None:
                    raise replay_error("invalid_seek", "Seek needs elapsed_ms.")
                target = float(min(elapsed_ms, self.schedule[-1]))
                self.elapsed_ms = target
                playing = self.started_at is not None
                self.started_at = self.clock() if playing else None
                finished = bisect_right(self.schedule, target) == len(self.events)
                self._reveal(target, "finished" if finished else "playing" if playing else "paused")
                if finished:
                    self.started_at = None
            self._persist()
            return self._snapshot()

    # Ingestion ------------------------------------------------------------
    def ingest(self, run_id: str, text: str) -> dict:
        events, rejected = parse_events(text)
        valid, rejected_rows = [], list(rejected)
        for index, event in enumerate(events):
            if event.run_id != run_id:
                rejected_rows.append({"line": 0, "event_id": event.event_id, "code": "wrong_run",
                                      "message": f"Event {event.event_id} belongs to run {event.run_id}."})
            elif event.team_id is not None and event.team_id not in KNOWN_TEAMS:
                rejected_rows.append({"line": 0, "event_id": event.event_id, "code": "unknown_team",
                                      "message": f"Unknown team {event.team_id}."})
            else:
                valid.append(event.model_dump(mode="json"))
        result = self.db.ingest(run_id, valid)
        self.db.reject(run_id, rejected_rows)
        return {"accepted": len(result["accepted"]), "duplicates": len(result["duplicates"]),
                "conflicts": len(result["conflicts"]),
                "rejected": [{k: r[k] for k in ("line", "event_id", "code", "message")} for r in rejected_rows]
                + [{"line": 0, "event_id": e, "code": "conflicting_duplicate",
                    "message": "Same event ID with a different payload; first version kept."} for e in result["conflicts"]],
                "ledger": self.db.ledger_summary(run_id)}


replay_store: ReplayStore | None = None


def get_replay_store() -> ReplayStore:
    global replay_store
    if replay_store is None:
        from .config import settings
        from .insight_overlay import from_env
        replay_store = ReplayStore(backend_mode=settings().mode, overlay=from_env())
    return replay_store
