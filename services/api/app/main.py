"""OmniPitch API with explicit localhost CORS and an explicit local/azure backend mode."""
from contextvars import ContextVar
import os
import re
from threading import Lock
import time
from urllib.parse import urlparse

from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from . import replay as replay_module
from .analysis import TEAMS, analyse, moments_with_insights
from .config import settings
from .eventhouse import EventhouseError, EventhouseReader
from .replay import replay_error
from .sample_data import sample_events, sample_state
from .reconciliations import from_env as reconciliation_source_from_env
from .recaps import from_env as recap_service_from_env
from .commentary import clock_of, event_line, moment_line, recap_line, speakable
from .speech import SpeechError, from_env as speech_service_from_env, spoken_text
from pydantic import Field

from .schemas import (WireModel, MAX_EVENTS, EventhouseLoad, RecapResponse, EventPage, EventsResponse, GenerateRequest, HealthResponse,
                      IngestResult, LedgerSummary, MatchState, ReadyResponse, ReplayControl, ReplaySnapshot)

MAX_BODY_BYTES = 2 * 1_048_576


def cors_origins() -> list[str]:
    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
    for origin in origins:
        parsed = urlparse(origin)
        if (parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("CORS_ORIGINS must contain explicit localhost origins without paths")
        _ = parsed.port  # Reject malformed ports at startup.
    return origins


SETTINGS = settings()  # Invalid OMNIPITCH_BACKEND_MODE fails startup rather than guessing.
app = FastAPI(title="OmniPitch API", version="0.3.0")
app.add_middleware(CORSMiddleware, allow_origins=cors_origins(), allow_credentials=False,
                   allow_methods=["GET", "POST"], allow_headers=["Accept", "Content-Type", "X-Viewer"],
                   expose_headers=["X-Caption"])

# Each browser sends a random viewer ID (X-Viewer) and gets its own replay; without one, the shared replay is used.
VIEWER_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
current_viewer: ContextVar[str | None] = ContextVar("current_viewer", default=None)


@app.middleware("http")
async def viewer_scope(request: Request, call_next):
    viewer = request.headers.get("x-viewer", "")
    token = current_viewer.set(viewer if VIEWER_ID.match(viewer) else None)
    try:
        return await call_next(request)
    finally:
        current_viewer.reset(token)


_default_lock = Lock()
_default_state = {"checked": False, "run": None, "outcome": "not_configured", "error": None, "reloads": 0}
_heal_lock = Lock()
_last_heal = {"at": None}
HEAL_INTERVAL_S = 60.0
_now = time.monotonic


def store():
    """The requesting viewer's own replay (created from the shared match on first use), or the shared replay."""
    replay = replay_module.get_replay_store()
    if not _default_state["checked"]:
        load_default_run(replay)
    else:
        heal_default_run(replay)
    viewer = current_viewer.get()
    return replay_module.viewer_store(viewer) if viewer else replay


def load_default_run(replay) -> None:
    """Judge deployments scale to zero and keep replay state in ephemeral storage. On a fresh start in azure mode,
    OMNIPITCH_DEFAULT_RUN loads that Eventhouse run once, so visitors never land on an empty default replay.
    A failure is recorded (/ready shows it) and the API keeps serving; it never substitutes other data."""
    with _default_lock:
        if _default_state["checked"]:
            return
        _default_state["checked"] = True
        run = os.getenv("OMNIPITCH_DEFAULT_RUN", "").strip()
        _default_state["run"] = run or None
        if not run:
            return
        if not SETTINGS.azure:
            _default_state["outcome"] = "skipped_local_mode"
            return
        if replay.restored or replay.meta.get("source_run_id"):
            _default_state["outcome"] = "kept_restored_run"  # Never replace a replay someone is already watching.
            return
        _load_default(replay, run, "loaded")


def _load_default(replay, run: str, outcome: str) -> None:
    try:
        reader = eventhouse()
        summary = reader.run_summary(run)
        detail = (f"Eventhouse {SETTINGS.eventhouse_database}.{SETTINGS.eventhouse_table}: {summary['raw_rows']} rows, "
                  f"{summary['unique_events']} unique events (default run)")
        replay.load_eventhouse(replay.state.run_id, run, reader.events(run), detail)
        _default_state.update(outcome=outcome, error=None)
    except Exception as exc:  # EventhouseError, HTTPException or a replay error: report, keep serving.
        _default_state.update(outcome="failed", error=f"{type(exc).__name__}: {str(getattr(exc, 'detail', exc))[:200]}")


def heal_default_run(replay) -> None:
    """Self-check for the shared judge replay: in azure mode with a default run configured, the replay must be an
    Eventhouse run. If it ever is not (a failed start-up load, or anything else that left a local match on screen),
    the default run is loaded again, at most once a minute and never while an operator allows replay changes."""
    run = _default_state["run"]
    if not run or not SETTINGS.azure or replay.meta.get("source") == "eventhouse":
        return
    if os.getenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", "").strip() == "1":
        return
    if _default_lock.locked():
        return  # The start-up load is still running; it will put the default run in place itself.
    if not _heal_lock.acquire(blocking=False):
        return  # Another request is already reloading it.
    try:
        now = _now()
        if _last_heal["at"] is not None and now - _last_heal["at"] < HEAL_INTERVAL_S:
            return
        _last_heal["at"] = now
        _load_default(replay, run, "reloaded")
        if _default_state["outcome"] == "reloaded":
            _default_state["reloads"] = _default_state.get("reloads", 0) + 1
    finally:
        _heal_lock.release()


_reader: EventhouseReader | None = None


def eventhouse() -> EventhouseReader:
    """Azure mode only. Errors surface as 503/403/404 with explicit codes; there is no local fallback."""
    global _reader
    if not SETTINGS.azure:
        raise HTTPException(409, detail={"code": "local_mode", "message": "Eventhouse is used only when OMNIPITCH_BACKEND_MODE=azure."})
    try:
        if _reader is None:
            _reader = EventhouseReader(SETTINGS)
        return _reader
    except EventhouseError as exc:
        raise http_error(exc)


def http_error(exc: EventhouseError) -> HTTPException:
    status = {"forbidden": 403, "not_found": 404, "not_configured": 503, "auth_unavailable": 503, "unreachable": 503}.get(exc.code, 502)
    return HTTPException(status, detail={"code": f"eventhouse_{exc.code}", "message": str(exc)})


def local_only(action: str) -> None:
    if SETTINGS.azure and not current_viewer.get():  # A viewer's own replay can always be replaced.
        raise HTTPException(409, detail={"code": "azure_mode", "message": f"{action} is local-only. In azure mode, load a run from Eventhouse."})


def guard_replay_change(action: str) -> None:
    """The shared replay (the match every new viewer starts from) is protected in azure mode: actions that replace it
    or write into its ledger are refused unless OMNIPITCH_ALLOW_REPLAY_CHANGES=1 (for an operator). A viewer's own
    replay (requests with X-Viewer) can always be reset, replaced or ingested into; it affects nobody else."""
    if SETTINGS.azure and not current_viewer.get() and os.getenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", "").strip() != "1":
        raise HTTPException(403, detail={"code": "replay_changes_disabled",
                                         "message": f"{action} is turned off on this deployment, so the shared match stays in place."})


async def read_body(request: Request) -> str:
    # Accept file content only, never an arbitrary path on the server.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise replay_error("file_too_large", "JSONL input must be at most 2 MiB.", 413)
    try:
        return body.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise replay_error("invalid_encoding", "JSONL must be UTF-8 encoded.")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.get("/ready", response_model=ReadyResponse)
def ready() -> ReadyResponse:
    if not store().db.ping():
        raise HTTPException(503, detail={"code": "database_unavailable", "message": "SQLite is not reachable."})
    if not SETTINGS.azure:
        return ReadyResponse(mode="local", analytics="python-adapter-local")
    try:
        probe = eventhouse().ping()
    except EventhouseError as exc:
        raise http_error(exc)
    return ReadyResponse(mode="azure", analytics="python-adapter-over-eventhouse", eventhouse={**SETTINGS.describe(), **probe})


@app.get("/api/v1/backend")
def backend() -> dict:
    """Non-secret description of where data comes from."""
    return {**SETTINGS.describe(), "missing": SETTINGS.missing() if SETTINGS.azure else [],
            "replay_source": store().meta["source"], "replay_source_run_id": store().meta.get("source_run_id"),
            "default_run": dict(_default_state)}


@app.get("/api/v1/matches/demo/state", response_model=MatchState)
def state() -> MatchState:
    return sample_state()


@app.get("/api/v1/matches/demo/events", response_model=EventsResponse)
def events() -> EventsResponse:
    return EventsResponse(events=sample_events())


@app.get("/api/v1/replay", response_model=ReplaySnapshot)
def replay(run_id: str | None = None, after_sequence: int = Query(0, ge=0)) -> ReplaySnapshot:
    snapshot = store().snapshot(run_id, after_sequence)
    _prime_recaps()
    return snapshot


def _prime_recaps() -> None:
    """Half-time and full-time recaps are created when their period ends, not when someone opens the Recap tab.
    A recap failure never breaks the snapshot; the Recap tab rebuilds on demand either way."""
    try:
        replay = store()
        ends = replay.revealed_period_ends()
        if ends and recaps().unprimed(ends):
            events, moments = replay.recap_inputs()
            recaps().prime(events, moments)
    except Exception:  # noqa: BLE001  (best effort; the on-demand path reports errors)
        pass


_recaps = None
_reconciliations = None


def recaps():
    global _recaps
    if _recaps is None:
        _recaps = recap_service_from_env()
    return _recaps


def reconciliations():
    global _reconciliations
    if _reconciliations is None:
        _reconciliations = reconciliation_source_from_env()
    return _reconciliations


_speech = None


def speech():
    global _speech
    if _speech is None:
        _speech = speech_service_from_env()
    return _speech


class SpeechRequest(WireModel):
    moment_id: str = Field(min_length=1, max_length=200)
    audience: Literal["fan", "analyst"]
    language: Literal["en", "es"]
    # Spanish only: the browser's rule-based translation of the same insight; English is composed server-side.
    text: str | None = Field(default=None, max_length=600)


@app.get("/api/v1/speech/status")
def speech_status() -> dict:
    """Whether narration audio is available; the text and captions work either way."""
    return speech().status()


@app.post("/api/v1/speech/moment")
def speech_moment(request: SpeechRequest) -> Response:
    """MP3 narration of one revealed moment's accepted text. Never narrates a moment the replay has not reached."""
    events, moments = store().recap_inputs()
    moment = next((m for m in moments if m["moment_id"] == request.moment_id), None)
    if moment is None:
        raise HTTPException(404, detail={"code": "moment_not_available", "message": "That moment is not revealed at the current replay position."})
    text = spoken_text(moment, request.audience) if request.language == "en" else moment_line(moment, request.audience, "es")
    return _audio_response(text, request.language)


def _audio_response(text: str, language: str) -> Response:
    """MP3 of accepted text, with the caption that was spoken (percent-encoded) for the transcript."""
    from urllib.parse import quote
    try:
        audio, key = speech().audio(speakable(text, language), language)
    except SpeechError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code, "message": exc.message}) from exc
    return Response(audio, media_type="audio/mpeg", headers={"X-Narration-Key": key[:16], "X-Caption": quote(text),
                                                              "Access-Control-Expose-Headers": "X-Caption", "Cache-Control": "private, max-age=3600"})


