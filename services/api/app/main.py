"""Local development API with explicit localhost CORS."""
import os
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .sample_data import sample_events, sample_state
from .schemas import EventsResponse, HealthResponse, MatchState


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
                   allow_methods=["GET"], allow_headers=["Accept", "Content-Type"])


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.get("/api/v1/matches/demo/state", response_model=MatchState)
def state() -> MatchState:
    return sample_state()


@app.get("/api/v1/matches/demo/events", response_model=EventsResponse)
def events() -> EventsResponse:
    return EventsResponse(events=sample_events())
