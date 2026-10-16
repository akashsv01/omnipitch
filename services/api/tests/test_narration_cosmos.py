"""Opt-in live narration tests against a real Cosmos DB account (jobs, moments, insights containers).

Skipped unless OMNIPITCH_TEST_COSMOS_ENDPOINT is set; auth is COSMOS_KEY from the environment or Entra ID.
Each test uses a unique run ID, scopes every claim to that run (other runs are never touched) and purges
its moments, jobs and insights afterwards. No model is called: a scripted fake stands in.
"""
from datetime import timedelta
import os
import threading
import uuid

import pytest

from agents.insights import CosmosInsightStore
from agents.scoped import RunScopedStore
from omnipitch_analytics.detect import detect_moments
from omnipitch_bridge.store import new_job
from simulator.match import simulate_match
from test_narration import ROLE_OK, Clock, ScriptedModel, T0, good_broadcaster, worker

ENDPOINT = os.getenv("OMNIPITCH_TEST_COSMOS_ENDPOINT")
pytestmark = pytest.mark.skipif(not ENDPOINT, reason="set OMNIPITCH_TEST_COSMOS_ENDPOINT to run against Cosmos DB")


@pytest.fixture
def live():
    from omnipitch_bridge.cosmos_store import CosmosStore
    run_id = f"narration-test-{uuid.uuid4().hex[:8]}"
    store = CosmosStore(ENDPOINT, os.getenv("COSMOS_DATABASE", "omnipitch"))
    insights = CosmosInsightStore(ENDPOINT, os.getenv("COSMOS_DATABASE", "omnipitch"), client=store.client)
    events = simulate_match(7, "standard", run_id=run_id)[:400]
    moments = detect_moments(events, run_id, "harbor-vale", ["harbor", "vale"])[:6]
    for moment in moments:
        assert store.create_moment(moment, T0) and store.create_job(new_job(moment, T0))
    try:
        yield run_id, moments, RunScopedStore(store, run_id), insights
    finally:
        store.purge_run(run_id)
        insights.purge_run(run_id)
        assert store.jobs(run_id) == [] and insights.insights(run_id) == []


def test_live_fallback_only_drain_publishes_one_insight_per_job(live):
    run_id, moments, store, insights = live
    results = worker(store, insights, None, Clock()).drain()
    assert len(results) == len(moments) and {r["status"] for r in results} == {"fallback"}
    assert {j["status"] for j in store.jobs(run_id)} == {"fallback"}
    records = insights.insights(run_id)
    assert len(records) == len(moments) and {r["insight"]["generation_mode"] for r in records} == {"fallback"}
    assert worker(store, insights, None, Clock(), owner="restart").drain() == []  # Restart: nothing left, no duplicates.
    assert len(insights.insights(run_id)) == len(moments)


def test_live_valid_ai_output_is_ready(live):
    run_id, moments, store, insights = live
    moment = moments[0]
    scripts = {**ROLE_OK, "broadcaster": [good_broadcaster(m) for m in moments]}
    results = worker(store, insights, ScriptedModel(scripts), Clock()).drain()
    by_job = {r["job_id"]: r for r in results}
    assert by_job[moment["moment_id"]]["status"] in ("ready", "fallback")
    assert any(r["status"] == "ready" for r in results)
    for record in insights.insights(run_id):
        assert record["insight"]["metrics"] == next(m for m in moments if m["moment_id"] == record["moment_id"])["metrics"]


def test_live_two_workers_never_narrate_the_same_job(live):
    run_id, moments, store, insights = live
    results = {"a": [], "b": []}

    def run(name):
        results[name] = worker(store, insights, None, Clock(), owner=f"live-{name}").drain()

    threads = [threading.Thread(target=run, args=(n,)) for n in results]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    handled = sorted(r["job_id"] for n in results for r in results[n])
    assert handled == sorted(m["moment_id"] for m in moments)
    assert len(insights.insights(run_id)) == len(moments)


def test_live_lease_expiry_duplicate_claim_publishes_one_insight(live):
    run_id, moments, store, insights = live
    clock = Clock()
    slow, fast = worker(store, insights, None, clock, owner="slow"), worker(store, insights, None, clock, owner="fast")
    stale = store.claim_next("slow", clock(), slow.lease)
    clock.advance(slow.lease.total_seconds() + 1)
    won = next(r for r in fast.drain() if r["job_id"] == stale["job_id"])
    late = slow.handle(stale)
    assert won["status"] == "fallback" and late["status"] == "lost_lease" and not late["insight_created"]
    assert sum(r["insight_id"] == stale["job_id"] for r in insights.insights(run_id)) == 1
