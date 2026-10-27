"""Azure-mode behaviour with a fake Eventhouse reader.

These tests prove our code paths (explicit mode, no silent fallback, run identity, KQL row mapping
and parity); they do not prove a cloud connection. The live check is docs/ARCHITECTURE.md's smoke test.
"""
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app import main, replay as replay_module
from app.config import ConfigError, Settings, settings
from app.db import Database
from app.eventhouse import EventhouseError, to_event
from app.replay import ReplayStore
from simulator.match import simulate_match

RUN = "smoke-test-run"


def azure_settings(**overrides):
    values = dict(mode="azure", eventhub_namespace="ns.servicebus.windows.net", eventhub_name="omnipitch-events",
                  eventhouse_query_uri="https://example.kusto.fabric.microsoft.com", eventhouse_database="omnipitch",
                  eventhouse_table="OmniPitchEvents", tenant_id=None)
    values.update(overrides)
    return Settings(**values)


def kql_row(event):
    """Shape a KQL row as azure-kusto-data returns it: dynamic points as dicts, empty strings for nulls."""
    row = dict(event)
    for key in ("team_id", "player_id", "possession_id", "attacking_direction"):
        row[key] = row[key] if row[key] is not None else ""
    return row


class FakeReader:
    def __init__(self, events, duplicates=0, error=None):
        self.events_ = events
        self.duplicates = duplicates
        self.error = error

    def _check(self):
        if self.error:
            raise self.error

    def ping(self):
        self._check()
        return {"table": "OmniPitchEvents", "rows": len(self.events_) + self.duplicates}

    def run_summary(self, run_id):
        self._check()
        return {"run_id": run_id, "raw_rows": len(self.events_) + self.duplicates, "unique_events": len(self.events_),
                "duplicate_rows": self.duplicates, "first_sequence": 1, "last_sequence": len(self.events_), "last_ingested": None}

    def events(self, run_id):
        self._check()
        return [to_event(kql_row(e)) for e in self.events_]

    def team_counts(self, run_id):
        self._check()
        from omnipitch_analytics.metrics import team_stats
        rows = []
        for team in ("harbor", "vale"):
            s = team_stats(self.events_, team)
            rows.append({"team_id": team, "pass_attempts": s["passes_attempted"], "passes_completed": s["passes_completed"],
                         "progression_m": s["progression_m"], "shots": s["shots"], "goals": s["goals"],
                         "defensive_actions": s["defensive_actions"]})
        return rows

    def recent_runs(self, limit):
        return [{"run_id": RUN, "unique_events": len(self.events_), "raw_rows": len(self.events_) + self.duplicates}]


@pytest.fixture
def azure(monkeypatch):
    events = simulate_match(7, "standard", run_id=RUN)[:400]
    store = ReplayStore(clock=lambda: 0.0, db=Database(":memory:"), backend_mode="azure")
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "SETTINGS", azure_settings())
    reader = FakeReader(events, duplicates=25)
    monkeypatch.setattr(main, "_reader", reader)
    return store, reader, events, TestClient(main.app)


def test_mode_parsing_and_validation(monkeypatch):
    monkeypatch.setattr("app.config.ENV_FILE", Path("does-not-exist"))
    monkeypatch.setenv("OMNIPITCH_BACKEND_MODE", "cloudy")
    with pytest.raises(ConfigError):
        settings()
    monkeypatch.setenv("OMNIPITCH_BACKEND_MODE", "azure")
    monkeypatch.setenv("EVENTHUB_FULLY_QUALIFIED_NAMESPACE", "Endpoint=sb://x/;SharedAccessKey=abc")
    with pytest.raises(ConfigError, match="not a connection string"):
        settings()
    monkeypatch.setenv("EVENTHUB_FULLY_QUALIFIED_NAMESPACE", "ns.servicebus.windows.net")
    monkeypatch.setenv("EVENTHOUSE_QUERY_URI", "https://x.kusto.fabric.microsoft.com/db")
    with pytest.raises(ConfigError, match="without a path"):
        settings()
    monkeypatch.delenv("EVENTHOUSE_QUERY_URI")
    monkeypatch.delenv("EVENTHOUSE_DATABASE", raising=False)
    current = settings()
    assert current.azure and current.missing() == ["EVENTHOUSE_QUERY_URI", "EVENTHOUSE_DATABASE"]


