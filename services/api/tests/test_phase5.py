"""Phase 5 gate (experience side): quiet and alternate-seed matches through the whole match room, plus the
API's behaviour when its cloud sources fail. Duplicate and late-event delivery are covered in test_phase2.py
(ledger) and test_bridge.py (bridge); reconnect in test_phase4.py; the deployed check is docs/ROADMAP.md."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
import pytest

from agents.recap import build_recap
from agents.validation import validate_insight
from app import main, replay as replay_module
from app.analysis import AWAY, HOME, narration_context
from app.db import Database
from app.insight_overlay import InsightOverlay
from app.recaps import RecapService
from app.reconciliations import ReconciliationSource
from app.replay import ReplayStore
from app.schemas import Event
from simulator.match import simulate_match

ROOT = Path(__file__).resolve().parents[3]
MATCHES = [("quiet", 1), ("quiet", 7), ("quiet", 21), ("high_press", 3), ("standard", 42)]


def validator(name):
    schemas = [json.loads(path.read_text(encoding="utf-8")) for path in (ROOT / "contracts/schemas").glob("*.json")]
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
    schema = next(s for s in schemas if s["$id"].endswith(f"/{name}.schema.json"))
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def full_match(scenario, seed, overlay=None):
    source = [Event.model_validate(e) for e in simulate_match(seed, scenario, run_id=f"{scenario}-{seed}")]
    store = ReplayStore(clock=lambda: 0.0, db=Database(":memory:"), source=source, overlay=overlay)
    store.control("seek", store.state.run_id, elapsed_ms=store.schedule[-1])
    return store


@pytest.mark.parametrize("scenario,seed", MATCHES)
def test_whole_match_room_holds_for_quiet_and_alternate_seeds(scenario, seed):
    store = full_match(scenario, seed)
    snap = store.snapshot()
    validator("replay").validate(snap.model_dump(mode="json"))
    data = snap.model_dump(mode="json")
    events = {e["event_id"]: e for e in data["events"]}
    goals = sum(e["type"] == "shot" and bool(e.get("is_goal")) for e in data["events"])
    assert data["state"]["score"]["home"] + data["state"]["score"]["away"] == goals

    for moment in data["moments"]:
        # Evidence integrity: every moment points at revealed events of this run, and its insight passes the checks.
        assert moment["evidence_ids"] and all(i in events for i in moment["evidence_ids"])
        actors = sorted({events[i]["player_id"] for i in moment["evidence_ids"] if events[i].get("player_id")})
        assert validate_insight(moment["insight"], moment, narration_context(actors)) == []
        # Fan and analyst texts are two readings of one insight: same numbers available, same IDs.
        assert moment["insight"]["moment_id"] == moment["moment_id"] and moment["insight"]["evidence_ids"] == moment["evidence_ids"]

    events_list, moments = store.recap_inputs()
    recap_schema = validator("recap")
    for scope in ("first_half", "full_time"):
        recap = build_recap(events_list, moments, scope, narration_context([]), HOME["id"], AWAY["id"])
        recap_schema.validate(recap)
        assert recap["status"] == "final" and len(recap["key_moments"]) <= 3
        ids = {m["moment_id"] for m in moments}
        assert all(k["moment_id"] in ids for k in recap["key_moments"])
        trend = recap["tactical_trend"]
        assert trend["supported"] == (trend["values"] is not None)  # No trend text without valid windows.
        level = recap["score"]["home"] == recap["score"]["away"]
        assert ("level at" in recap["headline"].lower()) == level
        assert recap["headline"].startswith("Ends level") == (level and scope == "full_time")


def test_quiet_matches_stay_quiet_in_the_match_room():
    quiet = [len(full_match("quiet", seed).snapshot().moments) for seed in (1, 7, 21)]
    standard = len(full_match("standard", 7).snapshot().moments)
    assert max(quiet) < standard / 2, (quiet, standard)  # A quiet spell stays quiet: nothing invented to fill it.


# Outages: the API reports, keeps serving its last good data, and never substitutes ------------------

def test_cosmos_outage_keeps_the_match_room_serving_with_explicit_status():
    calls = {"fail": False}
    records = []

    def fetch(run_id):
        if calls["fail"]:
            raise ConnectionError("cosmos unreachable")
        return records

    store = full_match("standard", 7, overlay=InsightOverlay(fetch, "cosmos", ttl_s=0))
    store.meta["source_run_id"] = "standard-7"
    before = store.snapshot()
    assert before.insights.status == "ok"
    calls["fail"] = True
    during = store.snapshot()
    assert during.insights.status == "error" and "cosmos unreachable" in during.insights.error
    assert during.state.score == before.state.score and len(during.moments) == len(before.moments)
    calls["fail"] = False
    assert store.snapshot().insights.status == "ok"  # Recovers by itself on the next read.


def test_reconciliation_and_recap_outages_degrade_explicitly(monkeypatch):
    store = full_match("standard", 7)
    store.meta["source_run_id"] = "standard-7"
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_recaps", RecapService())

    def down(run_id):
        raise TimeoutError("cosmos timed out")

    monkeypatch.setattr(main, "_reconciliations", ReconciliationSource(down, "cosmos", ttl_s=0))
    body = TestClient(main.app).get("/api/v1/replay/recap", params={"scope": "full_time"})
    assert body.status_code == 200  # The recap itself never depends on Cosmos.
    payload = body.json()
    assert payload["recap"]["status"] == "final"
    assert payload["reconciliation"]["status"] == "error" and "timed out" in payload["reconciliation"]["error"]


def test_push_outage_leaves_polling_untouched(monkeypatch):
    """negotiate failures are explicit (503 not configured / 502 failed) and the snapshot API keeps answering."""
    store = full_match("quiet", 7)
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.delenv("WEBPUBSUB_ENDPOINT", raising=False)
    monkeypatch.setattr(main, "_PUSH_CLIENT", None)
    client = TestClient(main.app)
    negotiate = client.get("/api/v1/negotiate", params={"run_id": "quiet-7"})
    assert negotiate.status_code == 503 and negotiate.json()["detail"]["code"] == "push_not_configured"

    class Broken:
        def client_url(self, group, minutes):
            raise RuntimeError("Web PubSub HTTP 500 on :generateToken")

    monkeypatch.setenv("WEBPUBSUB_ENDPOINT", "https://example.webpubsub.azure.com")
    monkeypatch.setattr(main, "_PUSH_CLIENT", Broken())
    failed = client.get("/api/v1/negotiate", params={"run_id": "quiet-7"})
    assert failed.status_code == 502 and failed.json()["detail"]["code"] == "push_negotiate_failed"
    assert "access_token" not in failed.text
    assert client.get("/api/v1/replay").status_code == 200
