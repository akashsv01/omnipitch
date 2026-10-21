"""OmniPitch API with explicit localhost CORS and an explicit local/azure backend mode."""
import os
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from . import replay as replay_module
from .analysis import TEAMS, analyse, moments_with_insights
from .config import settings
from .eventhouse import EventhouseError, EventhouseReader
from .replay import replay_error
from .sample_data import sample_events, sample_state
from .recaps import from_env as recap_service_from_env
from .schemas import (MAX_EVENTS, EventhouseLoad, RecapResponse, EventPage, EventsResponse, GenerateRequest, HealthResponse,
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
                   allow_methods=["GET", "POST"], allow_headers=["Accept", "Content-Type"])


def store():
    return replay_module.get_replay_store()


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
    if SETTINGS.azure:
        raise HTTPException(409, detail={"code": "azure_mode", "message": f"{action} is local-only. In azure mode, load a run from Eventhouse."})


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
            "replay_source": store().meta["source"], "replay_source_run_id": store().meta.get("source_run_id")}


@app.get("/api/v1/matches/demo/state", response_model=MatchState)
def state() -> MatchState:
    return sample_state()


@app.get("/api/v1/matches/demo/events", response_model=EventsResponse)
def events() -> EventsResponse:
    return EventsResponse(events=sample_events())


@app.get("/api/v1/replay", response_model=ReplaySnapshot)
def replay(run_id: str | None = None, after_sequence: int = Query(0, ge=0)) -> ReplaySnapshot:
    return store().snapshot(run_id, after_sequence)


_recaps = None


def recaps():
    global _recaps
    if _recaps is None:
        _recaps = recap_service_from_env()
    return _recaps


@app.get("/api/v1/replay/recap", response_model=RecapResponse)
def replay_recap(scope: str = Query("first_half", pattern="^(first_half|full_time)$")) -> RecapResponse:
    """Halftime or full-time recap of the revealed replay; provisional until that period has ended."""
    events, moments = store().recap_inputs()
    result = recaps().recap(events, moments, scope)
    if result is None:
        raise HTTPException(404, detail={"code": "recap_not_available",
                                         "message": "The first half has not started yet." if scope == "first_half"
                                         else "The full-time recap is available once the second half starts."})
    return RecapResponse.model_validate(result, strict=False)


@app.post("/api/v1/replay/control", response_model=ReplaySnapshot)
def control_replay(command: ReplayControl) -> ReplaySnapshot:
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
