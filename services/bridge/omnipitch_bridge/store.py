"""Durable records for the bridge: cursor, moments and narration jobs.

SqliteStore is the local implementation and the reference for the planned Cosmos DB store
(containers moments, jobs and leases, partitioned by run_id). Every write is conditional:

- moments and jobs are created only if absent (moment_id / job_id), so reprocessing is a no-op;
- jobs are claimed and completed only if the version read is still current (ETag stand-in),
  and a processing job whose lease has expired can be claimed again.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
from threading import RLock

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PATH = REPOSITORY_ROOT / "data/generated/bridge.sqlite3"
DEFAULT_MAX_ATTEMPTS = 2  # The guide's bounded attempts before a fallback or failure.

SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (cursor_id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS moments (
  run_id TEXT NOT NULL, moment_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, payload TEXT NOT NULL,
  detected_at TEXT NOT NULL, PRIMARY KEY (run_id, moment_id));
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs (status);
"""
TERMINAL = ("ready", "fallback", "failed")


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_job(moment: dict, now: datetime, max_attempts: int = DEFAULT_MAX_ATTEMPTS) -> dict:
    stamp = iso(now)
    return {"schema_version": "1.0", "job_id": moment["moment_id"], "moment_id": moment["moment_id"],
            "run_id": moment["run_id"], "match_id": moment["match_id"], "rule": moment["rule"],
            "priority": moment["priority"], "source_sequence": moment["source_sequence"], "status": "pending",
            "attempt": 0, "max_attempts": max_attempts, "lease_owner": None, "lease_expires_at": None,
            "next_attempt_at": None, "last_error": None, "insight_id": None, "version": 1,
            "created_at": stamp, "updated_at": stamp}


class StaleJob(RuntimeError):
    """The job changed since it was read (version mismatch) or the caller no longer holds the lease."""