def test_azure_mode_refuses_local_sources_and_reports_mode(azure):
    _, _, _, client = azure
    run = client.get("/api/v1/replay").json()["state"]["run_id"]
    blocked = client.post("/api/v1/replay/generate", json={"run_id": run, "seed": 1, "scenario": "quiet"})
    assert blocked.status_code == 409 and blocked.json()["detail"]["code"] == "azure_mode"
    assert client.post(f"/api/v1/replay/load?run_id={run}", content="{}").status_code == 409
    ready = client.get("/ready").json()
    assert ready["mode"] == "azure" and ready["analytics"] == "python-adapter-over-eventhouse"
    assert ready["eventhouse"]["eventhouse_database"] == "omnipitch"
    snapshot = client.get("/api/v1/replay").json()
    assert snapshot["replay"]["backend_mode"] == "azure" and snapshot["replay"]["source"] == "simulator"


def test_eventhouse_load_keeps_cloud_run_identity_and_dedup(azure):
    _, _, events, client = azure
    run = client.get("/api/v1/replay").json()["state"]["run_id"]
    snap = client.post("/api/v1/replay/eventhouse", json={"run_id": run, "source_run_id": RUN}).json()
    assert snap["state"]["run_id"] == RUN and snap["replay"]["source"] == "eventhouse"
    assert snap["replay"]["source_run_id"] == RUN and "425 rows, 400 unique events" in snap["replay"]["source_detail"]
    assert snap["total_events"] == 400
    seek = client.post("/api/v1/replay/control", json={"run_id": RUN, "action": "seek", "elapsed_ms": 10**9}).json()
    assert [e["event_id"] for e in seek["events"]] == [e["event_id"] for e in events]
    detail = client.get(f"/api/v1/eventhouse/runs/{RUN}").json()
    assert detail["summary"]["duplicate_rows"] == 25 and detail["events_read"] == 400
    assert detail["parity_ok"] is True
    assert all(w["status"] != "ok" or (w["opponent_passes"] >= 10 and w["defensive_actions"] >= 3) for w in detail["ppda_series"])


def test_eventhouse_errors_are_explicit_not_silent(azure, monkeypatch):
    _, reader, _, client = azure
    reader.error = EventhouseError("forbidden", "Signed in, but no read access.")
    response = client.get("/ready")
    assert response.status_code == 403 and response.json()["detail"]["code"] == "eventhouse_forbidden"
    reader.error = EventhouseError("auth_unavailable", "Run az login.")
    run = client.get("/api/v1/replay").json()["state"]["run_id"]
    failed = client.post("/api/v1/replay/eventhouse", json={"run_id": run, "source_run_id": RUN})
    assert failed.status_code == 503 and failed.json()["detail"]["code"] == "eventhouse_auth_unavailable"
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "simulator"  # Unchanged, and labelled as such.
    monkeypatch.setattr(main, "_reader", None)
    monkeypatch.setattr(main, "SETTINGS", azure_settings(eventhouse_database=None))
    missing = client.get("/ready")
    assert missing.status_code == 503 and missing.json()["detail"]["code"] == "eventhouse_not_configured"


def test_local_mode_rejects_eventhouse_endpoints(monkeypatch):
    monkeypatch.setattr(main, "SETTINGS", azure_settings(mode="local"))
    response = TestClient(main.app).get("/api/v1/eventhouse/runs")
    assert response.status_code == 409 and response.json()["detail"]["code"] == "local_mode"


def test_kql_row_mapping_round_trips_contract():
    from app.schemas import Event
    for event in simulate_match(21, "standard", run_id="map")[:300]:
        assert Event.model_validate(to_event(kql_row(event)), strict=False).model_dump(mode="json") == event


