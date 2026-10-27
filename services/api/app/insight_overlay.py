"""Overlay narrated insights (Cosmos `insights`, written by the narration worker) onto the snapshot's moments.

The bridge and the API run the same deterministic detector on the same events, so a moment's ID suffix
(`goal:v1:evt-0340`) is identical in both. For the replay's source run, each stored insight replaces the
API's local template only if it re-validates against the API's own copy of the moment (numbers, names,
IDs and meaning checks). The overlay is explicit: its mode and status travel in every snapshot, and a
Cosmos failure is reported, never hidden behind the local text.
"""
from __future__ import annotations

import hashlib
import os
from threading import Lock
from time import monotonic
from typing import Callable

from agents.insights import classify
from agents.validation import validate_insight

from .analysis import narration_context


def _suffix(moment_id: str, run_id: str) -> str:
    return moment_id[len(run_id) + 1:] if moment_id.startswith(run_id + ":") else moment_id


def _with_status(moment: dict, status: str, reason: str) -> dict:
    return {**moment, "insight": {**moment["insight"], "generation_status": status, "generation_reason": reason[:300]}}


class InsightOverlay:
    def __init__(self, fetch: Callable[[str], list[dict]] | None, mode: str = "off", ttl_s: float = 3.0,
                 clock: Callable[[], float] = monotonic):
        self.fetch, self.mode, self.ttl_s, self.clock = fetch, mode, ttl_s, clock
        self._lock = Lock()
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._error: str | None = None

    def _records(self, source_run_id: str) -> list[dict]:
        with self._lock:
            cached = self._cache.get(source_run_id)
            if cached and self.clock() - cached[0] < self.ttl_s:
                return cached[1]
        try:
            records = self.fetch(source_run_id)
            self._error = None
        except Exception as exc:  # Cosmos SDK raises several types; report, keep the last good copy.
            self._error = f"{type(exc).__name__}: {str(exc)[:160]}"
            return cached[1] if cached else []
        with self._lock:
            self._cache[source_run_id] = (self.clock(), records)
        return records

    def apply(self, moments: list[dict], events: list[dict], source_run_id: str | None) -> tuple[list[dict], dict]:
        """Return (moments with narrated insights where valid, status for the snapshot)."""
        status = {"mode": self.mode, "status": "off", "source_run_id": source_run_id, "narrated": 0,
                  "ai": 0, "rejected": 0, "error": None, "version": "none"}
        if self.fetch is None:
            if self.mode != "off":
                status.update(status="error", error=self._error or "insight source is not configured")
            return moments, status
        if not source_run_id:
            return moments, status
        by_suffix = {_suffix(r["moment_id"], r["run_id"]): r for r in self._records(source_run_id)}
        actors_of = {e["event_id"]: e.get("player_id") for e in events}
        out, digest = [], hashlib.sha256()
        for moment in moments:
            record = by_suffix.get(_suffix(moment["moment_id"], moment["run_id"]))
            if record is None:
                # AI narration is on for this run but has not published this moment yet: the template stands in.
                out.append(_with_status(moment, "pending", "AI narration has not reached this moment yet"))
                continue
            kind, reason = classify(record)
            candidate = {**record["insight"], "run_id": moment["run_id"], "moment_id": moment["moment_id"],
                         "generation_status": kind, "generation_reason": reason}
            actors = sorted({actors_of[i] for i in moment["evidence_ids"] if actors_of.get(i)})
            if problems := validate_insight(candidate, moment, narration_context(actors)):
                status["rejected"] += 1  # Never publish what fails our own checks, whatever wrote it.
                out.append(_with_status(moment, "rejected", f"API re-check rejected the stored text: {problems[0][:200]}"))
                continue
            out.append({**moment, "insight": candidate})
            status["narrated"] += 1
            status["ai"] += candidate["generation_mode"] == "ai"
            digest.update(f"{moment['moment_id']}|{candidate['generation_mode']}|{candidate['headline']}".encode())
        status.update(status="error" if self._error else "ok", error=self._error,
                      version=digest.hexdigest()[:12] if status["narrated"] else "none")
        return out, status


def from_env() -> InsightOverlay:
    """OMNIPITCH_INSIGHTS=cosmos reads COSMOS_ENDPOINT/COSMOS_DATABASE (COSMOS_KEY from env, else Entra ID)."""
    mode = os.getenv("OMNIPITCH_INSIGHTS", "off").strip().lower()
    if mode != "cosmos":
        return InsightOverlay(None, "off")
    endpoint = os.getenv("COSMOS_ENDPOINT", "")
    if not endpoint.startswith("https://") or "AccountKey" in endpoint:
        overlay = InsightOverlay(None, "cosmos")
        overlay._error = "COSMOS_ENDPOINT must be the https account endpoint (no keys)."
        return overlay
    try:
        from agents.insights import CosmosInsightStore
        store = CosmosInsightStore(endpoint, os.getenv("COSMOS_DATABASE", "omnipitch"), os.getenv("COSMOS_TENANT_ID") or None)
    except Exception as exc:  # Report a broken insight source in every snapshot; never fail the replay.
        overlay = InsightOverlay(None, "cosmos")
        overlay._error = f"insight source unavailable: {type(exc).__name__}: {str(exc)[:160]}"
        return overlay
    return InsightOverlay(store.insights, "cosmos")
