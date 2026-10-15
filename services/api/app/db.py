"""SQLite persistence for local runs: event ledger, diagnostics, moments and replay state.

This is the local stand-in for Eventhouse (events) and Cosmos DB (state, moments). Event
identity is (run_id, event_id); repeated delivery of an identical payload is ignored, and a
different payload under an existing identity is rejected to diagnostics.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
from threading import RLock
from datetime import datetime, timezone

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PATH = REPOSITORY_ROOT / "data/generated/omnipitch.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, meta TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
  received_at TEXT NOT NULL, PRIMARY KEY (run_id, event_id));
CREATE INDEX IF NOT EXISTS events_by_sequence ON events (run_id, sequence);
CREATE TABLE IF NOT EXISTS ledger_stats (
  run_id TEXT PRIMARY KEY, received INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_id TEXT, code TEXT NOT NULL,
  message TEXT NOT NULL, payload TEXT, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS moments (
  run_id TEXT NOT NULL, moment_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, payload TEXT NOT NULL,
  detected_at TEXT NOT NULL, PRIMARY KEY (run_id, moment_id));
CREATE TABLE IF NOT EXISTS replay_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical(event: dict) -> str:
    return json.dumps(event, sort_keys=True, separators=(",", ":"))


class Database:
    def __init__(self, path: str | Path | None = None):
        path = str(path or os.getenv("OMNIPITCH_DB_PATH") or DEFAULT_PATH)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.connection.execute("PRAGMA journal_mode=WAL" if path != ":memory:" else "PRAGMA journal_mode=MEMORY")
        self.connection.executescript(SCHEMA)

    def ping(self) -> bool:
        with self.lock:
            return self.connection.execute("SELECT 1").fetchone() == (1,)

    # Runs -----------------------------------------------------------------
    def save_run(self, run_id: str, match_id: str, meta: dict, events: list[dict]) -> None:
        with self.lock:
            self.connection.execute(
                "INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?)",
                (run_id, match_id, json.dumps(meta), "\n".join(_canonical(e) for e in events), _now()))

    def load_run(self, run_id: str) -> tuple[dict, list[dict]] | None:
        with self.lock:
            row = self.connection.execute("SELECT meta, source FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        return json.loads(row[0]), [json.loads(line) for line in row[1].splitlines() if line]

    # Ledger ---------------------------------------------------------------
    def _bump(self, run_id: str, **counts: int) -> None:
        self.connection.execute("INSERT OR IGNORE INTO ledger_stats (run_id) VALUES (?)", (run_id,))
        for column, value in counts.items():
            if value:
                self.connection.execute(f"UPDATE ledger_stats SET {column} = {column} + ? WHERE run_id = ?", (value, run_id))

    def ingest(self, run_id: str, events: list[dict]) -> dict:
        """Insert validated events idempotently. Returns accepted/duplicate/conflict IDs."""
        accepted, duplicates, conflicts = [], [], []
        now = _now()
        with self.lock:
            self.connection.execute("BEGIN")
            try:
                for event in events:
                    payload = _canonical(event)
                    cursor = self.connection.execute(
                        "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)",
                        (run_id, event["event_id"], event["sequence"], payload, now))
                    if cursor.rowcount:
                        accepted.append(event["event_id"])
                        continue
                    existing = self.connection.execute(
                        "SELECT payload FROM events WHERE run_id = ? AND event_id = ?", (run_id, event["event_id"])).fetchone()[0]
                    if existing == payload:
                        duplicates.append(event["event_id"])
                    else:
                        conflicts.append(event["event_id"])
                        self.connection.execute(
                            "INSERT INTO diagnostics (run_id, event_id, code, message, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)",
                            (run_id, event["event_id"], "conflicting_duplicate",
                             "Event ID already ingested with a different payload; kept the first version.", payload, now))
                self._bump(run_id, received=len(events), duplicates=len(duplicates), conflicts=len(conflicts))
                self.connection.execute("COMMIT")
            except Exception:
                self.connection.execute("ROLLBACK")
                raise
        return {"accepted": accepted, "duplicates": duplicates, "conflicts": conflicts}

    def reject(self, run_id: str, rejections: list[dict]) -> None:
        if not rejections:
            return
        now = _now()
        with self.lock:
            for item in rejections:
                self.connection.execute(
                    "INSERT INTO diagnostics (run_id, event_id, code, message, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (run_id, item.get("event_id"), item["code"], item["message"], item.get("payload"), now))
            self._bump(run_id, received=len(rejections), invalid=len(rejections))

    def ledger_events(self, run_id: str, after: int = 0, limit: int | None = None) -> list[dict]:
        query = "SELECT payload FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence, event_id"
        params: tuple = (run_id, after)
        if limit is not None:
            query += " LIMIT ?"
            params += (limit,)
        with self.lock:
            return [json.loads(row[0]) for row in self.connection.execute(query, params)]

    def ledger_summary(self, run_id: str) -> dict:
        with self.lock:
            stats = self.connection.execute(
                "SELECT received, duplicates, conflicts, invalid FROM ledger_stats WHERE run_id = ?", (run_id,)).fetchone() or (0, 0, 0, 0)
            unique, latest = self.connection.execute(
                "SELECT COUNT(*), COALESCE(MAX(sequence), 0) FROM events WHERE run_id = ?", (run_id,)).fetchone()
            distinct = self.connection.execute(
                "SELECT COUNT(DISTINCT sequence) FROM events WHERE run_id = ?", (run_id,)).fetchone()[0]
        return {"run_id": run_id, "received": stats[0], "unique_events": unique, "duplicates_ignored": stats[1],
                "conflicts_rejected": stats[2], "invalid_rejected": stats[3], "latest_sequence": latest,
                "missing_sequences": max(0, latest - distinct)}

    def diagnostics(self, run_id: str, limit: int = 50) -> list[dict]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT event_id, code, message, received_at FROM diagnostics WHERE run_id = ? ORDER BY id DESC LIMIT ?",
                (run_id, limit)).fetchall()
        return [{"event_id": r[0], "code": r[1], "message": r[2], "received_at": r[3]} for r in rows]

    # Moments --------------------------------------------------------------
    def save_moments(self, run_id: str, moments: list[dict]) -> int:
        """Conditional creation: an existing moment_id is never overwritten."""
        created = 0
        now = _now()
        with self.lock:
            for moment in moments:
                cursor = self.connection.execute(
                    "INSERT OR IGNORE INTO moments VALUES (?, ?, ?, ?, ?)",
                    (run_id, moment["moment_id"], moment["source_sequence"], json.dumps(moment, sort_keys=True), now))
                created += cursor.rowcount
        return created

    def moments(self, run_id: str, through_sequence: int | None = None) -> list[dict]:
        query = "SELECT payload FROM moments WHERE run_id = ?"
        params: tuple = (run_id,)
        if through_sequence is not None:
            query += " AND source_sequence <= ?"
            params += (through_sequence,)
        with self.lock:
            rows = [json.loads(row[0]) for row in self.connection.execute(query + " ORDER BY source_sequence, moment_id", params)]
        return rows

    # Replay state ---------------------------------------------------------
    def save_replay_state(self, run_id: str, payload: dict) -> None:
        with self.lock:
            self.connection.execute("INSERT OR REPLACE INTO replay_state VALUES (1, ?, ?, ?)",
                                    (run_id, json.dumps(payload), _now()))

    def load_replay_state(self) -> dict | None:
        with self.lock:
            row = self.connection.execute("SELECT payload FROM replay_state WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else None
