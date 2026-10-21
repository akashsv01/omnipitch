"""Latency/cost tracing: stage timings, synthetic emit clock, percentiles and model usage."""
from __future__ import annotations

from omnipitch_bridge.trace import model_usage, moment_timeline, percentile, run_report


def ingestion(emitted="2026-10-20T02:34:10.000Z", ingested="2026-10-20T02:34:12.000Z"):
    return {"evt-0010": {"sequence": 10, "emitted_at": emitted, "ingested": ingested}}


MOMENT = {"moment_id": "r:goal:v1:evt-0010", "rule": "goal", "source_sequence": 10}
JOB = {"job_id": MOMENT["moment_id"], "created_at": "2026-10-20T02:34:15.000Z"}
INSIGHT = {"moment_id": MOMENT["moment_id"], "created_at": "2026-10-20T02:34:25.500Z",
           "trace": {"model": "azure-openai:gpt-41-mini", "analyst": {"ms": 3000}, "coach": {"ms": 4000},
                     "broadcaster": {"ms": 5000, "usage": {"total_tokens": 900}}}}


def test_timeline_measures_each_stage():
    t = moment_timeline(MOMENT, ingestion(), "2026-10-20T02:34:14.000Z", JOB, INSIGHT, "2026-10-20T02:34:26.000Z")
    assert (t["emit_to_ingest"], t["ingest_to_detect"], t["detect_to_job"], t["job_to_insight"],
            t["insight_to_published"], t["ingest_to_insight"]) == (2.0, 2.0, 1.0, 10.5, 0.5, 13.5)
    assert t["emit_clock_synthetic"] is False


def test_fixture_emit_clock_is_not_reported_as_latency():
    t = moment_timeline(MOMENT, ingestion(emitted="2026-01-01T12:00:00.000Z"), None, None, None)
    assert t["emit_clock_synthetic"] is True and t["emit_to_ingest"] is None
    assert t["ingest_to_detect"] is None and t["job_to_insight"] is None  # Missing stages stay None, not 0.


def test_percentiles_use_nearest_rank():
    values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert percentile(values, 50) == 5 and percentile(values, 95) == 10 and percentile([], 50) is None


def test_model_usage_counts_calls_and_never_invents_tokens():
    usage = model_usage([INSIGHT, {"moment_id": "x", "created_at": "2026-10-20T02:35:00Z",
                                    "trace": {"model": "m", "error": "ModelError: 404"}}])
    assert usage["model_calls"] == 3 and usage["tokens"] == 900
    assert usage["tokens_note"] == "usage recorded for 1 of 3 model calls"
    assert model_usage([{"moment_id": "y", "created_at": "2026-10-20T02:35:00Z",
                         "trace": {"analyst": {"ms": 1}}}])["tokens"] is None


def test_run_report_notes_what_cannot_be_measured():
    report = run_report("r", [MOMENT], ingestion(emitted="2026-01-01T12:00:00.000Z"),
                        {MOMENT["moment_id"]: "2026-10-20T02:34:14.000Z"}, [JOB], [INSIGHT])
    assert report["stages_seconds"]["ingest_to_insight"] == {"n": 1, "p50": 13.5, "p95": 13.5}
    assert report["stages_seconds"]["emit_to_ingest"]["n"] == 0
    assert any("fixture clock" in note for note in report["notes"])
    assert any("no insight messages were published" in note for note in report["notes"])
    assert report["pubsub_messages"] is None
