"""Narration worker CLI: claim narration jobs created by the bridge and publish validated insights.

Run from the repository root:

    .venv/Scripts/python.exe services/agents/run_narrator.py --once            # drain claimable jobs, then exit
    .venv/Scripts/python.exe services/agents/run_narrator.py --interval 2      # keep polling

Store: --store sqlite (default) or --store cosmos (COSMOS_ENDPOINT, COSMOS_DATABASE; Entra ID, or COSMOS_KEY
from the environment only, for a teammate in another tenant). Containers: jobs and moments (bridge), insights.

Mode is explicit. With AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT set (services/api/.env or the
environment) it calls that deployment with Entra ID (`az login`; identity needs "Cognitive Services
OpenAI User"). Without them it runs fallback-only and every job is labelled as such; it never pretends
AI output. Jobs come from the bridge store (OMNIPITCH_BRIDGE_DB, default data/generated/bridge.sqlite3);
insights go to OMNIPITCH_NARRATION_DB (default data/generated/narration.sqlite3). Logs are JSON lines
without secrets.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents", "services/bridge"):
    if str(ROOT / package) not in sys.path:
        sys.path.insert(0, str(ROOT / package))

from app.analysis import narration_context  # noqa: E402
from app.config import load_env_file  # noqa: E402
from omnipitch_bridge.store import SqliteStore, iso, utcnow  # noqa: E402

from agents.insights import SqliteInsightStore  # noqa: E402
from agents.model import AzureOpenAIClient, AzureOpenAIConfig  # noqa: E402
from agents.worker import NarrationWorker  # noqa: E402


def log(record: dict) -> None:
    print(json.dumps({"at": iso(utcnow()), **record}, default=str), flush=True)


def context_for(moment: dict) -> dict:
    # Evidence actors beyond the moment's own player are not stored on bridge moments yet,
    # so the validator only accepts the moment's player name (stricter, never looser).
    actors = moment.get("facts", {}).get("evidence_player_ids", [])
    return narration_context(actors if isinstance(actors, list) else [])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true", help="Drain claimable jobs once and exit")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--store", choices=("sqlite", "cosmos"), default=None,
                        help="Job and insight store (default OMNIPITCH_BRIDGE_STORE or sqlite)")
    parser.add_argument("--bridge-db", help="Bridge SQLite store (default data/generated/bridge.sqlite3)")
    parser.add_argument("--narration-db", help="Insight store (default data/generated/narration.sqlite3)")
    parser.add_argument("--fallback-only", action="store_true",
                        help="Never call a model, even if AZURE_OPENAI_* is set; every insight is a labelled fallback")
    parser.add_argument("--max-jobs", type=int, default=1000, help="Stop after this many jobs per drain (default 1000)")
    parser.add_argument("--run-id", help="Only claim jobs of this run (recommended for dry runs and tests)")
    args = parser.parse_args(argv)
    load_env_file()
    try:
        config = None if args.fallback_only else AzureOpenAIConfig.from_env()
    except ValueError as exc:
        log({"stage": "startup", "outcome": "error", "error": str(exc)})
        return 2
    kind = args.store or os.getenv("OMNIPITCH_BRIDGE_STORE", "sqlite")
    if kind == "cosmos":
        endpoint = os.getenv("COSMOS_ENDPOINT", "")
        if not endpoint.startswith("https://") or "AccountKey" in endpoint:
            log({"stage": "startup", "outcome": "error", "error": "COSMOS_ENDPOINT must be the https account endpoint (no keys)."})
            return 2
        from omnipitch_bridge.cosmos_store import CosmosStore
        from agents.insights import CosmosInsightStore
        database, tenant = os.getenv("COSMOS_DATABASE", "omnipitch"), os.getenv("COSMOS_TENANT_ID") or None
        store = CosmosStore(endpoint, database, tenant)
        insights = CosmosInsightStore(endpoint, database, tenant, client=store.client)
        auth = "account key (COSMOS_KEY)" if os.getenv("COSMOS_KEY") else "Entra ID"
    else:
        store, insights, auth = SqliteStore(args.bridge_db), SqliteInsightStore(args.narration_db), "local file"
    client = AzureOpenAIClient(config) if config else None
    owner = f"narrator-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    no_model = "fallback-only run (--fallback-only)" if args.fallback_only else "no model configured"
    worker = NarrationWorker(store, insights, client, owner, context_for, log=log, run_id=args.run_id,
                             no_model_reason=no_model)
    mode = client.name if client else ("fallback-only (--fallback-only)" if args.fallback_only
                                       else "fallback-only (AZURE_OPENAI_ENDPOINT/DEPLOYMENT not set)")
    log({"stage": "startup", "outcome": "ok", "owner": owner, "store": kind, "auth": auth, "mode": mode,
         "scope": f"run {args.run_id}" if args.run_id else "all runs"})
    while True:
        expired = worker.recover()  # Own run only; across runs the bridge's recovery pass owns this.
        if expired:
            log({"stage": "recovery", "failed_jobs": [job["job_id"] for job in expired]})
        results = worker.drain(args.max_jobs)
        if args.once:
            log({"stage": "summary", "processed": len(results),
                 "by_status": {s: sum(r["status"] == s for r in results) for s in {r["status"] for r in results}}})
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
