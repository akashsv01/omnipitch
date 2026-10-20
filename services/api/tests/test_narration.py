"""Narration worker against the bridge's SqliteStore and a scripted fake model (no tokens spent)."""
from datetime import datetime, timedelta, timezone
import random
import threading
import time

import pytest

from agents.insights import SqliteInsightStore
from agents.model import ModelError, ModelRateLimited, ModelTimeout
from agents.narrate import build_fallback_insight
from agents.validation import validate_insight
from agents.worker import INSIGHT_VALIDATOR, NarrationWorker
from app.analysis import narration_context
from omnipitch_analytics.detect import detect_moments
from omnipitch_bridge.store import SqliteStore, new_job
from simulator.match import simulate_match

RUN = "narration-test"
T0 = datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc)


def context_for(moment):
    return narration_context([])


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


class ScriptedModel:
    """Per-role scripts; each entry is a dict to return or an exception to raise. The last entry repeats."""
    name = "fake-model"

    def __init__(self, scripts, delay=0.0):
        self.scripts = {role: list(entries) for role, entries in scripts.items()}
        self.calls, self.delay, self.lock = [], delay, threading.Lock()

    def complete(self, role, messages, timeout):
        with self.lock:
            self.calls.append(role)
            entries = self.scripts.get(role) or self.scripts.get("broadcaster" if role.startswith("broadcaster") else role)
            entry = entries.pop(0) if len(entries) > 1 else entries[0]
        if self.delay:
            time.sleep(self.delay)
        if isinstance(entry, Exception):
            raise entry
        return dict(entry)


def moments_for_test(count=None):
    events = simulate_match(7, "standard", run_id=RUN)[:400]
    moments = detect_moments(events, RUN, "harbor-vale", ["harbor", "vale"])
    return moments if count is None else moments[:count]


def seeded_store(moments):
    store = SqliteStore(":memory:")
    for moment in moments:
        store.create_moment(moment, T0)
        store.create_job(new_job(moment, T0))
    return store


def good_broadcaster(moment):
    """A rephrasing that adds no facts: built from the validated template text."""
    base = build_fallback_insight(moment, context_for(moment))
    return {"headline": base["headline"], "casual_text": base["casual_text"] + " A promising moment.",
            "analyst_text": base["analyst_text"], "evidence_ids": base["evidence_ids"][:1]}


def bad_broadcaster(moment):
    out = good_broadcaster(moment)
    out["casual_text"] = "That pass travelled 41 m and raised the scoring probability."
    return out


ROLE_OK = {"analyst": [{"facts": ["supported"], "limitations": []}],
           "coach": [{"interpretation": "consistent with progression", "confidence": "low", "evidence_ids": []}]}


def worker(store, insights, model, clock, owner="w1", **kwargs):
    return NarrationWorker(store, insights, model, owner, context_for, clock=clock, rng=random.Random(1), **kwargs)


@pytest.fixture
def one_moment():
    moment = next(m for m in moments_for_test() if m["rule"] == "threat_gain")
    return moment, seeded_store([moment]), SqliteInsightStore(":memory:"), Clock()


