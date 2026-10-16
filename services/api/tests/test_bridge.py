"""Bridge worker: conditional moment/job creation, cursor, lookback, restarts, late rows and job leases."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import uuid

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from app.analysis import TEAMS
from omnipitch_analytics.detect import detect_moments
from omnipitch_bridge.bridge import DETECTED_MOMENT_VALIDATOR, JOB_VALIDATOR, Bridge
from omnipitch_bridge.store import SqliteStore, StaleJob
from simulator.match import simulate_match

ROOT = Path(__file__).resolve().parents[3]
T0 = datetime(2026, 10, 16, 3, 0, tzinfo=timezone.utc)
COSMOS_ENDPOINT = os.getenv("OMNIPITCH_TEST_COSMOS_ENDPOINT")  # Opt-in live run against a real Cosmos account.


class FakeEventhouse:
    """Mimics the KQL contract: rows carry ingestion time; events() keeps the first ingested copy per event_id."""

    def __init__(self):
        self.rows: list[tuple[datetime, dict]] = []
        self.fail_runs: set[str] = set()

    def ingest(self, events: list[dict], at: datetime) -> None:
        self.rows.extend((at, dict(event)) for event in events)

    def runs_ingested_since(self, since: datetime) -> list[dict]:
        runs: dict[str, dict] = {}
        for at, row in self.rows:
            if at > since:
                run = runs.setdefault(row["run_id"], {"run_id": row["run_id"], "last_ingested": at, "new_rows": 0})
                run["last_ingested"], run["new_rows"] = max(run["last_ingested"], at), run["new_rows"] + 1
        return sorted(runs.values(), key=lambda r: r["last_ingested"])

    def events(self, run_id: str) -> list[dict]:
        if run_id in self.fail_runs:
            raise RuntimeError("simulated Eventhouse outage")
        first: dict[str, tuple[datetime, dict]] = {}
        for at, row in self.rows:
            if row["run_id"] == run_id and (row["event_id"] not in first or at < first[row["event_id"]][0]):
                first[row["event_id"]] = (at, row)
        return sorted((row for _, row in first.values()), key=lambda r: r["sequence"])

    def recent_runs(self, limit: int = 10) -> list[dict]:
        return self.runs_ingested_since(datetime.min.replace(tzinfo=timezone.utc))[-limit:]


class Clock:
    def __init__(self, now: datetime):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture(scope="module")
def seeded() -> list[dict]:
    return simulate_match(7, "standard", run_id="bridge-test")[:400]


@pytest.fixture
def match(seeded) -> list[dict]:
    """The seeded match under a run ID unique to this test, so tests never share durable records."""
    run_id = f"bridge-test-{uuid.uuid4().hex[:8]}"
    return [dict(event, run_id=run_id) for event in seeded]


def expected_moment_ids(events: list[dict]) -> set[str]:
    return {m["moment_id"] for m in detect_moments(events, events[0]["run_id"], events[0]["match_id"], TEAMS)}


@pytest.fixture(params=["sqlite", "cosmos"])
def make(request, tmp_path, match):
    """Build a bridge over a durable store; calling it again simulates a worker restart on the same store."""
    if request.param == "cosmos" and not COSMOS_ENDPOINT:
        pytest.skip("set OMNIPITCH_TEST_COSMOS_ENDPOINT to run against Cosmos DB")
    cursor_id = f"test:{uuid.uuid4().hex[:8]}"
    stores = []

    def build(source: FakeEventhouse, now: datetime = T0):
        if request.param == "sqlite":
            store = SqliteStore(tmp_path / "bridge.sqlite3")
        else:
            from omnipitch_bridge.cosmos_store import CosmosStore
            store = CosmosStore(COSMOS_ENDPOINT, os.getenv("COSMOS_DATABASE", "omnipitch"))
        stores.append(store)
        clock = Clock(now)
        return Bridge(source, store, cursor_id, timedelta(minutes=2), clock), store, clock
    yield build
    if request.param == "cosmos":
        stores[-1].purge_run(match[0]["run_id"])
        stores[-1].purge_cursor(cursor_id)
    for store in stores:
        store.close()


def test_job_contract_and_example():
    schema = json.loads((ROOT / "contracts/schemas/job.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    example = json.loads((ROOT / "contracts/examples/job.example.json").read_text(encoding="utf-8"))
    validator.validate(example)
    assert list(validator.iter_errors({**example, "status": "done"}))
    assert list(validator.iter_errors({**example, "lease_expires_at": "yesterday"}))
    assert list(validator.iter_errors({**example, "extra": 1}))


def test_cycle_creates_one_pending_job_per_moment(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    bridge, store, _ = make(source, T0 + timedelta(seconds=5))
    report = bridge.run_once()
    expected = expected_moment_ids(match)
    assert expected and report["moments_created"] == report["jobs_created"] == len(expected)
    assert {m["moment_id"] for m in store.moments(match[0]["run_id"])} == expected
    jobs = store.jobs(match[0]["run_id"])
    assert {j["job_id"] for j in jobs} == expected and all(j["status"] == "pending" for j in jobs)
    for moment, job in zip(store.moments(match[0]["run_id"]), jobs):
        DETECTED_MOMENT_VALIDATOR.validate(moment)
        JOB_VALIDATOR.validate(job)
    assert store.get_cursor(bridge.cursor_id) == T0


def test_duplicate_delivery_and_reprocessing_create_nothing(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    source.ingest(match[-25:], T0 + timedelta(seconds=1))  # 25 re-delivered events, as in the cloud smoke run
    bridge, store, _ = make(source)
    first = bridge.run_once()
    assert first["results"][0]["rows"] == 400
    again = bridge.run_once()  # Overlapping lookback re-reads the same run.
    reconciled = bridge.reconcile()
    assert again["moments_created"] == again["jobs_created"] == 0
    assert reconciled[0]["moments_created"] == reconciled[0]["jobs_created"] == 0
    assert len(store.moments(match[0]["run_id"])) == len(store.jobs(match[0]["run_id"])) == len(expected_moment_ids(match))


def test_worker_restart_resumes_from_persisted_cursor(make, match):
    source = FakeEventhouse()
    source.ingest(match[:200], T0)
    bridge, store, _ = make(source)
    bridge.run_once()
    count = len(store.jobs(match[0]["run_id"]))
    store.close()
    source.ingest(match[200:], T0 + timedelta(minutes=10))
    restarted, store2, _ = make(source)  # New process, same durable store.
    assert store2.get_cursor(restarted.cursor_id) == T0
    report = restarted.run_once()
    assert report["since"] == (T0 - timedelta(minutes=2)).isoformat()
    assert len(store2.jobs(match[0]["run_id"])) == len(expected_moment_ids(match)) >= count
    assert store2.get_cursor(restarted.cursor_id) == T0 + timedelta(minutes=10)


def test_late_event_delays_moments_then_fills_in_without_changing_frozen_evidence(make, match):
    gap = 150
    source = FakeEventhouse()
    source.ingest([e for e in match if e["sequence"] != gap], T0)
    bridge, store, _ = make(source)
    report = bridge.run_once()
    assert report["results"][0]["contiguous_through"] == gap - 1
    early = {m["moment_id"]: m for m in store.moments(match[0]["run_id"])}
    assert set(early) == expected_moment_ids(match[:gap - 1])
    source.ingest([match[gap - 1]], T0 + timedelta(seconds=30))  # The late row arrives out of order.
    report = bridge.run_once()
    assert report["results"][0]["contiguous_through"] == 400
    final = {m["moment_id"]: m for m in store.moments(match[0]["run_id"])}
    assert set(final) == expected_moment_ids(match)
    assert all(final[key] == value for key, value in early.items())


def test_lookback_catches_rows_that_become_visible_with_an_earlier_ingestion_time(make, match):
    source = FakeEventhouse()
    source.ingest(match[:300], T0)
    bridge, store, _ = make(source)
    bridge.run_once()
    source.ingest(match[300:], T0 - timedelta(seconds=30))  # Within the 2-minute lookback.
    bridge.run_once()
    assert {j["job_id"] for j in store.jobs(match[0]["run_id"])} == expected_moment_ids(match)


def test_failed_cycle_keeps_cursor_and_retries(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    source.fail_runs.add(match[0]["run_id"])
    bridge, store, _ = make(source)
    with pytest.raises(RuntimeError):
        bridge.run_once()
    assert store.get_cursor(bridge.cursor_id) is None and store.jobs(match[0]["run_id"]) == []
    source.fail_runs.clear()
    bridge.run_once()
    assert len(store.jobs(match[0]["run_id"])) == len(expected_moment_ids(match))


def test_invalid_rows_are_counted_not_analysed(make, match):
    source = FakeEventhouse()
    broken = dict(match[10], start={"x": 500, "y": 30})  # Off the 105 x 68 pitch.
    source.ingest(match[:10] + [broken] + match[11:], T0)
    bridge, store, _ = make(source)
    result = bridge.run_once()["results"][0]
    assert result["rejected_rows"] == 1 and result["contiguous_through"] == 10
    assert {j["job_id"] for j in store.jobs(match[0]["run_id"])} == expected_moment_ids(match[:10])


def test_job_lease_claim_complete_and_recovery(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    bridge, store, clock = make(source)
    bridge.run_once()
    total = len(store.jobs(match[0]["run_id"]))
    first = store.claim_next("worker-a", clock.now)
    assert first["status"] == "processing" and first["attempt"] == 1 and first["priority"] == 3  # Goals first.
    assert store.claim_next("worker-b", clock.now)["job_id"] != first["job_id"]  # No double claim.
    with pytest.raises(StaleJob):
        store.complete(first, "worker-b", clock.now, "ready", insight_id="x")  # Not the lease holder.
    done = store.complete(first, "worker-a", clock.now, "fallback", insight_id=f"{first['job_id']}:insight")
    assert done["status"] == "fallback" and done["lease_owner"] is None
    with pytest.raises(StaleJob):
        store.complete(first, "worker-a", clock.now, "ready", insight_id="again")  # Stale version.

    # An abandoned lease is reclaimed once; an abandoned last attempt becomes failed, not retried forever.
    abandoned = store.claim_next("worker-c", clock.now, lease=timedelta(seconds=10))
    clock.now += timedelta(seconds=11)
    retaken = None
    while (job := store.claim_next("worker-d", clock.now, lease=timedelta(seconds=10))) is not None:
        if job["job_id"] == abandoned["job_id"]:
            retaken = job
            break
        store.complete(job, "worker-d", clock.now, "ready", insight_id=f"{job['job_id']}:insight")
    assert retaken is not None and retaken["attempt"] == 2
    clock.now += timedelta(seconds=11)
    assert [j["job_id"] for j in store.expire_exhausted(clock.now)] == [abandoned["job_id"]]
    assert store.get_job(abandoned["job_id"])["status"] == "failed"
    assert len(store.jobs(match[0]["run_id"])) == total


def test_retry_wait_is_claimable_after_its_delay(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    bridge, store, clock = make(source)
    bridge.run_once()
    job = store.claim_next("worker-a", clock.now)
    store.complete(job, "worker-a", clock.now, "retry_wait", error="model timeout", retry_after=timedelta(seconds=30))
    ids_now = set()
    while (other := store.claim_next("worker-b", clock.now)) is not None:
        ids_now.add(other["job_id"])
    assert job["job_id"] not in ids_now
    clock.now += timedelta(seconds=31)
    again = store.claim_next("worker-b", clock.now)
    assert again["job_id"] == job["job_id"] and again["attempt"] == 2
    with pytest.raises(ValueError):
        store.complete(again, "worker-b", clock.now, "retry_wait")  # Attempts exhausted: fallback or failed only.
