"""Local ingestion latency and delivery-fault check (not a pytest test; run it directly).

Streams a full seeded match into an isolated in-memory API, a few events per request, as a producer would:
  - every 40th event is delivered twice (duplicate delivery);
  - pairs of neighbouring events are swapped (out of order);
  - one event is held back for 30 requests (late), which leaves a gap in the sequence.
After each request it asks /runs/{id}/metrics, which detects moments and builds their validated rule-based insights
over the gap-free prefix. For every moment it records wall-clock time from the request that delivered its source
event (receipt) to the first response that includes it (insight available). Timings are real monotonic-clock
measurements of this machine's in-process path (SQLite ledger + Python analytics); they say nothing about the cloud
pipeline, which is measured separately by services/bridge/trace_report.py.

    .venv/Scripts/python.exe services/api/tests/latency_local.py [--seed 7] [--scenario standard] [--batch 4]
"""
from __future__ import annotations

import argparse
from datetime import date
import json
from pathlib import Path
import sys
from time import perf_counter

HERE = Path(__file__).resolve()
sys.path[:0] = [str(HERE.parents[1]), str(HERE.parents[3] / "services/simulator"), str(HERE.parents[3] / "services/analytics"),
                str(HERE.parents[3] / "services/agents"), str(HERE.parents[3] / "services/bridge")]

from fastapi.testclient import TestClient  # noqa: E402

from app import main, replay as replay_module  # noqa: E402
from app.analysis import moments_with_insights  # noqa: E402
from app.db import Database  # noqa: E402
from app.replay import ReplayStore  # noqa: E402
from simulator.match import simulate_match  # noqa: E402


def nearest_rank(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, round(q * len(ordered) + 0.5) - 1))]


def main_(argv=None) -> dict:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--scenario", default="standard")
    parser.add_argument("--batch", type=int, default=4)
    args = parser.parse_args(argv)
    run_id = f"latency-local-{args.seed}-{args.scenario}"
    events = simulate_match(args.seed, args.scenario, run_id=run_id)

    # Delivery plan: swaps, duplicates and one late event.
    order = list(events)
    for i in range(10, len(order) - 1, 97):
        order[i], order[i + 1] = order[i + 1], order[i]
    held = order.pop(300)
    batches = [order[i:i + args.batch] for i in range(0, len(order), args.batch)]
    for index in range(0, len(batches), 10):
        batches[index] = batches[index] + batches[index][:1]  # duplicate delivery
    batches.insert(min(len(batches), 75 + 30), [held])

    store = ReplayStore(db=Database(":memory:"), source=None)
    replay_module.replay_store = store
    client = TestClient(main.app)
    received_at: dict[int, float] = {}
    seen: dict[str, float] = {}
    latencies: list[float] = []
    failures = 0
    request_ms: list[float] = []
    for batch in batches:
        body = "\n".join(json.dumps(e) for e in batch)
        start = perf_counter()
        response = client.post(f"/api/v1/runs/{run_id}/ingest", content=body.encode())
        if response.status_code != 200:
            failures += 1
            continue
        for event in batch:
            received_at.setdefault(event["sequence"], start)
        metrics = client.get(f"/api/v1/runs/{run_id}/metrics")
        done = perf_counter()
        request_ms.append((done - start) * 1000)
        if metrics.status_code != 200:
            failures += 1
            continue
        # /metrics reports counts; the moment list comes from the same detector over the same prefix.
        ledger = store.db.ledger_events(run_id)
        prefix = []
        for event in ledger:
            if event["sequence"] != len(prefix) + 1:
                break
            prefix.append(event)
        found = moments_with_insights(prefix, run_id, events[0]["match_id"]) if prefix else []
        for moment in found:
            if moment["moment_id"] not in seen:
                seen[moment["moment_id"]] = done
                latencies.append((done - received_at[moment["source_sequence"]]) * 1000)
    summary = store.db.ledger_summary(run_id)
    reference = moments_with_insights(events, run_id, events[0]["match_id"])
    report = {
        "run_id": run_id, "date": date.today().isoformat(), "path": "local in-process: POST ingest -> SQLite ledger -> detection + validated template insight",
        "requests": len(batches), "events": len(events), "ledger": summary, "request_failures": failures,
        "moments": len(seen), "moments_in_clean_reference": len(reference),
        "same_moments_as_clean_delivery": sorted(seen) == sorted(m["moment_id"] for m in reference),
        "receipt_to_insight_ms": {"p50": round(nearest_rank(latencies, .5), 1), "p95": round(nearest_rank(latencies, .95), 1),
                                  "max": round(max(latencies), 1), "n": len(latencies)},
        "request_round_trip_ms": {"p50": round(nearest_rank(request_ms, .5), 1), "p95": round(nearest_rank(request_ms, .95), 1)},
        "note": "Moments behind the held-back event wait for it: their receipt-to-insight time includes that wait.",
    }
    out = HERE.parents[3] / f"data/generated/latency-local-{report['date']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    main_()