def test_valid_ai_output_publishes_ready_insight(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({**ROLE_OK, "broadcaster": [good_broadcaster(moment)]})
    result = worker(store, insights, model, clock).process_one()
    assert result["status"] == "ready" and result["insight_created"]
    job = store.get_job(moment["moment_id"])
    assert job["status"] == "ready" and job["insight_id"] == moment["moment_id"] and job["lease_owner"] is None
    insight = insights.get_insight(moment["moment_id"])["insight"]
    assert insight["generation_mode"] == "ai"
    assert insight["metrics"] == moment["metrics"]  # Authoritative values copied, never model-written.
    assert not validate_insight(insight, moment, context_for(moment))
    assert not list(INSIGHT_VALIDATOR.iter_errors(insight))
    assert sorted(model.calls) == ["analyst", "broadcaster", "coach"]  # No repair needed.


def test_invalid_output_is_repaired_once(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({**ROLE_OK, "broadcaster": [bad_broadcaster(moment), good_broadcaster(moment)]})
    result = worker(store, insights, model, clock).process_one()
    assert result["status"] == "ready"
    assert model.calls.count("broadcaster_repair") == 1
    assert insights.get_insight(moment["moment_id"])["trace"]["repair"] is True


def test_invalid_after_repair_falls_back_with_reason(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({**ROLE_OK, "broadcaster": [bad_broadcaster(moment)]})
    result = worker(store, insights, model, clock).process_one()
    assert result["status"] == "fallback"
    assert model.calls.count("broadcaster_repair") == 1  # Exactly one repair, then stop.
    job = store.get_job(moment["moment_id"])
    assert job["status"] == "fallback" and "validation" in job["last_error"]
    record = insights.get_insight(moment["moment_id"])
    assert record["insight"]["generation_mode"] == "fallback"
    assert any("failed validation" in limitation for limitation in record["insight"]["limitations"])
    assert record["trace"]["rejected"]  # Kept for debugging, never shown as an insight.


def test_timeout_then_retry_wait_then_fallback_on_last_attempt(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({"analyst": [ModelTimeout("slow")], "coach": ROLE_OK["coach"],
                           "broadcaster": [good_broadcaster(moment)]})
    w = worker(store, insights, model, clock)
    first = w.process_one()
    job = store.get_job(moment["moment_id"])
    assert first["status"] == "retry_wait" and job["status"] == "retry_wait" and job["attempt"] == 1
    assert insights.get_insight(moment["moment_id"]) is None
    assert w.process_one() is None  # Not due yet: bounded backoff is respected.
    clock.advance(10 * 1.25 + 1)
    second = w.process_one()
    job = store.get_job(moment["moment_id"])
    assert second["status"] == "fallback" and job["attempt"] == 2 and job["status"] == "fallback"
    assert "last attempt" in job["last_error"]
    assert insights.get_insight(moment["moment_id"])["insight"]["generation_mode"] == "fallback"


def test_rate_limit_uses_retry_after(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({"analyst": [ModelRateLimited("429", retry_after=30)], "coach": ROLE_OK["coach"],
                           "broadcaster": [good_broadcaster(moment)]})
    worker(store, insights, model, clock).process_one()
    job = store.get_job(moment["moment_id"])
    wait = (datetime.fromisoformat(job["next_attempt_at"].replace("Z", "+00:00")) - T0).total_seconds()
    assert job["status"] == "retry_wait" and 30 <= wait <= 30 * 1.25


def test_non_transient_error_and_no_model_fall_back_without_retry(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({"analyst": [ModelError("HTTP 400")], "coach": ROLE_OK["coach"], "broadcaster": [{}]})
    assert worker(store, insights, model, clock).process_one()["status"] == "fallback"
    assert store.get_job(moment["moment_id"])["attempt"] == 1
    other = next(m for m in moments_for_test() if m["rule"] == "transition")
    store2 = seeded_store([other])
    result = worker(store2, SqliteInsightStore(":memory:"), None, clock).process_one()
    assert result["status"] == "fallback" and "no model configured" in result["error"]


def test_two_workers_never_narrate_the_same_job():
    moments = moments_for_test(12)
    store, insights, clock = seeded_store(moments), SqliteInsightStore(":memory:"), Clock()
    scripts = {**ROLE_OK, "broadcaster": [{"headline": "", "casual_text": "", "analyst_text": "", "evidence_ids": []}]}
    results: dict[str, list] = {"a": [], "b": []}

    def run(name):
        results[name] = worker(store, insights, ScriptedModel(scripts, delay=0.01), clock, owner=name).drain()

    threads = [threading.Thread(target=run, args=(name,)) for name in results]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    handled = [r["job_id"] for name in results for r in results[name]]
    assert sorted(handled) == sorted(m["moment_id"] for m in moments)  # Every job exactly once.
    assert results["a"] and results["b"]  # Both workers did work.
    assert all(r["insight_created"] and r["status"] != "lost_lease" for name in results for r in results[name])
    assert len(insights.insights(RUN)) == len(moments)


def test_duplicate_claim_after_lease_expiry_publishes_one_insight(one_moment):
    moment, store, insights, clock = one_moment
    slow = worker(store, insights, ScriptedModel({**ROLE_OK, "broadcaster": [good_broadcaster(moment)]}), clock, owner="slow")
    fast = worker(store, insights, ScriptedModel({**ROLE_OK, "broadcaster": [good_broadcaster(moment)]}), clock, owner="fast")
    stale_job = store.claim_next("slow", clock(), slow.lease)  # Slow worker claims, then stalls past its lease.
    clock.advance(slow.lease.total_seconds() + 1)
    won = fast.process_one()
    assert won["status"] == "ready" and won["attempt"] == 2 and won["insight_created"]
    late = slow.handle(stale_job)  # The stalled worker finishes afterwards.
    assert late["status"] == "lost_lease" and not late["insight_created"]
    assert len(insights.insights(RUN)) == 1
    job = store.get_job(moment["moment_id"])
    assert job["status"] == "ready" and job["insight_id"] == moment["moment_id"]


def test_budget_must_fit_inside_lease(one_moment):
    moment, store, insights, clock = one_moment
    with pytest.raises(ValueError):
        worker(store, insights, None, clock, lease=timedelta(seconds=30), budget_s=45)


def test_every_detected_rule_falls_back_to_a_valid_insight():
    moments = moments_for_test()
    store, insights, clock = seeded_store(moments), SqliteInsightStore(":memory:"), Clock()
    results = worker(store, insights, None, clock).drain()
    assert len(results) == len(moments) and {r["status"] for r in results} == {"fallback"}
    for record in insights.insights(RUN):
        assert not list(INSIGHT_VALIDATOR.iter_errors(record["insight"]))


def test_run_scoped_worker_never_claims_or_expires_other_runs():
    mine = moments_for_test(4)
    others = [dict(m, run_id="someone-else", moment_id=m["moment_id"].replace(RUN, "someone-else")) for m in mine]
    store, insights, clock = seeded_store(mine + others), SqliteInsightStore(":memory:"), Clock()
    # Another run has an abandoned last attempt; only the bridge's global recovery may expire it.
    abandoned = store.claim_next("crashed", clock(), timedelta(seconds=10), run_id="someone-else")
    store.complete(abandoned, "crashed", clock(), "retry_wait", error="x", retry_after=timedelta(0))
    store.claim_next("crashed", clock(), timedelta(seconds=10), run_id="someone-else")
    clock.advance(11)
    w = worker(store, insights, None, clock, run_id=RUN)
    assert w.recover() == []  # Own run has nothing abandoned; the other run is not touched.
    results = w.drain()
    assert sorted(r["job_id"] for r in results) == sorted(m["moment_id"] for m in mine)
    other = store.jobs("someone-else")
    assert sorted(j["status"] for j in other) == ["pending"] * 3 + ["processing"]
    assert worker(store, insights, None, clock).recover() == []  # Unscoped workers leave recovery to the bridge.


def test_error_records_which_deployment_failed_and_no_model_reason_is_honest(one_moment):
    moment, store, insights, clock = one_moment
    model = ScriptedModel({"analyst": [ModelError("HTTP 404 DeploymentNotFound")], "coach": ROLE_OK["coach"], "broadcaster": [{}]})
    result = worker(store, insights, model, clock).process_one()
    assert result["status"] == "fallback" and "model error (fake-model)" in result["error"]
    assert insights.get_insight(moment["moment_id"])["trace"] == {"model": "fake-model", "error": "ModelError: HTTP 404 DeploymentNotFound"}
    other = next(m for m in moments_for_test() if m["rule"] == "transition")
    capped = worker(seeded_store([other]), SqliteInsightStore(":memory:"), None, clock,
                    no_model_reason="gate cost cap: remaining jobs narrated without the model").process_one()
    assert capped["error"].startswith("gate cost cap")


class FakeContainer:
    """Minimal Cosmos container semantics: create_item raises 409 on an existing id."""

    def __init__(self):
        self.items = {}

    def create_item(self, body):
        from azure.cosmos.exceptions import CosmosResourceExistsError
        key = (body["run_id"], body["id"])
        if key in self.items:
            raise CosmosResourceExistsError(status_code=409, message="Conflict")
        self.items[key] = dict(body, _etag="e", _ts=1)

    def read_item(self, item, partition_key):
        from azure.cosmos.exceptions import CosmosResourceNotFoundError
        try:
            return self.items[(partition_key, item)]
        except KeyError:
            raise CosmosResourceNotFoundError(status_code=404, message="Not found")

    def query_items(self, query, parameters=None, partition_key=None, enable_cross_partition_query=False):
        rows = [v for (run, _), v in self.items.items() if partition_key is None or run == partition_key]
        if parameters:
            rows = [v for v in rows if v["id"] == parameters[0]["value"]]
        return rows

    def delete_item(self, item, partition_key):
        self.items.pop((partition_key, item))


class FakeCosmosClient:
    def __init__(self):
        self.container = FakeContainer()

    def get_database_client(self, name):
        return self

    def get_container_client(self, name):
        return self.container


def test_cosmos_insight_store_never_overwrites(one_moment):
    from agents.insights import CosmosInsightStore
    moment, store, _, clock = one_moment
    cosmos = CosmosInsightStore("https://example.documents.azure.com:443/", client=FakeCosmosClient())
    model = ScriptedModel({**ROLE_OK, "broadcaster": [good_broadcaster(moment)]})
    first = worker(store, cosmos, model, clock).process_one()
    assert first["status"] == "ready" and first["insight_created"]
    record = cosmos.get_insight(moment["moment_id"], RUN)
    assert record["insight"]["generation_mode"] == "ai" and "_etag" not in record and "id" not in record
    rival = dict(record, insight={**record["insight"], "headline": "overwritten?"}, worker="rival")
    assert cosmos.create_insight(rival) is False  # 409: existing id is a no-op.
    assert cosmos.get_insight(moment["moment_id"])["insight"]["headline"] == record["insight"]["headline"]
    assert len(cosmos.insights(RUN)) == 1
    cosmos.purge_run(RUN)
    assert cosmos.insights(RUN) == []


def test_prose_may_cite_own_evidence_ids_but_not_others(one_moment):
    moment, *_ = one_moment
    context = context_for(moment)
    cited = dict(build_fallback_insight(moment, context))
    own = moment["evidence_ids"][0]
    cited["analyst_text"] = cited["analyst_text"] + f" See {own}."
    assert validate_insight(cited, moment, context) == []  # Own evidence ID digits are not numeric claims.
    cited["analyst_text"] = cited["analyst_text"] + " Also evt-9999."
    assert any("unknown evidence ID in text" in error for error in validate_insight(cited, moment, context))
    cited["analyst_text"] = "The move took 48.583 minutes."  # A computed number is still rejected.
    assert any("unsupported number '48.583'" in error for error in validate_insight(cited, moment, context))


def test_evidence_packet_gives_clock_label_not_milliseconds(one_moment):
    from agents.prompts import evidence_packet
    moment, *_ = one_moment
    packet = evidence_packet(moment, context_for(moment))
    assert "match_time_ms" not in packet and packet["clock"].endswith("'")


def _moment(rule):
    return next(m for m in moments_for_test() if m["rule"] == rule)


@pytest.mark.parametrize("rule,text,expected", [
    # The four meaning errors seen on the live gate runs (2026-10-20), verbatim in spirit.
    ("chance", "The save kept the score level.", "score state"),
    ("chance", "A good chance from outside the box.", "outside the box"),
    ("goal", "He finished a quick three-pass move.", "pass count"),
    ("goal", "A sharp attack that broke through Harbor's defense.", "defenders broken through"),
    ("goal", "The attack penetrated the back line.", "defenders broken through"),
    ("threat_gain", "Vale lead 1-0 after this pass.", "score state"),
    ("transition", "A long-range effort followed.", "outside the box"),
])
def test_semantic_errors_reject_unsupported_meaning(rule, text, expected):
    from agents.semantics import semantic_errors
    assert any(expected in error for error in semantic_errors(text, _moment(rule))), semantic_errors(text, _moment(rule))


def test_semantic_rules_accept_supported_claims_and_check_goal_score():
    from agents.semantics import derived_facts, semantic_errors
    goal = _moment("goal")
    mine, theirs = goal["facts"]["score"][goal["team_id"]], sum(v for k, v in goal["facts"]["score"].items() if k != goal["team_id"])
    supported = f"The goal makes it {mine}-{theirs}."
    assert semantic_errors(supported, goal) == []
    wrong = "The goal levels the score." if mine != theirs else "They took the lead."
    assert semantic_errors(wrong, goal)
    assert semantic_errors("In minutes 25-30 the press rose.", _moment("threat_gain")) == []  # A minute range is not a score.
    chance = _moment("chance")
    facts = derived_facts(chance, context_for(chance))
    assert facts["score_state"].startswith("not in this evidence")
    inside = facts["shot_location"] == "inside the penalty box"
    assert bool(semantic_errors("A shot inside the box.", chance)) is (not inside)


def test_evidence_packet_carries_derived_facts():
    from agents.prompts import SHARED_CONTRACT, evidence_packet
    goal = _moment("goal")
    packet = evidence_packet(goal, context_for(goal))
    assert "score_after_goal" in packet["derived"] and "shot_location" in packet["derived"]
    assert "three-pass" in SHARED_CONTRACT and "outside the box" in SHARED_CONTRACT


def test_transition_reversal_and_fan_meta_text_are_rejected():
    from agents.prompts import evidence_packet
    from agents.semantics import fan_text_errors, semantic_errors
    transition = _moment("transition")
    reversed_story = "Harbor pushed forward, but the run was stopped by a tackle turnover."
    assert any("won the ball" in e for e in semantic_errors(reversed_story, transition))
    assert "WON the ball" in evidence_packet(transition, context_for(transition))["derived"]["what_happened"]
    assert fan_text_errors("A quick break. No score info is given here.")
    assert fan_text_errors("A quick break down the right.") == []
