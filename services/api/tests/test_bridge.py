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
    first = store.claim_next("worker-a", clock.now, run_id=match[0]["run_id"])
    assert first["status"] == "processing" and first["attempt"] == 1 and first["priority"] == 3  # Goals first.
    assert store.claim_next("worker-b", clock.now, run_id=match[0]["run_id"])["job_id"] != first["job_id"]  # No double claim.
    with pytest.raises(StaleJob):
        store.complete(first, "worker-b", clock.now, "ready", insight_id="x")  # Not the lease holder.
    done = store.complete(first, "worker-a", clock.now, "fallback", insight_id=f"{first['job_id']}:insight")
    assert done["status"] == "fallback" and done["lease_owner"] is None
    with pytest.raises(StaleJob):
        store.complete(first, "worker-a", clock.now, "ready", insight_id="again")  # Stale version.

    # An abandoned lease is reclaimed once; an abandoned last attempt becomes failed, not retried forever.
    abandoned = store.claim_next("worker-c", clock.now, lease=timedelta(seconds=10), run_id=match[0]["run_id"])
    clock.now += timedelta(seconds=11)
    retaken = None
    while (job := store.claim_next("worker-d", clock.now, lease=timedelta(seconds=10), run_id=match[0]["run_id"])) is not None:
        if job["job_id"] == abandoned["job_id"]:
            retaken = job
            break
        store.complete(job, "worker-d", clock.now, "ready", insight_id=f"{job['job_id']}:insight")
    assert retaken is not None and retaken["attempt"] == 2
    clock.now += timedelta(seconds=11)
    assert [j["job_id"] for j in store.expire_exhausted(clock.now, run_id=match[0]["run_id"])] == [abandoned["job_id"]]
    assert store.get_job(abandoned["job_id"])["status"] == "failed"
    assert len(store.jobs(match[0]["run_id"])) == total


def test_claim_and_recovery_can_be_scoped_to_one_run(make, match):
    other = [dict(event, run_id=match[0]["run_id"] + "-other") for event in match]
    source = FakeEventhouse()
    source.ingest(match + other, T0)
    bridge, store, clock = make(source)
    try:
        bridge.run_once()
        claimed = []
        while (job := store.claim_next("worker-a", clock.now, run_id=match[0]["run_id"])) is not None:
            claimed.append(job)
        assert claimed and {job["run_id"] for job in claimed} == {match[0]["run_id"]}
        assert all(job["status"] == "pending" for job in store.jobs(other[0]["run_id"]))  # Untouched.
    finally:
        if hasattr(store, "purge_run"):
            store.purge_run(other[0]["run_id"])


def test_retry_wait_is_claimable_after_its_delay(make, match):
    source = FakeEventhouse()
    source.ingest(match, T0)
    bridge, store, clock = make(source)
    bridge.run_once()
    job = store.claim_next("worker-a", clock.now, run_id=match[0]["run_id"])
    store.complete(job, "worker-a", clock.now, "retry_wait", error="model timeout", retry_after=timedelta(seconds=30))
    ids_now = set()
    while (other := store.claim_next("worker-b", clock.now, run_id=match[0]["run_id"])) is not None:
        ids_now.add(other["job_id"])
    assert job["job_id"] not in ids_now
    clock.now += timedelta(seconds=31)
    again = store.claim_next("worker-b", clock.now, run_id=match[0]["run_id"])
    assert again["job_id"] == job["job_id"] and again["attempt"] == 2
    with pytest.raises(ValueError):
        store.complete(again, "worker-b", clock.now, "retry_wait")  # Attempts exhausted: fallback or failed only.


# Period-end reconciliation (Phase 4) ---------------------------------------------------------

@pytest.fixture(scope="module")
def seeded_full() -> list[dict]:
    return simulate_match(7, "standard", run_id="bridge-test")  # 1206 events; period_end at 618 and 1206.


@pytest.fixture
def full(seeded_full, match) -> list[dict]:
    """The full seeded match under this test's unique run ID (shared with `match` for cleanup)."""
    return [dict(event, run_id=match[0]["run_id"]) for event in seeded_full]


def needs_reconciliations(store) -> None:
    from azure.cosmos.exceptions import CosmosResourceNotFoundError
    try:
        store.reconciliations("probe-run")
    except CosmosResourceNotFoundError:
        pytest.skip("Cosmos container 'reconciliations' is not provisioned")


def period_ids(events: list[dict], period: int) -> set[str]:
    return {m["moment_id"] for m in detect_moments(events, events[0]["run_id"], events[0]["match_id"], TEAMS)
            if m["period"] == period}


