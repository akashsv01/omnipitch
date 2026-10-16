"""Cosmos DB for NoSQL implementation of the bridge store (same methods as SqliteStore).

Containers in database COSMOS_DATABASE (default omnipitch): moments and jobs partitioned by
/run_id, cursors partitioned by /cursor_id. Creates use create_item, so an existing id is a
no-op (409). Job updates use replace_item with the ETag that was read (412 means another writer
won), plus the record's own version check. Auth: Entra ID by default (needs a Cosmos DB
data-plane role); COSMOS_KEY is accepted only from the environment for a teammate in another tenant.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import os

from azure.core import MatchConditions
from azure.cosmos import CosmosClient
from azure.cosmos.exceptions import CosmosAccessConditionFailedError, CosmosResourceExistsError, CosmosResourceNotFoundError

from .store import StaleJob, claim_order, claimable, claimed, completed, exhausted, is_exhausted, iso, parse_iso, utcnow

SYSTEM_FIELDS = ("id", "_rid", "_self", "_etag", "_attachments", "_ts")


def _clean(item: dict) -> dict:
    return {key: value for key, value in item.items() if key not in SYSTEM_FIELDS}


def cosmos_client(endpoint: str, tenant_id: str | None = None) -> CosmosClient:
    key = os.getenv("COSMOS_KEY")
    if key:
        return CosmosClient(endpoint, credential=key)
    from app.config import credential
    return CosmosClient(endpoint, credential=credential(tenant_id))


class CosmosStore:
    def __init__(self, endpoint: str, database: str = "omnipitch", tenant_id: str | None = None,
                 client: CosmosClient | None = None):
        self.client = client or cosmos_client(endpoint, tenant_id)
        db = self.client.get_database_client(database)
        self.moments_c = db.get_container_client("moments")
        self.jobs_c = db.get_container_client("jobs")
        self.cursors_c = db.get_container_client("cursors")

    def close(self) -> None:
        self.client.__exit__(None, None, None)  # The sync client has no close(); its context exit releases connections.

    # Cursor ---------------------------------------------------------------
    def get_cursor(self, cursor_id: str) -> datetime | None:
        try:
            return parse_iso(self.cursors_c.read_item(cursor_id, partition_key=cursor_id)["value"])
        except CosmosResourceNotFoundError:
            return None

    def set_cursor(self, cursor_id: str, value: datetime) -> None:
        self.cursors_c.upsert_item({"id": cursor_id, "cursor_id": cursor_id, "value": iso(value), "updated_at": iso(utcnow())})

    # Moments --------------------------------------------------------------
    def create_moment(self, moment: dict, now: datetime) -> bool:
        try:
            self.moments_c.create_item({**moment, "id": moment["moment_id"], "detected_at": iso(now)})
            return True
        except CosmosResourceExistsError:
            return False  # Frozen evidence is never overwritten.

    def moments(self, run_id: str) -> list[dict]:
        items = self.moments_c.query_items("SELECT * FROM c", partition_key=run_id)
        rows = [{k: v for k, v in _clean(item).items() if k != "detected_at"} for item in items]
        return sorted(rows, key=lambda m: (m["source_sequence"], m["moment_id"]))

    # Jobs -----------------------------------------------------------------
    def create_job(self, job: dict) -> bool:
        try:
            self.jobs_c.create_item({**job, "id": job["job_id"]})
            return True
        except CosmosResourceExistsError:
            return False

    def _read(self, job_id: str) -> dict | None:
        found = list(self.jobs_c.query_items("SELECT * FROM c WHERE c.id = @id", parameters=[{"name": "@id", "value": job_id}],
                                             enable_cross_partition_query=True))
        return found[0] if found else None

    def get_job(self, job_id: str) -> dict | None:
        item = self._read(job_id)
        return _clean(item) if item else None

    def jobs(self, run_id: str | None = None, status: str | None = None) -> list[dict]:
        query, params = "SELECT * FROM c WHERE 1 = 1", []
        if status is not None:
            query, params = query + " AND c.status = @status", [{"name": "@status", "value": status}]
        items = (self.jobs_c.query_items(query, parameters=params, partition_key=run_id) if run_id is not None
                 else self.jobs_c.query_items(query, parameters=params, enable_cross_partition_query=True))
        return sorted((_clean(item) for item in items), key=lambda job: (job["run_id"], job["source_sequence"], job["job_id"]))

    def _replace(self, item: dict, updated: dict) -> None:
        try:
            self.jobs_c.replace_item(item["id"], {**updated, "id": item["id"]}, etag=item["_etag"],
                                     match_condition=MatchConditions.IfNotModified)
        except CosmosAccessConditionFailedError as exc:
            raise StaleJob(f"job {item['id']} changed since it was read") from exc

    def claim_next(self, owner: str, now: datetime, lease: timedelta = timedelta(seconds=60)) -> dict | None:
        items = self.jobs_c.query_items("SELECT * FROM c WHERE c.status IN ('pending', 'retry_wait', 'processing')",
                                        enable_cross_partition_query=True)
        for item in sorted((i for i in items if claimable(_clean(i), now)), key=lambda i: claim_order(_clean(i))):
            updated = claimed(_clean(item), owner, now, lease)
            try:
                self._replace(item, updated)
            except StaleJob:
                continue  # Another worker won this job; try the next one.
            return updated
        return None

    def complete(self, job: dict, owner: str, now: datetime, status: str, insight_id: str | None = None,
                 error: str | None = None, retry_after: timedelta | None = None) -> dict:
        item = self._read(job["job_id"])
        updated = completed(_clean(item) if item else None, job, owner, now, status, insight_id, error, retry_after)
        self._replace(item, updated)
        return updated

    def expire_exhausted(self, now: datetime) -> list[dict]:
        failed = []
        for item in self.jobs_c.query_items("SELECT * FROM c WHERE c.status = 'processing'", enable_cross_partition_query=True):
            if is_exhausted(_clean(item), now):
                updated = exhausted(_clean(item), now)
                try:
                    self._replace(item, updated)
                    failed.append(updated)
                except StaleJob:
                    pass
        return failed

    # Test support ----------------------------------------------------------
    def purge_run(self, run_id: str) -> None:
        for container in (self.moments_c, self.jobs_c):
            for item in list(container.query_items("SELECT c.id FROM c", partition_key=run_id)):
                container.delete_item(item["id"], partition_key=run_id)

    def purge_cursor(self, cursor_id: str) -> None:
        try:
            self.cursors_c.delete_item(cursor_id, partition_key=cursor_id)
        except CosmosResourceNotFoundError:
            pass
