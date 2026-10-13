import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from app import main
from app.replay import ReplayStore, parse_jsonl
from app.schemas import ReplaySnapshot
from simulator.generate import generate_events

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def replay(monkeypatch):
    now = [0.0]
    store = ReplayStore(clock=lambda: now[0])
    monkeypatch.setattr(main, "replay_store", store)
    return store, now, TestClient(main.app)


def jsonl(events):
    return "\n".join(json.dumps(event) for event in events)


def test_play_pause_resume_finish_and_reset(replay):
    store, now, client = replay
    initial = client.get("/api/v1/replay").json()
    run = initial["state"]["run_id"]
    assert initial["events"] == [] and initial["total_events"] == 5
    response = client.post("/api/v1/replay/control", json={"run_id": run, "action": "play"})
    assert response.json()["state"]["replay_status"] == "playing"
    now[0] = 2.5
    assert store.snapshot().events == []
    now[0] = 3.25
    first = store.snapshot()
    assert [event.sequence for event in first.events] == [1]
    assert first.state.match_time_ms == 3000
    client.post("/api/v1/replay/control", json={"run_id": run, "action": "pause"})
    now[0] = 100
    assert len(store.snapshot().events) == 1
    client.post("/api/v1/replay/control", json={"run_id": run, "action": "play"})
    now[0] = 102.75
    assert len(store.snapshot().events) == 2  # Preserves the pre-pause fractional interval.
    now[0] = 120
    final = store.snapshot()
    assert final.state.replay_status == "finished"
    assert len(final.events) == 5 and final.state.match_time_ms == 15000
    assert store.snapshot().state.state_version == final.state.state_version
    reset = client.post("/api/v1/replay/control", json={"run_id": run, "action": "reset"}).json()
    assert reset["state"]["run_id"] != run
    assert reset["state"]["replay_status"] == "paused" and reset["events"] == []
    assert reset["state"]["state_version"] == 1
    assert client.post("/api/v1/replay/control", json={"run_id": run, "action": "play"}).status_code == 409


def test_load_orders_remaps_and_resets_selected_dataset(replay):
    store, now, client = replay
    source = generate_events(seed=21, run_id="source", count=3)
    old_run = store.snapshot().state.run_id
    response = client.post(f"/api/v1/replay/load?run_id={old_run}", content=jsonl(source[::-1]))
    assert response.status_code == 200
    loaded = response.json()
    assert loaded["total_events"] == 3 and loaded["events"] == []
    new_run = loaded["state"]["run_id"]
    assert new_run not in {"source", old_run}
    store.control("play", new_run)
    now[0] = 9
    result = store.snapshot()
    assert [event.event_id for event in result.events] == [event["event_id"] for event in source]
    assert all(event.run_id == new_run for event in result.events)
    assert result.events[0].start.model_dump() == source[0]["start"]
    reset = store.control("reset", new_run)
    assert reset.total_events == 3 and reset.state.run_id != new_run


@pytest.mark.parametrize("change", [
    lambda events: [],
    lambda events: events + [events[0]],
    lambda events: [dict(events[0], run_id="different"), *events[1:]],
    lambda events: [dict(events[0], match_id="other"), *events[1:]],
    lambda events: [dict(events[0], team_id="unknown"), *events[1:]],
    lambda events: [dict(events[0], sequence=2), *events[1:]],
    lambda events: [events[0], events[2]],
    lambda events: [events[0], dict(events[1], match_time_ms=0), *events[2:]],
    lambda events: [dict(events[0], period=2), *events[1:]],
    lambda events: [dict(events[0], start={"x": 106, "y": 0}), *events[1:]],
    lambda events: [dict(events[0], emitted_at="2026-02-30T12:00:00Z"), *events[1:]],
    lambda events: [dict(events[0], unexpected=True), *events[1:]],
])
def test_invalid_file_does_not_replace_run(replay, change):
    store, _, client = replay
    before = store.snapshot().model_dump(mode="json")
    response = client.post(f"/api/v1/replay/load?run_id={before['state']['run_id']}", content=jsonl(change(generate_events())))
    assert response.status_code == 422 and response.json()["detail"]["code"]
    assert store.snapshot().model_dump(mode="json") == before


def test_file_limits_encoding_and_control_validation(replay):
    store, _, client = replay
    run = store.snapshot().state.run_id
    endpoint = f"/api/v1/replay/load?run_id={run}"
    assert client.post(endpoint, content=b"x" * 1_048_577).status_code == 413
    assert client.post(endpoint, content=b"\xff").status_code == 422
    assert client.post(endpoint, content="not json").status_code == 422
    assert client.post(endpoint, content="\ufeff" + jsonl(generate_events(count=1))).status_code == 200
    assert client.post(endpoint, content=jsonl(generate_events())).status_code == 409
    assert client.post("/api/v1/replay/control", json={"run_id": run, "action": "unknown"}).status_code == 422
    with pytest.raises(HTTPException, match="1000"):
        parse_jsonl(jsonl(generate_events(count=1000) + [generate_events()[0]]))


def test_period_local_clock_and_order(replay):
    store, now, _ = replay
    source = generate_events(count=2)
    source[1].update(period=2, match_time_ms=1000)
    loaded = store.load(jsonl(source), store.snapshot().state.run_id)
    store.control("play", loaded.state.run_id)
    now[0] = 3
    assert store.snapshot().state.period == 1
    now[0] = 4
    final = store.snapshot()
    assert final.state.period == 2 and final.state.match_time_ms == 1000
    assert final.state.replay_status == "finished"


def test_snapshot_schema_and_post_cors(replay):
    _, _, client = replay
    schemas = [json.loads(path.read_text()) for path in (ROOT / "contracts/schemas").glob("*.json")]
    registry = Registry().with_resources((schema["$id"], Resource.from_contents(schema)) for schema in schemas)
    schema = next(schema for schema in schemas if schema["title"] == "Replay snapshot")
    validator = Draft202012Validator(schema, registry=registry)
    validator.validate(client.get("/api/v1/replay").json())
    fixture = json.loads((ROOT / "contracts/examples/replay.example.json").read_text())
    validator.validate(fixture)
    assert ReplaySnapshot.model_validate(fixture).model_dump(mode="json") == fixture
    preflight = client.options("/api/v1/replay/control", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:5173"