COMMENTARY_RULES = {"transition": 50, "pressing_change": 45, "threat_gain": 30}


_playouts: dict = {}


@app.get("/api/v1/replay/physical")
def replay_physical(sprint_alert_mps: float = Query(9.0, ge=5.0, le=12.0)) -> dict:
    """SIMULATED running distance, top speed and ball speed up to the replay position (no tracking exists)."""
    from simulator.physical import physical_summary
    from .sample_data import roster
    events, _ = store().recap_inputs()
    return physical_summary(events, roster(), sprint_alert_mps)


@app.get("/api/v1/broadcast")
def broadcast(audience: Literal["fan", "analyst"] = "fan", language: Literal["en", "es"] = Query("en", alias="lang")) -> dict:
    """The playout for this viewer's replay, one audience and language: on air, queued, and the recent log."""
    from .broadcast import Playout
    key = current_viewer.get() or ""
    playout = _playouts.pop(key, None) or Playout()
    _playouts[key] = playout  # Most recent last; the oldest are dropped beyond the viewer limit.
    while len(_playouts) > replay_module.MAX_VIEWERS + 1:
        _playouts.pop(next(iter(_playouts)))
    snap = store().snapshot().model_dump(mode="json")
    state, info = snap["state"], snap["replay"]
    clock = clock_of({"period": info["clock_period"], "match_time_ms": info["clock_ms"]})
    return playout.feed(snap["moments"], state["run_id"], state["latest_event_sequence"], int(info["elapsed_ms"]), clock, audience, language)


