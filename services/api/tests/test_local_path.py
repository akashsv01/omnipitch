import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError
import pytest

from app.main import app, cors_origins
from app.schemas import Event, Insight, MatchState
from simulator.generate import generate_events

ROOT = Path(__file__).resolve().parents[3]
client = TestClient(app)


def read(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def validator(name):
    schema = read(f"contracts/schemas/{name}.schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "application": "omnipitch-api"}


@pytest.mark.parametrize("name,model", [("event", Event), ("insight", Insight), ("match-state", MatchState)])
def test_committed_contracts(name, model):
    fixture = read(f"contracts/examples/{name}.example.json")
    validator(name).validate(fixture)
    assert model.model_validate(fixture).model_dump(mode="json") == fixture
    assert set(model.model_fields) == set(fixture)
    invalid = dict(fixture, unexpected=True)
    assert not validator(name).is_valid(invalid)
    with pytest.raises(ValidationError):
        model.model_validate(invalid)


def test_api_contracts_and_evidence():
    state_response = client.get("/api/v1/matches/demo/state")
    events_response = client.get("/api/v1/matches/demo/events")
    assert state_response.status_code == events_response.status_code == 200
    state = state_response.json()
    events = events_response.json()["events"]
    validator("match-state").validate(state)
    assert state == read("contracts/examples/match-state.example.json")
    assert events == generate_events()
    assert events[0] == read("contracts/examples/event.example.json")
    for event in events:
        validator("event").validate(event)
        assert event["run_id"] == state["run_id"]
        assert event["match_id"] == state["match_id"]
    assert state["latest_event_sequence"] == events[-1]["sequence"]
    assert state["match_time_ms"] == events[-1]["match_time_ms"]
    insight = read("contracts/examples/insight.example.json")
    assert insight["evidence_ids"] == [event["event_id"] for event in events]
    assert insight["metrics"][0] == {"name": "completed_passes", "value": len(events), "unit": "passes"}


def test_simulator_continuity_and_reproducibility():
    events = generate_events(seed=19, run_id="test-run", count=100)
    assert events == generate_events(seed=19, run_id="test-run", count=100)
    assert events != generate_events(seed=20, run_id="test-run", count=100)
    assert len({event["event_id"] for event in events}) == 100
    for index, event in enumerate(events):
        validator("event").validate(event)
        assert event["sequence"] == index + 1
        assert event["match_time_ms"] == (index + 1) * 3000
        assert event["possession_id"] == "possession-001"
        assert event["player_id"].startswith("harbor-")
        if index:
            assert events[index - 1]["end"] == event["start"]
            assert events[index - 1]["emitted_at"] < event["emitted_at"]
    reset = generate_events(seed=19, run_id="reset-run", count=100)
    assert reset[0]["event_id"] == events[0]["event_id"]
    assert reset[0]["run_id"] != events[0]["run_id"]


@pytest.mark.parametrize("kwargs", [{"run_id": " "}, {"count": 0}, {"count": 1001}, {"baseline": "2026-01-01T12:00:00"}, {"baseline": "2026-01-01T12:00:00+01:00"}])
def test_simulator_rejects_invalid_inputs(kwargs):
    with pytest.raises(ValueError):
        generate_events(**kwargs)


def test_cli_bytes_deterministic_and_valid(tmp_path):
    env = dict(os.environ, PYTHONPATH=str(ROOT / "services/simulator"))
    outputs = [tmp_path / "a.jsonl", tmp_path / "b.jsonl"]
    for path in outputs:
        subprocess.run([sys.executable, "-m", "simulator.generate", "--seed", "7", "--run-id", "cli-test", "--output", str(path)], cwd=ROOT, env=env, check=True, capture_output=True)
    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    for line in outputs[0].read_text().splitlines():
        validator("event").validate(json.loads(line))


def test_cors_allows_explicit_local_origin_only():
    allowed = client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-credentials" not in allowed.headers
    denied = client.get("/health", headers={"Origin": "https://example.com"})
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.parametrize("origin", ["*", "https://example.com", "http://localhost:5173/path", "http://user@localhost:5173", "http://localhost:bad"])
def test_invalid_cors_configuration(monkeypatch, origin):
    monkeypatch.setenv("CORS_ORIGINS", origin)
    with pytest.raises(ValueError):
        cors_origins()


@pytest.mark.parametrize("field,value", [("outcome", "failed"), ("type", "shot"), ("synthetic", False), ("emitted_at", "2026-02-30T12:00:00Z"), ("emitted_at", "2026-01-01T12:00:00+01:00"), ("start", {"x": 106.0, "y": 34.0})])
def test_invalid_events_rejected_by_both_models(field, value):
    event = dict(generate_events()[0], **{field: value})
    assert not validator("event").is_valid(event)
    with pytest.raises(ValidationError):
        Event.model_validate(event)


def test_duplicate_insight_evidence_rejected():
    insight = read("contracts/examples/insight.example.json")
    insight["evidence_ids"] = ["pass-0001", "pass-0001"]
    assert not validator("insight").is_valid(insight)
    with pytest.raises(ValidationError):
        Insight.model_validate(insight)