def test_publisher_dry_run_validates_and_reports(tmp_path, monkeypatch):
    from simulator import publish
    schema = (publish.ROOT / "contracts/schemas/event.schema.json").read_text(encoding="utf-8")
    monkeypatch.setattr(publish, "ROOT", tmp_path)
    (tmp_path / "contracts/schemas").mkdir(parents=True)
    (tmp_path / "contracts/schemas/event.schema.json").write_text(schema, encoding="utf-8")
    assert publish.main(["--run-id", "dry", "--count", "50", "--duplicate", "5", "--dry-run"]) == 0
    report = json.loads((tmp_path / "data/generated/publish-dry.json").read_text())
    assert report["unique_events"] == 50 and report["duplicates_requested"] == 5 and report["partition_key"] == "dry:harbor-vale"
    assert publish.explain(Exception("ClientAuthenticationError: Unauthorized 401")).startswith("Signed in, but")


# Judge deployments: a default Eventhouse run on a fresh start (OMNIPITCH_DEFAULT_RUN) --------------------

def _fresh_default(monkeypatch, reader, run="gate-run", restored=False):
    monkeypatch.setattr(main, "SETTINGS", azure_settings())
    monkeypatch.setattr(main, "_reader", reader)
    monkeypatch.setattr(main, "_default_state", {"checked": False, "run": None, "outcome": "not_configured", "error": None, "reloads": 0})
    monkeypatch.setattr(main, "_last_heal", {"at": None})
    monkeypatch.setenv("OMNIPITCH_DEFAULT_RUN", run)
    store = ReplayStore(db=Database(":memory:"), backend_mode="azure")
    store.restored = restored
    monkeypatch.setattr(replay_module, "replay_store", store)
    return store, TestClient(main.app)


def test_default_run_loads_once_on_a_fresh_start(monkeypatch):
    events = simulate_match(7, "standard", run_id="gate-run")[:200]
    store, client = _fresh_default(monkeypatch, FakeReader(events))
    snap = client.get("/api/v1/replay").json()
    assert snap["replay"]["source"] == "eventhouse" and snap["replay"]["source_run_id"] == "gate-run"
    assert snap["total_events"] == 200 and snap["state"]["run_id"] == "gate-run"
    backend = client.get("/api/v1/backend").json()["default_run"]
    assert backend["outcome"] == "loaded" and backend["run"] == "gate-run"
    # Loaded once: a visitor's later choice is never overwritten by the default.
    calls = []
    main._reader.events = lambda run_id: calls.append(run_id) or []
    client.get("/api/v1/replay")
    assert calls == []


def test_default_run_never_replaces_a_restored_replay_and_reports_failures(monkeypatch):
    events = simulate_match(7, "standard", run_id="gate-run")[:50]
    store, client = _fresh_default(monkeypatch, FakeReader(events), restored=True)
    # The start-up load keeps a restored replay; a restored local match is not a cloud run, though, so the self-check
    # replaces it with the default run within the next request or two.
    assert client.get("/api/v1/replay").json()["replay"]["source"] != "eventhouse"
    assert client.get("/api/v1/backend").json()["default_run"]["outcome"] == "reloaded"
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "eventhouse"
    store, client = _fresh_default(monkeypatch, FakeReader(events, error=EventhouseError("eventhouse_unavailable", "down")))
    snap = client.get("/api/v1/replay")
    assert snap.status_code == 200 and snap.json()["replay"]["source"] != "eventhouse"  # Keeps serving; no substitute data.
    default = client.get("/api/v1/backend").json()["default_run"]
    assert default["outcome"] == "failed" and "down" in default["error"]