def test_period_end_is_reconciled_once_with_a_valid_record(make, full):
    from omnipitch_bridge.bridge import RECONCILIATION_VALIDATOR
    source = FakeEventhouse()
    source.ingest(full, T0)
    bridge, store, _ = make(source)
    needs_reconciliations(store)
    result = bridge.run_once()["results"][0]
    assert result["periods_reconciled"] == [1, 2] and result["reconciliation_mismatches"] == 0
    records = store.reconciliations(full[0]["run_id"])
    assert [(r["period"], r["through_sequence"], r["status"]) for r in records] == [(1, 618, "reconciled"), (2, 1206, "reconciled")]
    for record in records:
        RECONCILIATION_VALIDATOR.validate(record)
        assert record["created"] == record["expected_moments"] == len(period_ids(full, record["period"]))
        assert record["stored_before"] == 0
    again = bridge.run_once()["results"][0]
    assert again["periods_reconciled"] == [] and again["moments_created"] == 0
    assert bridge.reconcile()[0]["periods_reconciled"] == []
    assert store.reconciliations(full[0]["run_id"]) == records  # Never rewritten.


def test_late_event_before_period_end_delays_reconciliation(make, full):
    source = FakeEventhouse()
    source.ingest([e for e in full if e["sequence"] != 600], T0)
    bridge, store, _ = make(source)
    needs_reconciliations(store)
    first = bridge.run_once()["results"][0]
    assert first["contiguous_through"] == 599 and first["periods_reconciled"] == []
    early = len(store.moments(full[0]["run_id"]))
    source.ingest([full[599]], T0 + timedelta(seconds=30))
    second = bridge.run_once()["results"][0]
    assert second["periods_reconciled"] == [1, 2]
    p1 = store.get_reconciliation(full[0]["run_id"], 1)
    assert p1["stored_before"] == len(period_ids(full[:599], 1)) and p1["stored_before"] + p1["created"] == p1["expected_moments"]
    assert len(store.moments(full[0]["run_id"])) == len(expected_moment_ids(full)) >= early


def test_duplicates_do_not_change_reconciliation(make, full):
    source = FakeEventhouse()
    source.ingest(full, T0)
    source.ingest(full[500:525] + full[-5:], T0 + timedelta(seconds=1))
    bridge, store, _ = make(source)
    needs_reconciliations(store)
    bridge.run_once()
    records = store.reconciliations(full[0]["run_id"])
    assert [r["expected_moments"] for r in records] == [len(period_ids(full, 1)), len(period_ids(full, 2))]
    assert all(r["status"] == "reconciled" for r in records)


def test_restart_mid_reconciliation_completes_without_duplicates(make, full):
    source = FakeEventhouse()
    source.ingest(full, T0)
    bridge, store, _ = make(source)
    needs_reconciliations(store)
    original = store.create_reconciliation
    calls = {"n": 0}

    def crash_once(record):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("worker killed mid-reconciliation")
        return original(record)
    store.create_reconciliation = crash_once
    with pytest.raises(RuntimeError):
        bridge.run_once()
    assert store.get_cursor(bridge.cursor_id) is None  # The failed cycle is retried.
    restarted, store2, _ = make(source)
    report = restarted.run_once()["results"][0]
    assert report["periods_reconciled"] == [1, 2] and report["moments_created"] == 0
    records = store2.reconciliations(full[0]["run_id"])
    assert [r["status"] for r in records] == ["reconciled", "reconciled"]
    assert records[0]["stored_before"] == records[0]["expected_moments"] and records[0]["created"] == 0
    assert len(store2.jobs(full[0]["run_id"])) == len(expected_moment_ids(full))


def test_mismatch_is_reported_and_frozen_evidence_kept(make, full):
    source = FakeEventhouse()
    source.ingest(full, T0)
    bridge, store, clock = make(source)
    needs_reconciliations(store)
    target = next(m for m in detect_moments(full, full[0]["run_id"], full[0]["match_id"], TEAMS) if m["period"] == 1)
    tampered = {**target, "metrics": [dict(target["metrics"][0], value=target["metrics"][0]["value"] + 1)] + target["metrics"][1:]}
    stray = {**target, "moment_id": target["moment_id"] + "-stray"}
    store.create_moment(tampered, clock.now)
    store.create_moment(stray, clock.now)
    bridge.run_once()
    p1 = store.get_reconciliation(full[0]["run_id"], 1)
    assert p1["status"] == "mismatch"
    assert {(m["moment_id"], m["kind"]) for m in p1["mismatches"]} == {
        (target["moment_id"], "evidence_differs"), (stray["moment_id"], "unexpected_stored")}
    stored = {m["moment_id"]: m for m in store.moments(full[0]["run_id"])}
    assert stored[target["moment_id"]]["metrics"] == tampered["metrics"]  # Kept as stored, never overwritten.


def test_number_type_round_trips_are_not_mismatches():
    from omnipitch_bridge.bridge import _canonical
    assert _canonical({"metrics": [{"value": 16.0}], "flag": True}) == _canonical({"metrics": [{"value": 16}], "flag": True})
    assert _canonical({"value": 16.5}) != _canonical({"value": 16})
    assert _canonical({"flag": True}) != _canonical({"flag": 1.0})  # Booleans stay booleans.
