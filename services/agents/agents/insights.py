"""Insight records written by the narration worker.

SqliteInsightStore (local) and CosmosInsightStore (Cosmos DB container `insights`, partition
/run_id) share create_insight / get_insight / insights. Records are created only if absent,
keyed by insight_id (= moment_id: one published insight per moment), so a duplicate claim after
a lease expiry can never publish two different insights for the same moment. Nothing overwrites
an insight: there is no update or upsert path.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
from threading import RLock

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PATH = REPOSITORY_ROOT / "data/generated/narration.sqlite3"


def insight_id_for(moment_id: str) -> str:
    return moment_id


class SqliteInsightStore:
    def __init__(self, path: str | Path | None = None):
        path = str(path or os.getenv("OMNIPITCH_NARRATION_DB") or DEFAULT_PATH)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS insights (insight_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, "
            "generation_mode TEXT NOT NULL, record TEXT NOT NULL, created_at TEXT NOT NULL)")

    def create_insight(self, record: dict) -> bool:
        """record = {insight_id, run_id, insight, trace, created_at, worker}. True if this call created it."""
        with self.lock:
            cursor = self.connection.execute(
                "INSERT OR IGNORE INTO insights VALUES (?, ?, ?, ?, ?)",
                (record["insight_id"], record["run_id"], record["insight"]["generation_mode"],
                 json.dumps(record, sort_keys=True), record["created_at"]))
        return cursor.rowcount == 1

    def get_insight(self, insight_id: str, run_id: str | None = None) -> dict | None:
        with self.lock:
            row = self.connection.execute("SELECT record FROM insights WHERE insight_id = ?", (insight_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def insights(self, run_id: str) -> list[dict]:
        with self.lock:
            rows = self.connection.execute("SELECT record FROM insights WHERE run_id = ? ORDER BY insight_id", (run_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]


class CosmosInsightStore:
    """Cosmos DB for NoSQL: container `insights`, id = insight_id, partition key /run_id.

    create_item on an existing id raises 409, which means another worker already published the
    insight for this moment: create_insight returns False and nothing is overwritten.
    Auth comes from the bridge's cosmos_client: COSMOS_KEY from the environment if set, else Entra ID.
    """

    SYSTEM_FIELDS = ("id", "_rid", "_self", "_etag", "_attachments", "_ts")

    def __init__(self, endpoint: str, database: str = "omnipitch", tenant_id: str | None = None, client=None,
                 container: str = "insights"):
        if client is None:
            from omnipitch_bridge.cosmos_store import cosmos_client
            client = cosmos_client(endpoint, tenant_id)
        self.client = client
        self.container = client.get_database_client(database).get_container_client(container)

    def _clean(self, item: dict) -> dict:
        return {key: value for key, value in item.items() if key not in self.SYSTEM_FIELDS}

    def create_insight(self, record: dict) -> bool:
        from azure.cosmos.exceptions import CosmosResourceExistsError
        try:
            self.container.create_item({**record, "id": record["insight_id"]})
            return True
        except CosmosResourceExistsError:
            return False

    def get_insight(self, insight_id: str, run_id: str | None = None) -> dict | None:
        from azure.cosmos.exceptions import CosmosResourceNotFoundError
        if run_id is not None:
            try:
                return self._clean(self.container.read_item(insight_id, partition_key=run_id))
            except CosmosResourceNotFoundError:
                return None
        found = list(self.container.query_items("SELECT * FROM c WHERE c.id = @id",
                                                parameters=[{"name": "@id", "value": insight_id}],
                                                enable_cross_partition_query=True))
        return self._clean(found[0]) if found else None

    def insights(self, run_id: str) -> list[dict]:
        items = self.container.query_items("SELECT * FROM c", partition_key=run_id)
        return sorted((self._clean(item) for item in items), key=lambda record: record["insight_id"])

    def purge_run(self, run_id: str) -> None:
        """Test support only: delete one run's insights (unique test run IDs, never real runs)."""
        for item in list(self.container.query_items("SELECT c.id FROM c", partition_key=run_id)):
            self.container.delete_item(item["id"], partition_key=run_id)