@app.get("/api/v1/commentary/lines")
def commentary_lines(run_id: str = Query(..., min_length=1, max_length=200), after: int = Query(0, ge=0),
                     audience: Literal["fan", "analyst"] = "fan", language: Literal["en", "es"] = Query("en", alias="lang"),
                     player_id: str | None = Query(None, max_length=60), brief: bool = False) -> dict:
    """Commentary candidates for events and moments revealed after `after`, newest last, each with a priority.
    Only the replay's current run and revealed position are used, so nothing ahead of the replay can be said."""
    replay = store()
    events, moments = replay.recap_inputs()
    if replay.state.run_id != run_id:
        return {"run_id": replay.state.run_id, "through": len(events), "lines": [], "stale": True}
    players = _players()
    lines = []
    for event in events[after:]:
        line = event_line(event, events, players, audience, language)
        if line is None and player_id and event.get("player_id") == player_id and event["type"] in ("tackle", "interception") \
                and event.get("outcome") == "won":
            # Focus: the followed player's ball wins are always worth a line.
            line = (f"{players.get(player_id, '')} recupera el balón." if language == "es" else f"{players.get(player_id, '')} wins the ball."), 45
        if line:
            lines.append({"ref": f"event:{event['event_id']}", "kind": event["type"], "priority": line[1], "sequence": event["sequence"],
                          "period": event["period"], "match_time_ms": event["match_time_ms"], "clock": clock_of(event), "text": line[0]})
    for moment in moments:
        if moment["source_sequence"] > after and moment["rule"] in COMMENTARY_RULES:
            if moment["rule"] == "threat_gain" and not moment["facts"].get("box_entry"):
                continue
            lines.append({"ref": f"moment:{moment['moment_id']}", "kind": moment["rule"], "priority": COMMENTARY_RULES[moment["rule"]]
                          + (10 if moment["insight"].get("generation_status") == "ai_accepted" else 0),
                          "sequence": moment["source_sequence"], "period": moment["period"], "match_time_ms": moment["match_time_ms"],
                          "clock": clock_of(moment), "text": moment_line(moment, audience, language, brief)})
    lines.sort(key=lambda line: line["sequence"])
    _warm(lines, language)
    return {"run_id": run_id, "through": len(events), "lines": lines, "stale": False}