def test_shared_replay_cannot_be_replaced_or_written_on_the_deployment(azure, monkeypatch):
    # One replay is shared by every visitor: in azure mode it can be watched and steered, never replaced or written.
    monkeypatch.delenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", raising=False)
    _, _, _, client = azure
    run = client.post("/api/v1/replay/eventhouse", json={"run_id": client.get("/api/v1/replay").json()["state"]["run_id"],
                                                         "source_run_id": RUN}).json()["state"]["run_id"]
    refused = client.post("/api/v1/replay/control", json={"run_id": run, "action": "reset"})
    assert refused.status_code == 403 and refused.json()["detail"]["code"] == "replay_changes_disabled"
    assert client.post(f"/api/v1/runs/{run}/ingest", content="{}").status_code == 403
    assert client.post("/api/v1/replay/generate", json={"run_id": run, "seed": 1, "scenario": "quiet"}).status_code == 409
    assert client.post(f"/api/v1/replay/load?run_id={run}", content="{}").status_code == 409
    # Watching still works: play, pause, speed and seek, and the Eventhouse run is still the one on screen.
    for action in ({"action": "play"}, {"action": "pause"}, {"action": "speed", "speed": 5}, {"action": "seek", "elapsed_ms": 60_000}):
        assert client.post("/api/v1/replay/control", json={"run_id": run, **action}).status_code == 200
    snapshot = client.get("/api/v1/replay").json()
    assert snapshot["state"]["run_id"] == RUN and snapshot["replay"]["source"] == "eventhouse"


def test_an_operator_can_allow_replay_changes(azure, monkeypatch):
    monkeypatch.setenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", "1")
    _, _, _, client = azure
    run = client.post("/api/v1/replay/eventhouse", json={"run_id": client.get("/api/v1/replay").json()["state"]["run_id"],
                                                         "source_run_id": RUN}).json()["state"]["run_id"]
    reset = client.post("/api/v1/replay/control", json={"run_id": run, "action": "reset"})
    assert reset.status_code == 200 and reset.json()["replay"]["source"] == "eventhouse"  # Reset keeps the cloud source.
    assert client.post(f"/api/v1/runs/{reset.json()['state']['run_id']}/ingest", content="").status_code == 200


def test_self_check_restores_the_default_run_at_most_once_a_minute(monkeypatch):
    events = simulate_match(7, "standard", run_id="gate-run")[:120]
    store, client = _fresh_default(monkeypatch, FakeReader(events))
    monkeypatch.delenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", raising=False)
    clock = [1000.0]
    monkeypatch.setattr(main, "_now", lambda: clock[0])
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "eventhouse"  # Loaded on the fresh start.
    # Whatever puts a local match on screen, the next request brings the default run back.
    store.generate(store.state.run_id, 7, "standard")
    snap = client.get("/api/v1/replay").json()
    assert snap["replay"]["source"] == "eventhouse" and snap["replay"]["source_run_id"] == "gate-run"
    assert main._default_state["outcome"] == "reloaded" and main._default_state["reloads"] == 1
    # At most once a minute.
    store.generate(store.state.run_id, 7, "standard")
    clock[0] += 30
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "simulator"
    clock[0] += 31
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "eventhouse"
    assert main._default_state["reloads"] == 2
    # An Eventhouse run someone chose is left alone.
    calls = []
    main._reader.events = lambda run_id: calls.append(run_id) or events
    clock[0] += 120
    client.get("/api/v1/replay")
    assert calls == []


def test_self_check_waits_while_an_operator_allows_changes(monkeypatch):
    events = simulate_match(7, "standard", run_id="gate-run")[:120]
    store, client = _fresh_default(monkeypatch, FakeReader(events))
    client.get("/api/v1/replay")
    monkeypatch.setenv("OMNIPITCH_ALLOW_REPLAY_CHANGES", "1")
    store.generate(store.state.run_id, 7, "standard")
    assert client.get("/api/v1/replay").json()["replay"]["source"] == "simulator"


def test_self_check_never_races_the_start_up_load(monkeypatch):
    # While the first request is still loading the default run, other requests must not load it a second time.
    events = simulate_match(7, "standard", run_id="gate-run")[:120]
    store, client = _fresh_default(monkeypatch, FakeReader(events))
    main._default_state["checked"] = True  # The start-up load has begun...
    main._default_state["run"] = "gate-run"
    with main._default_lock:  # ...and is still running.
        main.heal_default_run(store)
        assert store.meta["source"] != "eventhouse" and main._default_state["reloads"] == 0
    main.heal_default_run(store)  # Once it has finished (or failed), the self-check may act.
    assert store.meta["source"] == "eventhouse" and main._default_state["outcome"] == "reloaded"
