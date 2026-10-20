"""One bridge cycle: find runs with newly ingested rows, detect moments, create records conditionally.

Discovery uses ingestion time with an overlapping lookback; football logic uses match time and
sequence through the shared detector. Each touched run is re-read deduplicated from the event
store, so duplicate, late and out-of-order rows need no special handling here:

- only the gap-free sequence prefix is analysed, so a missing event delays moments instead of
  producing wrong ones;
- detection is prefix-stable and records are created only if absent, so reprocessing, restarts
  and overlapping lookbacks create nothing twice;
- the cursor moves only after every touched run was written, so a failed cycle is retried.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
from typing import Callable, Protocol

from jsonschema import Draft202012Validator, FormatChecker

from app.analysis import TEAMS
from app.schemas import Event
from omnipitch_analytics.detect import detect_moments

from .store import SqliteStore, iso, new_job, utcnow

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts/schemas"
EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
DEFAULT_LOOKBACK = timedelta(minutes=2)


def _validators() -> tuple[Draft202012Validator, Draft202012Validator, Draft202012Validator]:
    job = json.loads((CONTRACTS / "job.schema.json").read_text(encoding="utf-8"))
    reconciliation = json.loads((CONTRACTS / "reconciliation.schema.json").read_text(encoding="utf-8"))
    moment = json.loads((CONTRACTS / "moment.schema.json").read_text(encoding="utf-8"))
    # A detected moment is the moment contract before narration and replay timing are attached.
    for field in ("insight", "replay_ms"):
        moment["required"].remove(field)
        moment["properties"].pop(field)
    return (Draft202012Validator(job, format_checker=FormatChecker()),
            Draft202012Validator(moment, format_checker=FormatChecker()),
            Draft202012Validator(reconciliation, format_checker=FormatChecker()))


JOB_VALIDATOR, DETECTED_MOMENT_VALIDATOR, RECONCILIATION_VALIDATOR = _validators()


def _numbers_as_float(value):
    # Cosmos DB returns integral floats as integers (16.0 -> 16); compare values, not JSON number types.
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return {key: _numbers_as_float(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_numbers_as_float(item) for item in value]
    return value


def _canonical(record: dict) -> str:
    return json.dumps(_numbers_as_float(record), sort_keys=True, separators=(",", ":"))


class EventSource(Protocol):
    def runs_ingested_since(self, since: datetime) -> list[dict]: ...
    def events(self, run_id: str) -> list[dict]: ...
    def recent_runs(self, limit: int = 10) -> list[dict]: ...


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def contiguous_prefix(events: list[dict]) -> list[dict]:
    prefix: list[dict] = []
    for event in sorted(events, key=lambda e: e["sequence"]):
        if event["sequence"] != len(prefix) + 1:
            break
        prefix.append(event)
    return prefix


class Bridge:
    def __init__(self, source: EventSource, store: SqliteStore, cursor_id: str,
                 lookback: timedelta = DEFAULT_LOOKBACK, clock: Callable[[], datetime] = utcnow,
                 log: Callable[[dict], None] = lambda record: None):
        self.source, self.store, self.cursor_id = source, store, cursor_id
        self.lookback, self.clock, self.log = lookback, clock, log

    def process_run(self, run_id: str) -> dict:
        started = time.perf_counter()
        rows = self.source.events(run_id)
        valid, rejected = [], 0
        for row in rows:
            try:
                valid.append(Event.model_validate(row, strict=False).model_dump(mode="json"))
            except ValueError:
                rejected += 1  # Invalid rows never reach metrics; they are counted and reported.
        prefix = [e for e in contiguous_prefix(valid) if e["run_id"] == run_id]
        created_moments = created_jobs = 0
        detected: list[dict] = []
        reconciled: list[dict] = []
        if prefix:
            now = self.clock()
            closed = sorted({e["period"] for e in prefix if e["type"] == "period_end"})
            pending_periods = [p for p in closed if self.store.get_reconciliation(run_id, p) is None]
            # What was stored before this cycle, so a reconciliation record says what it created.
            stored_before = {m["moment_id"]: m for m in self.store.moments(run_id)} if pending_periods else {}
            detected = detect_moments(prefix, run_id, prefix[0]["match_id"], TEAMS)
            created_ids: set[str] = set()
            for moment in detected:
                DETECTED_MOMENT_VALIDATOR.validate(moment)
                job = new_job(moment, now)
                JOB_VALIDATOR.validate(job)
                if self.store.create_moment(moment, now):
                    created_moments += 1
                    created_ids.add(moment["moment_id"])
                created_jobs += self.store.create_job(job)
            for period in pending_periods:
                reconciled.append(self._reconcile_period(run_id, period, prefix, detected, stored_before, created_ids, now))
        result = {"run_id": run_id, "rows": len(rows), "rejected_rows": rejected,
                  "contiguous_through": prefix[-1]["sequence"] if prefix else 0,
                  "moments_detected": len(detected), "moments_created": created_moments, "jobs_created": created_jobs,
                  "periods_reconciled": [r["period"] for r in reconciled],
                  "reconciliation_mismatches": sum(len(r["mismatches"]) for r in reconciled),
                  "duration_ms": round((time.perf_counter() - started) * 1000)}
        self.log({"stage": "process_run", **result})
        return result

    def _reconcile_period(self, run_id: str, period: int, prefix: list[dict], detected: list[dict],
                          stored_before: dict[str, dict], created_ids: set[str], now: datetime) -> dict:
        """Compare re-detection of a closed period with what was stored; never overwrite frozen evidence."""
        end = next(e for e in prefix if e["period"] == period and e["type"] == "period_end")
        expected = {m["moment_id"]: m for m in detected if m["period"] == period}
        before = {k: m for k, m in stored_before.items() if m["period"] == period}
        mismatches = [{"moment_id": k, "kind": "evidence_differs"} for k in sorted(expected)
                      if k in before and _canonical(before[k]) != _canonical(expected[k])]
        mismatches += [{"moment_id": k, "kind": "unexpected_stored"} for k in sorted(set(before) - set(expected))]
        record = {"schema_version": "1.0", "reconciliation_id": f"{run_id}:p{period}", "run_id": run_id,
                  "match_id": end["match_id"], "period": period, "through_sequence": end["sequence"],
                  "events_in_period": sum(1 for e in prefix if e["period"] == period),
                  "expected_moments": len(expected), "stored_before": len(before),
                  "created": len(created_ids & set(expected)), "mismatches": mismatches,
                  "status": "mismatch" if mismatches else "reconciled", "reconciled_at": iso(now)}
        RECONCILIATION_VALIDATOR.validate(record)
        self.store.create_reconciliation(record)
        self.log({"stage": "reconcile", "run_id": run_id, "period": period, "status": record["status"],
                  "expected": record["expected_moments"], "stored_before": record["stored_before"],
                  "created": record["created"], "mismatches": len(mismatches)})
        return record

    def run_once(self) -> dict:
        cursor = self.store.get_cursor(self.cursor_id)
        since = (cursor - self.lookback) if cursor else EPOCH
        touched = self.source.runs_ingested_since(since)
        results = [self.process_run(run["run_id"]) for run in touched]
        newest = max([_utc(run["last_ingested"]) for run in touched] + ([cursor] if cursor else []), default=None)
        if newest is not None and newest != cursor:
            self.store.set_cursor(self.cursor_id, newest)  # Only after every touched run was written.
        charge = getattr(self.store, "request_charge", None)
        summary = {"stage": "cycle", "since": since.isoformat(), "runs": len(touched),
                   **({"request_charge_ru": round(sum(charge.values()), 2)} if charge is not None else {}),
                   "moments_created": sum(r["moments_created"] for r in results),
                   "jobs_created": sum(r["jobs_created"] for r in results),
                   "cursor": newest.isoformat() if newest else None}
        self.log(summary)
        return {**summary, "results": results}

    def reconcile(self, limit: int = 10) -> list[dict]:
        """Full pass over recent runs regardless of the cursor, so a bounded lookback cannot miss rows forever."""
        return [self.process_run(run["run_id"]) for run in self.source.recent_runs(limit)]