_WARM = None


def _warm(lines: list[dict], language: str) -> None:
    """Synthesize the most likely next lines in the background, so speaking them starts from the cache."""
    global _WARM
    if not speech().status()["configured"] or not lines:
        return
    if _WARM is None:
        from concurrent.futures import ThreadPoolExecutor
        _WARM = ThreadPoolExecutor(max_workers=3, thread_name_prefix="speech-warm")
    # The player speaks major lines and, in quiet spells, the newest routine one: prepare both kinds.
    likely = sorted(lines, key=lambda l: (-l["priority"], -l["sequence"]))[:4]
    likely += [l for l in sorted(lines, key=lambda l: -l["sequence"])[:2] if l not in likely]
    for line in likely:
        _WARM.submit(_safe_audio, speakable(line["text"], language), language)


def _safe_audio(text: str, language: str) -> None:
    try:
        speech().audio(text, language)
    except Exception:  # noqa: BLE001  (warming is best effort; the real request reports errors)
        pass


class CommentaryAudio(WireModel):
    run_id: str = Field(min_length=1, max_length=200)
    ref: str = Field(min_length=3, max_length=240)
    audience: Literal["fan", "analyst"]
    language: Literal["en", "es"]
    brief: bool = False


@app.post("/api/v1/commentary/audio")
def commentary_audio(request: CommentaryAudio) -> Response:
    """Speech for one commentary line, recomposed on the server from its reference (never from client text)."""
    replay = store()
    events, moments = replay.recap_inputs()
    if replay.state.run_id != request.run_id:
        raise HTTPException(409, detail={"code": "stale_run", "message": "The match has changed."})
    kind, _, ref = request.ref.partition(":")
    if kind == "event":
        event = next((e for e in events if e["event_id"] == ref), None)
        players = _players()
        line = event and event_line(event, events, players, request.audience, request.language)
        if not line and event and event["type"] in ("tackle", "interception"):
            line = (f"{players.get(event.get('player_id') or '', '')} {'recupera el balón.' if request.language == 'es' else 'wins the ball.'}", 45)
        if not line:
            raise HTTPException(404, detail={"code": "line_not_available", "message": "Nothing to say for that action yet."})
        return _audio_response(line[0], request.language)
    if kind == "moment":
        moment = next((m for m in moments if m["moment_id"] == ref), None)
        if moment is None:
            raise HTTPException(404, detail={"code": "line_not_available", "message": "That moment is not revealed yet."})
        return _audio_response(moment_line(moment, request.audience, request.language, request.brief), request.language)
    if kind == "recap" and ref in ("first_half", "full_time"):
        period = 1 if ref == "first_half" else 2
        end = next((e for e in events if e["type"] == "period_end" and e["period"] == period), None)
        if end is None:  # Stopped playback is not the end of a half: only a revealed period_end counts.
            raise HTTPException(404, detail={"code": "line_not_available", "message": "That half has not finished yet."})
        result = recaps().recap([e for e in events if e["sequence"] <= end["sequence"]], moments, ref, request.language, wait_s=8.0)
        return _audio_response(recap_line(result["recap"]), request.language)
    raise HTTPException(422, detail={"code": "bad_ref", "message": "Unknown commentary reference."})


