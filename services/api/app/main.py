"""Local development API with explicit localhost CORS."""
import os
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .sample_data import sample_events, sample_state
from .schemas import EventsResponse, HealthResponse, MatchState
from .schemas import ReplayControl, ReplaySnapshot
from .replay import replay_error, replay_store


def cors_origins() -> list[str]:
    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
    for origin in origins:
        parsed = urlparse(origin)
        if (parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("CORS_ORIGINS must contain explicit localhost origins without paths")
        _ = parsed.port  # Reject malformed ports at startup.
    return origins


app = FastAPI(title="OmniPitch local API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=cors_origins(), allow_credentials=False,
                   allow_methods=["GET", "POST"], allow_headers=["Accept", "Content-Type"])


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.get("/api/v1/matches/demo/state", response_model=MatchState)
def state() -> MatchState:
    return sample_state()


@app.get("/api/v1/matches/demo/events", response_model=EventsResponse)
def events() -> EventsResponse:
    return EventsResponse(events=sample_events())


@app.get("/api/v1/replay", response_model=ReplaySnapshot)
def replay() -> ReplaySnapshot:
    return replay_store.snapshot()


@app.post("/api/v1/replay/control", response_model=ReplaySnapshot)
def control_replay(command: ReplayControl) -> ReplaySnapshot:
    return replay_store.control(command.action, command.run_id)


@app.post("/api/v1/replay/load", response_model=ReplaySnapshot)
async def load_replay(request: Request, run_id: str) -> ReplaySnapshot:
    # Accept file content only, never an arbitrary path on the server.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 1_048_576:
            raise replay_error("file_too_large", "JSONL files must be at most 1 MiB.", 413)
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise replay_error("invalid_encoding", "JSONL must be UTF-8 encoded.")
    return replay_store.load(text, run_id)
