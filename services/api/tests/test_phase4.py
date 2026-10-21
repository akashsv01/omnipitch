"""Phase 4 gates: narrated-insight overlay, halftime/full-time recaps, the recap endpoint, reconnect
restoring score, clock and insights, and fan/analyst modes sharing the same facts. No tokens are spent."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
import pytest

from agents.recap import build_recap, narrate_recap
from agents.validation import validate_insight
from app import main, replay as replay_module
from app.analysis import AWAY, HOME, narration_context
from app.db import Database
from app.insight_overlay import InsightOverlay
from app.recaps import RecapService
from app.replay import ReplayStore
from app.schemas import Event
from simulator.match import simulate_match

ROOT = Path(__file__).resolve().parents[3]
SOURCE = "p4-src"


def schema_validator(name):
    schemas = [json.loads(path.read_text()) for path in (ROOT / "contracts/schemas").glob("*.json")]
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
    schema = next(s for s in schemas if s["$id"].endswith(f"/{name}.schema.json"))
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


class FakeInsights:
    """Stands in for the Cosmos `insights` container: records keyed by the source run's moment IDs."""

    def __init__(self):
        self.records, self.calls, self.fail = [], 0, False

    def __call__(self, run_id):
        self.calls += 1
        if self.fail:
            raise ConnectionError("cosmos unreachable")
        return [r for r in self.records if r["run_id"] == run_id]

    def add(self, moment, **changes):
        suffix = moment["moment_id"].split(":", 1)[1]
        insight = {**moment["insight"], "generation_mode": "ai", **changes}
        self.records.append({"insight_id": f"{SOURCE}:{suffix}", "run_id": SOURCE, "moment_id": f"{SOURCE}:{suffix}",
                             "insight": {**insight, "run_id": SOURCE, "moment_id": f"{SOURCE}:{suffix}"}})


def make_store(db=None, fetch=None, now=None):
    now = now if now is not None else [0.0]
    source = [Event.model_validate(e) for e in simulate_match(7, "standard", run_id=SOURCE)]
    overlay = InsightOverlay(fetch, "cosmos" if fetch else "off", ttl_s=0)
    store = ReplayStore(clock=lambda: now[0], db=db or Database(":memory:"), source=source[:5], overlay=overlay)
    # Upload the source run's events, as the UI does: the file's run ID becomes the insight source.
    store.load("\n".join(e.model_dump_json() for e in source), store.state.run_id)
    assert store.meta["source_run_id"] == SOURCE
    return store, now


def seek_to_sequence(store, sequence):
    store.control("seek", store.state.run_id, elapsed_ms=store.schedule[sequence - 1])
    revealed = store.state.latest_event_sequence
    # Simultaneous events share a replay time (period_end and the next period_start), so a seek can reveal both.
    assert revealed >= sequence and all(e["type"].startswith("period_") for e in store.dicts[sequence:revealed])


def first_period_end(store):
    return next(e["sequence"] for e in store.dicts if e["type"] == "period_end" and e["period"] == 1)


# Overlay ------------------------------------------------------------------------------------------

def test_overlay_shows_valid_insights_rejects_bad_ones_and_reports_errors():
    fake = FakeInsights()
    store, _ = make_store(fetch=fake)
    seek_to_sequence(store, 600)
    base = store.snapshot()
    assert base.insights.status == "ok" and base.insights.narrated == 0 and base.insights.version == "none"
    moments = [m.model_dump(mode="json") for m in base.moments]
    assert len(moments) >= 3
    good, bad = moments[0], moments[1]
    fake.add(good)
    fake.add(bad, analyst_text=bad["insight"]["analyst_text"] + " They broke through the defence.")
    snap = store.snapshot()
    by_id = {m.moment_id: m for m in snap.moments}
    assert by_id[good["moment_id"]].insight.generation_mode == "ai"
    assert by_id[bad["moment_id"]].insight.generation_mode == "fallback"  # Our own checks still apply.
    assert (snap.insights.narrated, snap.insights.ai, snap.insights.rejected) == (1, 1, 1)
    version = snap.insights.version
    assert version != "none"

    fake.add(moments[2])
    assert store.snapshot().insights.version != version  # The UI refetches in full when this changes.

    fake.fail = True
    failed = store.snapshot()
    assert failed.insights.status == "error" and "ConnectionError" in failed.insights.error
    assert failed.insights.narrated == 2  # Last good copy kept, and the failure is reported, not hidden.