def _players() -> dict:
    from .sample_data import roster
    return {p["player_id"]: p["name"] for p in roster()}


@app.get("/api/v1/replay/recap", response_model=RecapResponse)
def replay_recap(scope: str = Query("first_half", pattern="^(first_half|full_time)$"),
                 lang: str = Query("en", pattern="^(en|es)$")) -> RecapResponse:
    """Halftime or full-time recap of the revealed replay; provisional until that period has ended."""
    replay = store()
    events, moments = replay.recap_inputs()
    result = recaps().recap(events, moments, scope, lang)
    if result is None:
        raise HTTPException(404, detail={"code": "recap_not_available",
                                         "message": "The first half has not started yet." if scope == "first_half"
                                         else "The full-time recap is available once the second half starts."})
    # Read-only: "reconciled" only from the bridge's record for the replay's source run and these events.
    result["reconciliation"] = reconciliations().status(replay.meta.get("source_run_id"), scope, events)
    return RecapResponse.model_validate(result, strict=False)


@app.post("/api/v1/replay/control", response_model=ReplaySnapshot)
def control_replay(command: ReplayControl) -> ReplaySnapshot:
    if command.action == "reset":
        guard_replay_change("Resetting the replay")
    return store().control(command.action, command.run_id, command.speed, command.elapsed_ms)


