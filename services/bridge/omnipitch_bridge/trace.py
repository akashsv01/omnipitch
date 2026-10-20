"""Per-moment latency and cost tracing for one run.

Stages, anchored on each moment's source event (the event at source_sequence that completed it):

    emitted_at -> Eventhouse ingestion -> bridge detection -> job created -> insight created -> published

`emitted_at` is a synthetic fixture clock in simulator runs (2026-01-01 baseline), not a send time, so the
first stage is reported as not measurable when it is implausible; Eventhouse ingestion is then the first
wall-clock timestamp. Publication is not measurable until push delivery exists. Nothing here reads or
logs payload text, prompts or secrets: only timestamps, counts and the trace's timing/usage fields.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import math

from .store import parse_iso

STAGES = ("emit_to_ingest", "ingest_to_detect", "detect_to_job", "job_to_insight", "insight_to_published", "ingest_to_insight")
SYNTHETIC_CLOCK = timedelta(days=1)  # An emit->ingest gap beyond this (or negative) is a fixture clock, not latency.


def _ts(value) -> datetime | None:
    if value is None:
        return None
    return value if isinstance(value, datetime) else parse_iso(str(value))


def _seconds(start: datetime | None, end: datetime | None) -> float | None:
    if start is None or end is None:
        return None
    return round((end - start).total_seconds(), 3)


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile; None for no samples."""
    ordered = sorted(values)
    if not ordered:
        return None
    return ordered[max(0, math.ceil(q / 100 * len(ordered)) - 1)]


def moment_timeline(moment: dict, ingestion: dict[str, dict], detected_at: str | None, job: dict | None,
                    insight: dict | None, published_at: str | None = None) -> dict:
    source = next((row for row in ingestion.values() if row["sequence"] == moment["source_sequence"]), None)
    emitted = _ts(source["emitted_at"]) if source else None
    ingested = _ts(source["ingested"]) if source else None
    detected, job_at = _ts(detected_at), _ts(job["created_at"]) if job else None
    insight_at, published = (_ts(insight["created_at"]) if insight else None), _ts(published_at)
    emit = _seconds(emitted, ingested)
    synthetic = emit is not None and (emit < 0 or emit > SYNTHETIC_CLOCK.total_seconds())
    return {"moment_id": moment["moment_id"], "rule": moment["rule"],
            "emit_to_ingest": None if synthetic else emit, "emit_clock_synthetic": synthetic,
            "ingest_to_detect": _seconds(ingested, detected), "detect_to_job": _seconds(detected, job_at),
            "job_to_insight": _seconds(job_at, insight_at), "insight_to_published": _seconds(insight_at, published),
            "ingest_to_insight": _seconds(ingested, insight_at)}


def model_usage(insights: list[dict]) -> dict:
    """Model calls and timings from insight traces. Tokens are summed only where a trace records usage."""
    calls, role_ms, tokens, with_usage = 0, {}, 0, 0
    models = set()
    for record in insights:
        trace = record.get("trace") or {}
        if trace.get("model"):
            models.add(trace["model"])
        for role, entry in trace.items():
            if isinstance(entry, dict) and isinstance(entry.get("ms"), (int, float)):
                calls += 1
                role_ms.setdefault(role, []).append(entry["ms"] / 1000)
                usage = entry.get("usage") or {}
                if isinstance(usage.get("total_tokens"), int):
                    tokens += usage["total_tokens"]
                    with_usage += 1
    return {"models": sorted(models), "model_calls": calls,
            "role_seconds": {role: {"n": len(v), "p50": percentile(v, 50), "p95": percentile(v, 95)} for role, v in sorted(role_ms.items())},
            "tokens": tokens if with_usage else None,
            "tokens_note": None if with_usage == calls else f"usage recorded for {with_usage} of {calls} model calls"}


def run_report(run_id: str, moments: list[dict], ingestion: dict[str, dict], detected_at: dict[str, str],
               jobs: list[dict], insights: list[dict], published: dict[str, str] | None = None,
               request_charge: dict[str, float] | None = None, pubsub_messages: int | None = None) -> dict:
    jobs_by_id = {job["job_id"]: job for job in jobs}
    insights_by_moment = {record["moment_id"]: record for record in insights}
    timelines = [moment_timeline(m, ingestion, detected_at.get(m["moment_id"]), jobs_by_id.get(m["moment_id"]),
                                 insights_by_moment.get(m["moment_id"]), (published or {}).get(m["moment_id"]))
                 for m in moments]
    stages = {}
    for stage in STAGES:
        values = [t[stage] for t in timelines if t[stage] is not None]
        stages[stage] = {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95)}
    synthetic = sum(t["emit_clock_synthetic"] for t in timelines)
    return {"run_id": run_id, "moments": len(moments), "jobs": len(jobs), "insights": len(insights),
            "stages_seconds": stages,
            "notes": [note for note in (
                f"emit_to_ingest not measurable for {synthetic} moments: emitted_at is the simulator's fixture clock" if synthetic else None,
                "insight_to_published not measurable: push delivery is not built yet" if published is None else None) if note],
            "model": model_usage(insights),
            "cosmos_request_charge_ru": request_charge,
            "pubsub_messages": pubsub_messages}