def test_overlay_off_and_misconfigured_are_explicit():
    store, _ = make_store()
    assert store.snapshot().insights.model_dump()["mode"] == "off"
    broken = InsightOverlay(None, "cosmos")
    _, status = broken.apply([], [], SOURCE)
    assert status["status"] == "error" and status["error"]


# Recaps -------------------------------------------------------------------------------------------

def recap_for(store, scope):
    events, moments = store.recap_inputs()
    return build_recap(events, moments, scope, narration_context([]), HOME["id"], AWAY["id"])


def test_recap_scopes_status_and_key_moments_link_to_verified_moments():
    store, _ = make_store()
    validate = schema_validator("recap")
    assert recap_for(store, "first_half") is None  # Nothing revealed yet.
    end = first_period_end(store)
    seek_to_sequence(store, end - 30)
    provisional = recap_for(store, "first_half")
    assert provisional["status"] == "provisional" and recap_for(store, "full_time") is None
    seek_to_sequence(store, end)
    final = recap_for(store, "first_half")
    validate.validate(final)
    assert final["status"] == "final" and final["through_sequence"] == end  # Scope stops at its own period_end.
    events, moments = store.recap_inputs()
    by_id = {m["moment_id"]: m for m in moments}
    possession = {e["event_id"]: e["possession_id"] for e in events}
    assert 1 <= len(final["key_moments"]) <= 3
    assert final["sources"] == [k["moment_id"] for k in final["key_moments"]]
    seen = set()
    for key in final["key_moments"]:
        moment = by_id[key["moment_id"]]  # Every key moment is a verified moment of this run.
        assert moment["period"] == 1 and key["headline"] == moment["insight"]["headline"]
        assert key["replay_ms"] == moment["replay_ms"]
        owner = possession[moment["evidence_ids"][0]]
        assert owner not in seen
        seen.add(owner)
    order = [(by_id[k["moment_id"]]["period"], by_id[k["moment_id"]]["match_time_ms"]) for k in final["key_moments"]]
    assert order == sorted(order)
    goals = sum(e["type"] == "shot" and e.get("is_goal") for e in events if e["period"] == 1)
    assert final["score"]["home"] + final["score"]["away"] == goals

    seek_to_sequence(store, len(store.dicts))
    full = recap_for(store, "full_time")
    validate.validate(full)
    assert full["status"] == "final" and full["through_sequence"] == len(store.dicts)
    trend = full["tactical_trend"]
    assert trend["supported"] == (trend["values"] is not None)


def test_recap_ai_rewrite_is_checked_and_falls_back_with_reason():
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    recap = recap_for(store, "first_half")
    context = narration_context([])

    class Model:
        name = "fake"

        def __init__(self, out):
            self.out = out

        def complete(self, role, messages, timeout):
            return dict(self.out)

    good, reason = narrate_recap(recap, context, HOME["id"], AWAY["id"], Model({"headline": recap["headline"], "summary": recap["summary"]}))
    assert reason is None and good["generation_mode"] == "ai"
    bad, reason = narrate_recap(recap, context, HOME["id"], AWAY["id"],
                                Model({"headline": recap["headline"], "summary": recap["summary"] + " They had 97 touches."}))
    assert bad["generation_mode"] == "fallback" and "97" in reason

    service = RecapService(Model({"headline": recap["headline"], "summary": recap["summary"]}), requested=True, background=False)
    events, moments = store.recap_inputs()
    result = service.recap(events, moments, "first_half")
    assert result["ai"]["status"] == "ready" and result["recap"]["generation_mode"] == "ai"
    assert RecapService().recap(events, moments, "first_half")["ai"]["status"] == "off"


def test_recap_endpoint(monkeypatch):
    store, _ = make_store()
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_recaps", RecapService())
    client = TestClient(main.app)
    missing = client.get("/api/v1/replay/recap", params={"scope": "first_half"})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "recap_not_available"
    assert client.get("/api/v1/replay/recap", params={"scope": "extra_time"}).status_code == 422
    seek_to_sequence(store, first_period_end(store))
    body = client.get("/api/v1/replay/recap", params={"scope": "first_half"}).json()
    schema_validator("recap").validate(body["recap"])
    assert body["recap"]["status"] == "final" and body["ai"]["status"] == "off"
    # The second half's period_start shares the break's replay time, so a provisional full-time recap exists.
    full = client.get("/api/v1/replay/recap", params={"scope": "full_time"}).json()["recap"]
    assert full["status"] == "provisional" and full["score"] == body["recap"]["score"]


# Reconnect and audiences ------------------------------------------------------------------------