@app.post("/api/v1/replay/generate", response_model=ReplaySnapshot)
def generate_replay(request: GenerateRequest) -> ReplaySnapshot:
    local_only("Generating a local simulator match")
    return store().generate(request.run_id, request.seed, request.scenario)


@app.post("/api/v1/replay/load", response_model=ReplaySnapshot)
async def load_replay(request: Request, run_id: str) -> ReplaySnapshot:
    local_only("Loading a JSONL file")
    return store().load(await read_body(request), run_id)


@app.get("/api/v1/runs/{run_id}/events", response_model=EventPage)
def run_events(run_id: str, after: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=500)) -> EventPage:
    page = store().db.ledger_events(run_id, after, limit + 1)
    more = len(page) > limit
    page = page[:limit]
    return EventPage.model_validate({"run_id": run_id, "events": page,
                                     "next_after": page[-1]["sequence"] if more and page else None}, strict=False)


@app.get("/api/v1/runs/{run_id}/ledger")
def run_ledger(run_id: str) -> dict:
    db = store().db
    return {"summary": LedgerSummary.model_validate(db.ledger_summary(run_id)).model_dump(),
            "diagnostics": db.diagnostics(run_id)}


@app.get("/api/v1/runs/{run_id}/metrics")
def run_metrics(run_id: str) -> dict:
    """Metrics recomputed from the deduplicated ledger (not the replay buffer)."""
    events = store().db.ledger_events(run_id)
    contiguous = []
    for event in events:
        if event["sequence"] != len(contiguous) + 1:
            break  # Only a gap-free prefix feeds windowed metrics.
        contiguous.append(event)
    analysis = analyse(contiguous)
    return {"run_id": run_id, "ledger": store().db.ledger_summary(run_id), "through_sequence": analysis["through_sequence"],
            "teams": analysis["teams"], "moment_count": len(moments_with_insights(contiguous, run_id, events[0]["match_id"])) if contiguous else 0}


@app.get("/api/v1/runs/{run_id}/moments")
def run_moments(run_id: str) -> dict:
    return {"run_id": run_id, "moments": store().db.moments(run_id)}


@app.post("/api/v1/runs/{run_id}/ingest", response_model=IngestResult)
async def ingest(request: Request, run_id: str) -> IngestResult:
    guard_replay_change("Ingesting events")
    return IngestResult.model_validate(store().ingest(run_id, await read_body(request)), strict=False)



# Push: Web PubSub negotiation (fast path only; the snapshot API stays the recovery path) ----------

_PUSH_CLIENT = None


def push_client():
    """WebPubSubClient from WEBPUBSUB_ENDPOINT (+ WEBPUBSUB_HUB), Entra ID server-side; None if not configured."""
    global _PUSH_CLIENT
    endpoint = os.getenv("WEBPUBSUB_ENDPOINT", "").strip()
    if not endpoint:
        return None
    if _PUSH_CLIENT is None:
        from omnipitch_bridge.push import HUB, WebPubSubClient
        _PUSH_CLIENT = WebPubSubClient(endpoint, os.getenv("WEBPUBSUB_HUB", HUB))
    return _PUSH_CLIENT


