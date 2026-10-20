"""Monorepo seams to the simulator, analytics and agents packages, plus committed fixtures."""
import json
from pathlib import Path
import sys

from .schemas import Event, MatchState

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
# Local monorepo seam until these services become independently packaged.
# services/bridge provides the shared Cosmos client used by the insight overlay (agents.insights).
for package in ("services/simulator", "services/analytics", "services/agents", "services/bridge"):
    if str(REPOSITORY_ROOT / package) not in sys.path:
        sys.path.insert(0, str(REPOSITORY_ROOT / package))
from simulator.generate import generate_events  # noqa: E402
from simulator.match import AWAY, HOME, roster, simulate_match  # noqa: E402,F401


def sample_events() -> list[Event]:
    return [Event.model_validate(event) for event in generate_events()]


def sample_state() -> MatchState:
    path = REPOSITORY_ROOT / "contracts/examples/match-state.example.json"
    return MatchState.model_validate(json.loads(path.read_text(encoding="utf-8")))