def test_reconnect_restores_score_clock_and_insights(tmp_path):
    fake = FakeInsights()
    db_path = str(tmp_path / "replay.db")
    store, now = make_store(db=Database(db_path), fetch=fake)
    seek_to_sequence(store, first_period_end(store) + 40)
    fake.add(store.snapshot().moments[0].model_dump(mode="json"))
    before = store.snapshot()

    # A full refetch (what the browser does on reconnect) and a restarted API both rebuild the same view.
    again = store.snapshot(before.state.run_id, after_sequence=0)
    overlay = InsightOverlay(fake, "cosmos", ttl_s=0)
    restarted = ReplayStore(clock=lambda: now[0], db=Database(db_path), overlay=overlay)
    after = restarted.snapshot()
    assert restarted.restored and after.replay.restored
    for snap in (again, after):
        assert snap.state.score == before.state.score
        assert snap.state.latest_event_sequence == before.state.latest_event_sequence
        assert (snap.replay.clock_period, snap.replay.clock_ms) == (before.replay.clock_period, before.replay.clock_ms)
        assert [(m.moment_id, m.insight.headline, m.insight.generation_mode) for m in snap.moments] == \
               [(m.moment_id, m.insight.headline, m.insight.generation_mode) for m in before.moments]
        assert snap.insights.version == before.insights.version and snap.insights.narrated == 1


def test_fan_and_analyst_modes_share_the_same_facts():
    """Both audiences read one insight per moment: the same evidence, metrics and checks."""
    store, _ = make_store()
    seek_to_sequence(store, len(store.dicts))
    snap = store.snapshot()
    actors_of = {e.event_id: e.player_id for e in snap.events}
    assert snap.moments
    for moment in snap.moments:
        data = moment.model_dump(mode="json")
        actors = sorted({actors_of[i] for i in data["evidence_ids"] if actors_of.get(i)})
        assert validate_insight(data["insight"], data, narration_context(actors)) == []
        assert data["insight"]["moment_id"] == data["moment_id"]
        assert data["insight"]["evidence_ids"] == data["evidence_ids"]


def test_cosmos_overlay_setup_failure_is_reported_not_raised(monkeypatch):
    import builtins
    from app import insight_overlay
    real_import = builtins.__import__

    def failing_import(name, *args, **kwargs):
        if name == "agents.insights":
            raise ModuleNotFoundError("No module named 'omnipitch_bridge'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setenv("OMNIPITCH_INSIGHTS", "cosmos")
    monkeypatch.setenv("COSMOS_ENDPOINT", "https://example.documents.azure.com:443/")
    monkeypatch.setattr(builtins, "__import__", failing_import)
    overlay = insight_overlay.from_env()
    monkeypatch.setattr(builtins, "__import__", real_import)
    moments, status = overlay.apply([], [], SOURCE)
    assert status["status"] == "error" and "omnipitch_bridge" in status["error"]


def test_api_import_path_includes_the_bridge_client():
    """The API process (not just pytest) must be able to build the Cosmos insight store."""
    import subprocess
    import sys
    code = ("import sys; from app import sample_data; "
            "import importlib; importlib.import_module('omnipitch_bridge.cosmos_store'); print('ok')")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT / "services/api", capture_output=True, text=True)
    assert out.stdout.strip() == "ok", out.stderr[-400:]


def test_model_usage_is_recorded_per_role_in_the_trace():
    """PR #14 request: total tokens per role in the insight trace (read by bridge trace_report)."""
    from types import SimpleNamespace
    from agents.model import AzureOpenAIClient, AzureOpenAIConfig
    from agents.workflow import _call, Deadline

    class Http:
        def post(self, url, json, timeout, headers):
            body = {"choices": [{"message": {"content": '{"ok": true}'}}],
                    "usage": {"prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020}}
            return SimpleNamespace(status_code=200, headers={}, text="", json=lambda: body)

    credential = SimpleNamespace(get_token=lambda scope: SimpleNamespace(token="test-token"))
    client = AzureOpenAIClient(AzureOpenAIConfig("https://example.openai.azure.com", "dep"), credential=credential, http=Http())
    trace = {}
    assert _call(client, "analyst", [], Deadline(30), 10, trace) == {"ok": True}
    assert trace["analyst"]["usage"] == {"prompt_tokens": 900, "completion_tokens": 120, "total_tokens": 1020}
    from omnipitch_bridge.trace import model_usage
    assert model_usage([{"insight": {"generation_mode": "ai"}, "trace": trace}])["tokens"] == 1020
