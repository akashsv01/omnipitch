"""Use the monorepo fixture generator and committed state; no JSONL ingestion yet."""
import json
from pathlib import Path
import sys

from .schemas import Event, MatchState

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
# Local monorepo seam until the simulator becomes an independently packaged service.
sys.path.insert(0, str(REPOSITORY_ROOT / "services/simulator"))
from simulator.generate import generate_events  # noqa: E402


def sample_events() -> list[Event]:
    return [Event.model_validate(event) for event in generate_events()]


def sample_state() -> MatchState:
    path = REPOSITORY_ROOT / "contracts/examples/match-state.example.json"
    return MatchState.model_validate(json.loads(path.read_text(encoding="utf-8")))
