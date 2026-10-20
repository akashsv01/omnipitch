"""Phase 3 gate on a fresh run: one live moment -> one validated AI insight; restart -> no duplicates;
forced model failure -> labelled fallback. Runs against Cosmos DB (jobs/moments from the bridge) and the
configured Azure OpenAI deployment. Every stage reports PASS / FAIL / UNVERIFIED; nothing is inferred.

Prerequisites: services/api/.env has COSMOS_ENDPOINT (+ COSMOS_KEY or Entra ID) and AZURE_OPENAI_*;
the bridge has created jobs for the run (run_bridge.py --store cosmos --once on the Eventhouse owner's side).

    .venv/Scripts/python.exe services/api/tests/phase3_gate.py --run-id gate-20261016-a

Only jobs of --run-id are claimed (store.claim_next(..., run_id=...)). Model calls are capped by --ai-jobs (default 3); the
rest of the run is drained fallback-only at no model cost. Report: data/generated/phase3-gate-<run>.json.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents", "services/bridge"):
    sys.path.insert(0, str(ROOT / package))

from app.analysis import narration_context  # noqa: E402
from app.config import load_env_file  # noqa: E402

results: list[dict] = []


def stage(name: str, status: str, detail: str, **evidence) -> None:
    results.append({"stage": name, "status": status, "detail": detail, **evidence})
    print(f"[{status:10}] {name}: {detail}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--ai-jobs", type=int, default=3, help="Jobs narrated with the live model (cost cap)")
    parser.add_argument("--wait", type=int, default=600, help="Seconds to wait for bridge jobs")
    args = parser.parse_args()
    load_env_file()
    from jsonschema import Draft202012Validator
    from agents.insights import CosmosInsightStore
    from agents.model import AzureOpenAIClient, AzureOpenAIConfig
    from agents.validation import validate_insight
    from agents.worker import NarrationWorker
    from omnipitch_bridge.cosmos_store import CosmosStore

    endpoint, database = os.environ["COSMOS_ENDPOINT"], os.getenv("COSMOS_DATABASE", "omnipitch")
    base = CosmosStore(endpoint, database)
    store, insights = base, CosmosInsightStore(endpoint, database, client=base.client)
    config = AzureOpenAIConfig.from_env()
    if config is None:
        stage("model_configured", "FAIL", "AZURE_OPENAI_ENDPOINT/DEPLOYMENT not set")
        return finish(args.run_id)
    context_for = lambda moment: narration_context([])  # noqa: E731
    def new(client, owner, no_model_reason="no model configured"):
        return NarrationWorker(store, insights, client, owner, context_for, run_id=args.run_id, no_model_reason=no_model_reason)

    deadline = time.time() + args.wait
    while not base.jobs(args.run_id) and time.time() < deadline:
        print("  waiting for bridge jobs ...", flush=True)
        time.sleep(30)
    jobs = base.jobs(args.run_id)
    if not jobs:
        stage("bridge_jobs", "UNVERIFIED", f"No jobs for {args.run_id} after {args.wait}s; run the bridge on the Eventhouse side.")
        return finish(args.run_id)
    stage("bridge_jobs", "PASS", f"{len(jobs)} jobs, {len(base.moments(args.run_id))} moments from the bridge",
          statuses=dict(Counter(j["status"] for j in jobs)))

    # 1. Live model on a few jobs.
    ai = new(AzureOpenAIClient(config), "gate-ai").drain(args.ai_jobs)
    ready = [r for r in ai if r["status"] == "ready"]
    stage("live_ai_insight", "PASS" if ready else "FAIL",
          f"{len(ready)} of {len(ai)} model-narrated jobs published validated AI insights (others fell back with a reason)",
          outcomes=[{k: r[k] for k in ("job_id", "status", "error")} for r in ai])

    # 2. Forced model failure: a deployment that does not exist -> non-transient error -> labelled fallback.
    broken = AzureOpenAIClient(AzureOpenAIConfig(config.endpoint, "deployment-that-does-not-exist", config.api_version))
    forced = new(broken, "gate-forced-failure").drain(1)
    labelled = forced and forced[0]["status"] == "fallback" and "model error" in (forced[0]["error"] or "")
    record = insights.get_insight(forced[0]["insight_id"], args.run_id) if forced else None
    stated = record and any("AI narration unavailable (model error" in lim for lim in record["insight"]["limitations"])
    stage("forced_failure_fallback", "PASS" if labelled and stated else "FAIL",
          f"{forced[0]['status'] if forced else 'no job'}: {forced[0]['error'] if forced else ''}"[:200])

    # 3. Drain the rest without a model (no cost), then restart: nothing may be processed twice.
    rest = new(None, "gate-fallback", "gate cost cap: remaining jobs narrated without the model").drain()
    restart = new(AzureOpenAIClient(config), "gate-restart").drain()
    stage("restart_no_duplicates", "PASS" if restart == [] else "FAIL",
          f"restart processed {len(restart)} jobs (expected 0); {len(rest)} remaining jobs were narrated fallback-only")

    # 4. Final accounting.
    jobs, records = base.jobs(args.run_id), insights.insights(args.run_id)
    moments = {m["moment_id"]: m for m in base.moments(args.run_id)}
    schema = Draft202012Validator(json.loads((ROOT / "contracts/schemas/insight.schema.json").read_text(encoding="utf-8")))
    invalid = [r["insight_id"] for r in records if list(schema.iter_errors(r["insight"]))
               or validate_insight(r["insight"], moments[r["moment_id"]], narration_context([]))]
    ids = [r["insight_id"] for r in records]
    ok = (len(records) == len(jobs) == len(moments) == len(set(ids)) and not invalid
          and all(j["status"] in ("ready", "fallback") and j["insight_id"] == j["job_id"] for j in jobs))
    stage("one_insight_per_moment", "PASS" if ok else "FAIL",
          f"moments {len(moments)}, jobs {dict(Counter(j['status'] for j in jobs))}, insights "
          f"{dict(Counter(r['insight']['generation_mode'] for r in records))}, distinct ids {len(set(ids))}, invalid {len(invalid)}")
    return finish(args.run_id)


def finish(run_id: str) -> int:
    out = ROOT / f"data/generated/phase3-gate-{run_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"run_id": run_id, "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "stages": results}, indent=1, default=str), encoding="utf-8")
    print(f"Report: {out}")
    return 1 if any(r["status"] == "FAIL" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
