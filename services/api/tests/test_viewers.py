"""Per-viewer replays: each browser (X-Viewer) has its own position, speed and match; the shared replay stays put."""
from fastapi.testclient import TestClient
import pytest

from app import main, replay as replay_module

from test_azure_mode import azure_settings
from test_phase4 import make_store


@pytest.fixture
def client(monkeypatch):
    now = [100.0]
    shared, _ = make_store()
    shared.clock = lambda: now[0]
    monkeypatch.setattr(replay_module, "replay_store", shared)
    monkeypatch.setattr(main, "_default_state", {"checked": True, "run": None, "outcome": "not_configured", "error": None, "reloads": 0})
    replay_module.forget_viewers()
    original = replay_module.viewer_store
    monkeypatch.setattr(replay_module, "viewer_store", lambda viewer: original(viewer, clock=lambda: now[0]))
    yield TestClient(main.app), shared, now
    replay_module.forget_viewers()


def get(client, viewer=None):
    return client.get("/api/v1/replay", headers={"X-Viewer": viewer} if viewer else {}).json()


def control(client, viewer, **body):
    run = get(client, viewer)["state"]["run_id"]
    return client.post("/api/v1/replay/control", json={"run_id": run, **body}, headers={"X-Viewer": viewer} if viewer else {})


def test_each_viewer_has_their_own_position(client):
    client, shared, now = client
    control(client, None, action="seek", elapsed_ms=shared.schedule[600])  # The shared match is mid-way.
    a = get(client, "viewer-aaaa-1111")
    # A new viewer starts at kick-off from the shared match: same run (so AI text still matches), not its position.
    assert a["state"]["latest_event_sequence"] == 0 and a["state"]["run_id"] == shared.state.run_id
    control(client, "viewer-aaaa-1111", action="seek", elapsed_ms=shared.schedule[200])
    control(client, "viewer-bbbb-2222", action="seek", elapsed_ms=shared.schedule[900])
    assert get(client, "viewer-aaaa-1111")["state"]["latest_event_sequence"] == 201
    assert get(client, "viewer-bbbb-2222")["state"]["latest_event_sequence"] == 901
    assert get(client)["state"]["latest_event_sequence"] == 601  # Untouched by either viewer.


def test_a_viewer_who_leaves_while_playing_resumes_where_they_were(client):
    client, shared, now = client
    viewer = "viewer-cccc-3333"
    control(client, viewer, action="speed", speed=10)
    control(client, viewer, action="play")
    now[0] += 30  # 30 s at 10x: five match minutes.
    at = get(client, viewer)["replay"]["elapsed_ms"]
    now[0] += 600  # Away for ten minutes.
    back = get(client, viewer)
    assert back["state"]["replay_status"] == "paused"
    assert abs(back["replay"]["elapsed_ms"] - at) < 1  # Paused where they left, not ten minutes later.


def test_viewers_can_replace_their_own_match_even_when_the_shared_one_is_protected(client, monkeypatch):
    client, shared, _ = client
    monkeypatch.setattr(main, "SETTINGS", azure_settings())
    monkeypatch.delenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", raising=False)
    viewer = "viewer-dddd-4444"
    run = get(client, viewer)["state"]["run_id"]
    lines = "\n".join(e.model_dump_json() for e in shared.source[:3])
    loaded = client.post(f"/api/v1/replay/load?run_id={run}", content=lines, headers={"X-Viewer": viewer, "Content-Type": "text/plain"})
    assert loaded.status_code == 200 and loaded.json()["total_events"] == 3
    assert get(client)["total_events"] == len(shared.events)  # The shared match is unchanged.
    # Without a viewer ID the shared match stays protected.
    assert client.post(f"/api/v1/replay/load?run_id={shared.state.run_id}", content=lines,
                       headers={"Content-Type": "text/plain"}).status_code == 409
    assert control(client, None, action="reset").status_code == 403
    assert control(client, viewer, action="reset").status_code == 200


def test_viewer_ids_are_validated_and_the_registry_is_bounded(client, monkeypatch):
    client, shared, _ = client
    assert get(client, "bad id!")["state"]["run_id"] == shared.state.run_id  # Ignored: falls back to the shared replay.
    monkeypatch.setattr(replay_module, "MAX_VIEWERS", 3)
    for i in range(5):
        get(client, f"viewer-eeee-{i:04d}")
    assert len(replay_module._viewers) == 3 and "viewer-eeee-0000" not in replay_module._viewers
