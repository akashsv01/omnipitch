"""Read-only period reconciliation status for recaps (the bridge's `reconciliations` container).

The bridge re-reads each finished period from Eventhouse, re-runs detection and writes one record per run and
period (contracts/schemas/reconciliation.schema.json). A recap may say "reconciled" only from such a record, and
only if it covers the same events the replay shows. The API never writes this container (agreed with the data
owner, 2026-10-21). Enabled with the Cosmos insight source (OMNIPITCH_INSIGHTS=cosmos); errors are reported.
"""
from __future__ import annotations

import os
from threading import Lock
from time import monotonic
from typing import Callable

SCOPE_PERIODS = {"first_half": (1,), "full_time": (1, 2)}


class ReconciliationSource:
    def __init__(self, fetch: Callable[[str], list[dict]] | None, mode: str = "off", ttl_s: float = 10.0,
                 clock: Callable[[], float] = monotonic):
        self.fetch, self.mode, self.ttl_s, self.clock = fetch, mode, ttl_s, clock
        self._lock = Lock()
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self.error: str | None = None

    def _records(self, run_id: str) -> list[dict]:
        with self._lock:
            cached = self._cache.get(run_id)
            if cached and self.clock() - cached[0] < self.ttl_s:
                return cached[1]
        records = self.fetch(run_id)
        with self._lock:
            self._cache[run_id] = (self.clock(), records)
        return records

    def status(self, source_run_id: str | None, scope: str, events: list[dict]) -> dict:
        """off | not_applicable | pending | reconciled | mismatch | differs | error, with per-period detail."""
        out = {"mode": self.mode, "status": "off", "periods": [], "error": None}
        if self.fetch is None:
            if self.mode != "off":
                out.update(status="error", error=self.error or "reconciliation source is not configured")
            return out
        if not source_run_id:
            out["status"] = "not_applicable"  # Simulator replays have no bridge run behind them.
            return out
        try:
            by_period = {r["period"]: r for r in self._records(source_run_id)}
        except Exception as exc:  # Cosmos SDK raises several types; report, never guess.
            out.update(status="error", error=f"{type(exc).__name__}: {str(exc)[:160]}")
            return out
        ends = {e["period"]: e["sequence"] for e in events if e["type"] == "period_end"}
        statuses = []
        for period in SCOPE_PERIODS[scope]:
            record = by_period.get(period)
            if record is None:
                state = "pending"
            elif record["status"] != "reconciled":
                state = "mismatch"
            elif period in ends and ends[period] != record["through_sequence"]:
                state = "differs"  # The record covers different events than this replay shows.
            else:
                state = "reconciled"
            statuses.append(state)
            out["periods"].append({"period": period, "status": state,
                                   "through_sequence": record["through_sequence"] if record else None,
                                   "reconciled_at": record["reconciled_at"] if record else None,
                                   "mismatches": len(record["mismatches"]) if record else None})
        for state in ("mismatch", "differs", "pending"):
            if state in statuses:
                out["status"] = state
                break
        else:
            out["status"] = "reconciled"
        return out


def from_env() -> ReconciliationSource:
    if os.getenv("OMNIPITCH_INSIGHTS", "off").strip().lower() != "cosmos":
        return ReconciliationSource(None, "off")
    endpoint = os.getenv("COSMOS_ENDPOINT", "")
    source = ReconciliationSource(None, "cosmos")
    if not endpoint.startswith("https://") or "AccountKey" in endpoint:
        source.error = "COSMOS_ENDPOINT must be the https account endpoint (no keys)."
        return source
    try:
        from omnipitch_bridge.cosmos_store import cosmos_client
        container = (cosmos_client(endpoint, os.getenv("COSMOS_TENANT_ID") or None)
                     .get_database_client(os.getenv("COSMOS_DATABASE", "omnipitch")).get_container_client("reconciliations"))
    except Exception as exc:
        source.error = f"reconciliation source unavailable: {type(exc).__name__}: {str(exc)[:160]}"
        return source

    def fetch(run_id: str) -> list[dict]:  # Read-only: a partition query, nothing else.
        return [{k: v for k, v in item.items() if not k.startswith("_")}
                for item in container.query_items("SELECT * FROM c", partition_key=run_id)]
    source.fetch = fetch
    return source
