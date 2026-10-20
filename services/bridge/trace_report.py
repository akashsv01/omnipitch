"""Latency/cost report for one run: python services/bridge/trace_report.py --run-id gate-20261020-b

Reads Eventhouse ingestion times (az login identity) and the run's moments, jobs and insights from Cosmos
(COSMOS_ENDPOINT; Entra ID or COSMOS_KEY from the environment). Prints p50/p95 per stage, model calls and
timings from insight traces, and the Cosmos request charge (RU) of the report's own reads. The bridge logs
its per-cycle RU as `request_charge_ru`. Writes JSON with --out. No payload text, prompts or secrets.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents", "services/bridge"):
    if str(ROOT / package) not in sys.path:
        sys.path.insert(0, str(ROOT / package))

from app.config import settings  # noqa: E402
from app.eventhouse import EventhouseReader  # noqa: E402
from omnipitch_bridge.cosmos_store import CosmosStore  # noqa: E402
from omnipitch_bridge.trace import run_report  # noqa: E402


def fmt(value) -> str:
    return "-" if value is None else f"{value:.3f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out", help="Write the JSON report to this path (for example data/generated/trace-<run>.json)")
    args = parser.parse_args(argv)
    config = settings()
    store = CosmosStore(os.environ["COSMOS_ENDPOINT"], os.getenv("COSMOS_DATABASE", "omnipitch"), config.tenant_id)
    insights_c = store.client.get_database_client(os.getenv("COSMOS_DATABASE", "omnipitch")).get_container_client("insights")
    insights = [{k: v for k, v in item.items() if k in ("moment_id", "created_at", "trace")}
                for item in insights_c.query_items("SELECT c.moment_id, c.created_at, c.trace FROM c", partition_key=args.run_id)]
    store._charge("read_insights", insights_c)
    report = run_report(args.run_id, store.moments(args.run_id), EventhouseReader(config).ingestion_times(args.run_id),
                        store.moment_detected_at(args.run_id), store.jobs(args.run_id), insights,
                        request_charge=store.request_charge)
    print(f"run {report['run_id']}: {report['moments']} moments, {report['jobs']} jobs, {report['insights']} insights")
    print(f"{'stage':<22}{'n':>5}{'p50 s':>12}{'p95 s':>12}")
    for stage, row in report["stages_seconds"].items():
        print(f"{stage:<22}{row['n']:>5}{fmt(row['p50']):>12}{fmt(row['p95']):>12}")
    model = report["model"]
    print(f"model calls: {model['model_calls']} ({', '.join(model['models']) or 'none'}); tokens: "
          f"{model['tokens'] if model['tokens'] is not None else 'not recorded'}"
          + (f" ({model['tokens_note']})" if model["tokens_note"] else ""))
    for role, row in model["role_seconds"].items():
        print(f"  {role:<12} n={row['n']:<3} p50 {fmt(row['p50'])} s  p95 {fmt(row['p95'])} s")
    print(f"cosmos RU (this report's reads): {report['cosmos_request_charge_ru']}")
    print(f"web pubsub messages: {report['pubsub_messages'] if report['pubsub_messages'] is not None else 'not built'}")
    for note in report["notes"]:
        print(f"note: {note}")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