class SqliteStore:
    def __init__(self, path: str | Path | None = None):
        path = str(path or os.getenv("OMNIPITCH_BRIDGE_DB") or DEFAULT_PATH)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.connection.executescript(SCHEMA)

    def close(self) -> None:
        self.connection.close()

    # Cursor ---------------------------------------------------------------
    def get_cursor(self, cursor_id: str) -> datetime | None:
        with self.lock:
            row = self.connection.execute("SELECT value FROM cursors WHERE cursor_id = ?", (cursor_id,)).fetchone()
        return parse_iso(row[0]) if row else None

    def set_cursor(self, cursor_id: str, value: datetime) -> None:
        with self.lock:
            self.connection.execute("INSERT OR REPLACE INTO cursors VALUES (?, ?, ?)", (cursor_id, iso(value), iso(utcnow())))

    # Moments --------------------------------------------------------------
    def create_moment(self, moment: dict, now: datetime) -> bool:
        """Create once; evidence frozen at detection time is never overwritten."""
        with self.lock:
            cursor = self.connection.execute(
                "INSERT OR IGNORE INTO moments VALUES (?, ?, ?, ?, ?)",
                (moment["run_id"], moment["moment_id"], moment["source_sequence"], json.dumps(moment, sort_keys=True), iso(now)))
        return cursor.rowcount == 1

    def moments(self, run_id: str) -> list[dict]:
        with self.lock:
            rows = self.connection.execute(
                "SELECT payload FROM moments WHERE run_id = ? ORDER BY source_sequence, moment_id", (run_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    # Jobs -----------------------------------------------------------------
    def create_job(self, job: dict) -> bool:
        with self.lock:
            cursor = self.connection.execute("INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?)",
                                             (job["job_id"], job["run_id"], job["status"], job["version"], json.dumps(job)))
        return cursor.rowcount == 1

    def get_job(self, job_id: str) -> dict | None:
        with self.lock:
            row = self.connection.execute("SELECT payload FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def jobs(self, run_id: str | None = None, status: str | None = None) -> list[dict]:
        query, params = "SELECT payload FROM jobs WHERE 1 = 1", []
        if run_id is not None:
            query, params = query + " AND run_id = ?", params + [run_id]
        if status is not None:
            query, params = query + " AND status = ?", params + [status]
        with self.lock:
            rows = self.connection.execute(query, params).fetchall()
        return sorted((json.loads(row[0]) for row in rows), key=lambda job: (job["run_id"], job["source_sequence"], job["job_id"]))

    def _replace(self, job: dict, expected_version: int) -> None:
        cursor = self.connection.execute(
            "UPDATE jobs SET status = ?, version = ?, payload = ? WHERE job_id = ? AND version = ?",
            (job["status"], job["version"], json.dumps(job), job["job_id"], expected_version))
        if cursor.rowcount != 1:
            raise StaleJob(f"job {job['job_id']} changed since version {expected_version}")

    def claim_next(self, owner: str, now: datetime, lease: timedelta = timedelta(seconds=60),
                   run_id: str | None = None) -> dict | None:
        """Claim the highest-priority claimable job: pending, retry_wait that is due, or processing with an expired lease.
        With run_id, only that run's jobs are considered (tests and dry runs must not claim other runs)."""
        query, params = "SELECT payload FROM jobs WHERE status IN ('pending', 'retry_wait', 'processing')", ()
        if run_id is not None:
            query, params = query + " AND run_id = ?", (run_id,)
        with self.lock:
            candidates = [json.loads(row[0]) for row in self.connection.execute(query, params)]
            for job in sorted((j for j in candidates if claimable(j, now)), key=claim_order):
                updated = claimed(job, owner, now, lease)
                try:
                    self._replace(updated, job["version"])
                except StaleJob:
                    continue  # Another worker won this job; try the next one.
                return updated
        return None

    def complete(self, job: dict, owner: str, now: datetime, status: str, insight_id: str | None = None,
                 error: str | None = None, retry_after: timedelta | None = None) -> dict:
        """Record the outcome of a claimed job. Raises StaleJob if the lease was lost."""
        with self.lock:
            current = self.get_job(job["job_id"])
            updated = completed(current, job, owner, now, status, insight_id, error, retry_after)
            self._replace(updated, current["version"])
            return updated

    def expire_exhausted(self, now: datetime, run_id: str | None = None) -> list[dict]:
        """Recovery pass: a processing job whose lease expired on its last attempt becomes failed, visibly."""
        failed = []
        query, params = "SELECT payload FROM jobs WHERE status = 'processing'", ()
        if run_id is not None:
            query, params = query + " AND run_id = ?", (run_id,)
        with self.lock:
            for row in self.connection.execute(query, params).fetchall():
                job = json.loads(row[0])
                if is_exhausted(job, now):
                    updated = exhausted(job, now)
                    try:
                        self._replace(updated, job["version"])
                        failed.append(updated)
                    except StaleJob:
                        pass
        return failed


# Job transitions shared by every store: stores only differ in how a conditional write is done.

def claimable(job: dict, now: datetime) -> bool:
    if job["attempt"] >= job["max_attempts"]:
        return False  # An abandoned last attempt is resolved by expire_exhausted, not claimed again.
    if job["status"] == "pending":
        return True
    if job["status"] == "retry_wait":
        return job["next_attempt_at"] is None or parse_iso(job["next_attempt_at"]) <= now
    return job["status"] == "processing" and _lease_expired(job, now)


def _lease_expired(job: dict, now: datetime) -> bool:
    return job["lease_expires_at"] is not None and parse_iso(job["lease_expires_at"]) <= now


def claim_order(job: dict) -> tuple:
    return (-job["priority"], job["created_at"], job["job_id"])


def claimed(job: dict, owner: str, now: datetime, lease: timedelta) -> dict:
    return {**job, "status": "processing", "attempt": job["attempt"] + 1, "lease_owner": owner,
            "lease_expires_at": iso(now + lease), "next_attempt_at": None, "updated_at": iso(now),
            "version": job["version"] + 1}


def completed(current: dict | None, held: dict, owner: str, now: datetime, status: str, insight_id: str | None,
              error: str | None, retry_after: timedelta | None) -> dict:
    if status not in TERMINAL + ("retry_wait",):
        raise ValueError(f"unsupported completion status {status!r}")
    if status in ("ready", "fallback") and not insight_id:
        raise ValueError("ready and fallback jobs need an insight_id")
    if current is None or current["version"] != held["version"] or current["lease_owner"] != owner:
        raise StaleJob(f"job {held['job_id']} is no longer held by {owner}")
    if status == "retry_wait" and current["attempt"] >= current["max_attempts"]:
        raise ValueError("no attempts remain; complete as fallback or failed instead")
    return {**current, "status": status, "insight_id": insight_id, "last_error": (error or None) and error[:500],
            "lease_owner": None, "lease_expires_at": None, "updated_at": iso(now),
            "next_attempt_at": iso(now + retry_after) if status == "retry_wait" and retry_after else None,
            "version": current["version"] + 1}


def is_exhausted(job: dict, now: datetime) -> bool:
    return job["status"] == "processing" and job["attempt"] >= job["max_attempts"] and _lease_expired(job, now)


def exhausted(job: dict, now: datetime) -> dict:
    return {**job, "status": "failed", "lease_owner": None, "lease_expires_at": None, "updated_at": iso(now),
            "last_error": "lease expired on the last attempt", "version": job["version"] + 1}
