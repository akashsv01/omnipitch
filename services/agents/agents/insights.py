"""Insight records written by the narration worker.

Local stand-in until the shared store (SqliteStore / Cosmos `insights` container) gains
create_insight/get_insight. Records are created only if absent, keyed by insight_id
(= moment_id: one published insight per moment), so a duplicate claim after a lease
expiry can never publish two different insights for the same moment.
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

    def get_insight(self, insight_id: str) -> dict | None:
        with self.lock:
            row = self.connection.execute("SELECT record FROM insights WHERE insight_id = ?", (insight_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def insights(self, run_id: str) -> list[dict]:
        with self.lock:
            rows = self.connection.execute("SELECT record FROM insights WHERE run_id = ? ORDER BY insight_id", (run_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]
