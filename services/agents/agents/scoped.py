"""Run-scoped view of a bridge store, so a narration worker claims jobs of ONE run only.

The bridge store's claim_next is global (all runs). A dry run on a real run, or a live test on a
throwaway run, must not claim anyone else's jobs. This wrapper reuses the store's own job
transitions (claimable, claim_order, claimed) and its conditional write (_replace), filtered to one
run_id partition; every other method is delegated unchanged. Proposed upstream as
claim_next(..., run_id=None) on SqliteStore and CosmosStore; remove this module once that exists.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import json

from omnipitch_bridge.store import StaleJob, claim_order, claimable, claimed

OPEN_STATUSES = ("pending", "retry_wait", "processing")


class RunScopedStore:
    def __init__(self, inner, run_id: str):
        self.inner, self.run_id = inner, run_id

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def claim_next(self, owner: str, now: datetime, lease: timedelta = timedelta(seconds=60)) -> dict | None:
        if hasattr(self.inner, "jobs_c"):  # CosmosStore: one partition, ETag-conditional replace.
            from omnipitch_bridge.cosmos_store import _clean
            items = list(self.inner.jobs_c.query_items(
                "SELECT * FROM c WHERE ARRAY_CONTAINS(@open, c.status)",
                parameters=[{"name": "@open", "value": list(OPEN_STATUSES)}], partition_key=self.run_id))
            for item in sorted((i for i in items if claimable(_clean(i), now)), key=lambda i: claim_order(_clean(i))):
                updated = claimed(_clean(item), owner, now, lease)
                try:
                    self.inner._replace(item, updated)
                except StaleJob:
                    continue
                return updated
            return None
        with self.inner.lock:  # SqliteStore: same transitions, version-conditional update.
            rows = self.inner.connection.execute(
                "SELECT payload FROM jobs WHERE run_id = ? AND status IN (?, ?, ?)", (self.run_id, *OPEN_STATUSES)).fetchall()
            for job in sorted((j for j in (json.loads(r[0]) for r in rows) if claimable(j, now)), key=claim_order):
                updated = claimed(job, owner, now, lease)
                try:
                    self.inner._replace(updated, job["version"])
                except StaleJob:
                    continue
                return updated
        return None

    def expire_exhausted(self, now: datetime) -> list[dict]:
        return []  # Recovery is global; the bridge runs it. A scoped worker never touches other runs.