@app.get("/api/v1/negotiate")
def negotiate(run_id: str = Query(..., min_length=1, max_length=128)) -> dict:
    """Short-lived client URL (receive-only) for one source run's group. 503 push_not_configured means poll only."""
    from omnipitch_bridge.push import group_for
    try:
        group = group_for(run_id)
    except ValueError as exc:
        raise HTTPException(422, detail={"code": "invalid_run_id", "message": str(exc)})
    try:
        client = push_client()
    except ValueError as exc:
        raise HTTPException(503, detail={"code": "push_not_configured", "message": str(exc)})
    if client is None:
        raise HTTPException(503, detail={"code": "push_not_configured", "message": "WEBPUBSUB_ENDPOINT is not set; poll the snapshot API."})
    minutes = 60
    try:
        negotiated = client.client_url(group, minutes)
    except Exception as exc:  # Credential or service failure: explicit, never a fake URL.
        raise HTTPException(502, detail={"code": "push_negotiate_failed", "message": f"{type(exc).__name__}: {str(exc)[:200]}"})
    from datetime import datetime, timedelta, timezone
    expires = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(timespec="seconds").replace("+00:00", "Z")
    return {**negotiated, "expires_at": expires}


# Azure mode: Eventhouse as the analytics event source ---------------------------------------

@app.get("/api/v1/eventhouse/runs")
def eventhouse_runs(limit: int = Query(10, ge=1, le=50)) -> dict:
    try:
        return {"runs": eventhouse().recent_runs(limit), **SETTINGS.describe()}
    except EventhouseError as exc:
        raise http_error(exc)


@app.get("/api/v1/eventhouse/runs/{run_id}")
def eventhouse_run(run_id: str) -> dict:
    """Raw vs unique rows, KQL parity counts, and Python metrics over the same deduplicated rows."""
    reader = eventhouse()
    try:
        summary = reader.run_summary(run_id)
        kql = {row["team_id"]: row for row in reader.team_counts(run_id)}
        events = reader.events(run_id)
    except EventhouseError as exc:
        raise http_error(exc)
    from .schemas import Event
    validated = [Event.model_validate(event, strict=False).model_dump(mode="json") for event in events]
    contiguous = []
    for event in validated:
        if event["sequence"] != len(contiguous) + 1:
            break
        contiguous.append(event)
    analysis = analyse(contiguous)
    parity = []
    for team in TEAMS:
        python, cloud = analysis["teams"][team], kql.get(team, {})
        pairs = {"pass_attempts": python["passes_attempted"], "passes_completed": python["passes_completed"],
                 "progression_m": python["progression_m"], "shots": python["shots"], "goals": python["goals"],
                 "defensive_actions": python["defensive_actions"]}
        for name, value in pairs.items():
            other = cloud.get(name)
            match = other is not None and abs(float(other) - float(value)) <= (0.15 if name == "progression_m" else 0)
            parity.append({"team_id": team, "metric": name, "python": value, "kql": other, "match": match})
    return {"run_id": run_id, "source": SETTINGS.describe(), "summary": summary, "events_read": len(validated),
            "contiguous_through": len(contiguous), "parity": parity, "parity_ok": all(item["match"] for item in parity),
            "teams": analysis["teams"], "ppda_series": [{k: v for k, v in w.items() if k != "evidence_ids"} for w in analysis["ppda_series"]]}


@app.post("/api/v1/replay/eventhouse", response_model=ReplaySnapshot)
def load_from_eventhouse(request: EventhouseLoad) -> ReplaySnapshot:
    reader = eventhouse()
    try:
        summary = reader.run_summary(request.source_run_id)
        events = reader.events(request.source_run_id)
    except EventhouseError as exc:
        raise http_error(exc)
    detail = (f"Eventhouse {SETTINGS.eventhouse_database}.{SETTINGS.eventhouse_table}: {summary['raw_rows']} rows, "
              f"{summary['unique_events']} unique events")
    return store().load_eventhouse(request.run_id, request.source_run_id, events, detail)


assert MAX_EVENTS >= 1000
