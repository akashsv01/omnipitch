"""Narration worker CLI: claim narration jobs created by the bridge and publish validated insights.

Run from the repository root:

    .venv/Scripts/python.exe services/agents/run_narrator.py --once            # drain claimable jobs, then exit
    .venv/Scripts/python.exe services/agents/run_narrator.py --interval 2      # keep polling

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
    parser.add_argument("--bridge-db", help="Bridge SQLite store (default data/generated/bridge.sqlite3)")
    parser.add_argument("--narration-db", help="Insight store (default data/generated/narration.sqlite3)")
    args = parser.parse_args(argv)
    load_env_file()
    try:
        config = AzureOpenAIConfig.from_env()
    except ValueError as exc:
        log({"stage": "startup", "outcome": "error", "error": str(exc)})
        return 2
    client = AzureOpenAIClient(config) if config else None
    owner = f"narrator-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    worker = NarrationWorker(SqliteStore(args.bridge_db), SqliteInsightStore(args.narration_db), client, owner,
                             context_for, log=log)
    log({"stage": "startup", "outcome": "ok", "owner": owner,
         "mode": client.name if client else "fallback-only (AZURE_OPENAI_ENDPOINT/DEPLOYMENT not set)"})
    while True:
        expired = worker.store.expire_exhausted(utcnow())
        if expired:
            log({"stage": "recovery", "failed_jobs": [job["job_id"] for job in expired]})
        results = worker.drain()
        if args.once:
            log({"stage": "summary", "processed": len(results),
                 "by_status": {s: sum(r["status"] == s for r in results) for s in {r["status"] for r in results}}})
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
