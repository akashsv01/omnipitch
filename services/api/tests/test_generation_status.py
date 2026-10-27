"""Generation states: every published insight says how its text was produced, and a deliberate skip is never
reported as an AI failure (insight.schema.json generation_status)."""
import pytest

from agents.insights import SqliteInsightStore, classify
from agents.model import ModelError, ModelTimeout
from agents.narrate import build_fallback_insight
from agents.worker import INSIGHT_VALIDATOR
from app.insight_overlay import InsightOverlay
from simulator.match import simulate_match

from test_narration import (RUN, ROLE_OK, Clock, ScriptedModel, bad_broadcaster, context_for, good_broadcaster,
                            moments_for_test, seeded_store, worker)


@pytest.fixture
def setup():
    moment = next(m for m in moments_for_test() if m["rule"] == "threat_gain")
    return moment, seeded_store([moment]), SqliteInsightStore(":memory:"), Clock()


def published(insights, moment):
    record = insights.get_insight(moment["moment_id"])
    assert not list(INSIGHT_VALIDATOR.iter_errors(record["insight"]))
    return record["insight"]


def test_accepted_ai_output_is_ai_accepted(setup):
    moment, store, insights, clock = setup
    worker(store, insights, ScriptedModel({**ROLE_OK, "broadcaster": [good_broadcaster(moment)]}), clock).process_one()
    insight = published(insights, moment)
    assert insight["generation_status"] == "ai_accepted" and insight["generation_reason"] is None


def test_rejected_output_is_rejected_not_failure(setup):
    moment, store, insights, clock = setup
    worker(store, insights, ScriptedModel({**ROLE_OK, "broadcaster": [bad_broadcaster(moment)]}), clock).process_one()
    insight = published(insights, moment)
    assert insight["generation_status"] == "rejected" and "validation" in insight["generation_reason"]


def test_provider_errors_are_provider_failure(setup):
    moment, store, insights, clock = setup
    model = ScriptedModel({"analyst": [ModelError("HTTP 500")], "coach": ROLE_OK["coach"], "broadcaster": [{}]})
    worker(store, insights, model, clock).process_one()
    assert published(insights, moment)["generation_status"] == "provider_failure"


def test_timeout_on_last_attempt_is_provider_failure(setup):
    moment, store, insights, clock = setup
    model = ScriptedModel({"analyst": [ModelTimeout("slow")], "coach": ROLE_OK["coach"], "broadcaster": [{}]})
    w = worker(store, insights, model, clock)
    assert w.process_one()["status"] == "retry_wait"
    assert insights.get_insight(moment["moment_id"]) is None  # Nothing published while a retry is pending.
    clock.advance(60)
    w.process_one()
    assert published(insights, moment)["generation_status"] == "provider_failure"


@pytest.mark.parametrize("reason", ["no model configured", "fallback-only run", "AI job cap reached (budget)"])
def test_no_model_or_budget_is_skipped_not_failure(setup, reason):
    moment, store, insights, clock = setup
    worker(store, insights, None, clock, no_model_reason=reason).process_one()
    insight = published(insights, moment)
    assert insight["generation_status"] == "skipped" and insight["generation_reason"] == reason


def test_local_templates_are_rule_based_by_design(setup):
    moment = setup[0]
    insight = build_fallback_insight(moment, context_for(moment))
    assert insight["generation_status"] == "rule_based" and insight["generation_reason"] is None


def test_records_from_before_the_field_are_classified_honestly(setup):
    moment = setup[0]
    ai = {"insight": {**build_fallback_insight(moment, context_for(moment)), "generation_mode": "ai"}}
    for record in (ai,):
        record["insight"].pop("generation_status"); record["insight"].pop("generation_reason")
    assert classify(ai) == ("ai_accepted", None)

    def legacy(reason, trace=None):
        insight = build_fallback_insight(moment, context_for(moment), reason)
        insight.pop("generation_status"); insight.pop("generation_reason")
        return {"insight": insight, "trace": trace or {}}

    assert classify(legacy("no model configured"))[0] == "skipped"
    assert classify(legacy("fallback-only (AI job cap reached)"))[0] == "skipped"
    assert classify(legacy("output failed validation after one repair", {"rejected": ["x"]}))[0] == "rejected"
    assert classify(legacy("ModelTimeout on the last attempt", {"error": "ModelTimeout: slow"}))[0] == "provider_failure"
    assert classify(legacy(None))[0] == "rule_based"


def test_overlay_marks_pending_and_api_rejections():
    events = simulate_match(7, "standard", run_id=RUN)[:400]
    moments = [m for m in moments_for_test() if m["rule"] in ("threat_gain", "transition")][:2]
    for m in moments:
        m["insight"] = build_fallback_insight(m, context_for(m))
    narrated, missing = moments
    bad = {**build_fallback_insight(narrated, context_for(narrated)), "generation_mode": "ai",
           "casual_text": "The pass raised the scoring probability."}
    overlay = InsightOverlay(lambda run: [{"moment_id": narrated["moment_id"], "run_id": RUN, "insight": bad, "trace": {}}], "cosmos")
    out, status = overlay.apply(moments, events, RUN)
    by_id = {m["moment_id"]: m["insight"] for m in out}
    assert by_id[narrated["moment_id"]]["generation_status"] == "rejected"
    assert by_id[narrated["moment_id"]]["generation_mode"] == "fallback"  # Template shown, never the rejected text.
    assert by_id[missing["moment_id"]]["generation_status"] == "pending"
    assert status["rejected"] == 1


def test_stored_rule_based_text_is_rebuilt_from_frozen_evidence():
    """A run stored before a wording fix shows the current template; its evidence stays exactly as stored."""
    import json as _json
    from test_phase4 import first_period_end, make_store, seek_to_sequence
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    moment = store.snapshot().moments[0].model_dump(mode="json")
    row = store.db.connection.execute("SELECT payload FROM moments WHERE moment_id = ?", (moment["moment_id"],)).fetchone()
    record = _json.loads(row[0])
    record["insight"]["headline"] = "Old wording: they press higher"
    store.db.connection.execute("UPDATE moments SET payload = ? WHERE moment_id = ?", (_json.dumps(record), moment["moment_id"]))
    store._cache = None
    served = next(m for m in store.snapshot().moments if m.moment_id == moment["moment_id"]).model_dump(mode="json")
    assert served["insight"]["headline"] == moment["insight"]["headline"] != record["insight"]["headline"]
    assert served["evidence_ids"] == record["evidence_ids"] and served["metrics"] == record["metrics"]
