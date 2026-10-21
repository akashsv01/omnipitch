"""Bridge worker CLI: poll Fabric Eventhouse and create moment and narration-job records.

Run from the repository root after `az login` (identity needs Viewer on the Fabric workspace):

    .venv/Scripts/python.exe services/bridge/run_bridge.py --once
    .venv/Scripts/python.exe services/bridge/run_bridge.py --interval 2 --reconcile-every 30

Eventhouse settings come from services/api/.env (EVENTHOUSE_QUERY_URI, EVENTHOUSE_DATABASE,
EVENTHOUSE_TABLE). Records go to the local SQLite store (OMNIPITCH_BRIDGE_DB, default
data/generated/bridge.sqlite3), or with --store cosmos to Cosmos DB (COSMOS_ENDPOINT, COSMOS_DATABASE;
Entra ID, or COSMOS_KEY from the environment only). Each cycle also runs the job recovery pass.
Logs are JSON lines without secrets.
"""
from __future__ import annotations

import argparse
import os
from datetime import timedelta
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents", "services/bridge"):
    if str(ROOT / package) not in sys.path:
        sys.path.insert(0, str(ROOT / package))

from app.config import ConfigError, settings  # noqa: E402
from app.eventhouse import EventhouseError, EventhouseReader  # noqa: E402

from .bridge import Bridge  # noqa: E402
from .store import SqliteStore, iso, utcnow  # noqa: E402


def log(record: dict) -> None:
    print(json.dumps({"at": iso(utcnow()), **record}, default=str), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between cycles (default 2)")
    parser.add_argument("--lookback", type=float, default=120.0, help="Seconds of ingestion-time overlap (default 120)")
    parser.add_argument("--reconcile-every", type=int, default=30, help="Full pass over recent runs every N cycles; 0 disables")
    parser.add_argument("--store", choices=("sqlite", "cosmos"), default=None,
                        help="Record store (default OMNIPITCH_BRIDGE_STORE or sqlite)")
    parser.add_argument("--db", help="SQLite store path (default data/generated/bridge.sqlite3)")
    parser.add_argument("--push", action="store_true",
                        help="Publish state/moment/reconciliation/insight messages to Web PubSub through the outbox "
                             "(WEBPUBSUB_ENDPOINT, WEBPUBSUB_HUB; Entra ID). Also OMNIPITCH_PUSH=on.")
    args = parser.parse_args(argv)

    try:
        config = settings()
        reader = EventhouseReader(config)
    except (ConfigError, EventhouseError) as exc:
        log({"stage": "startup", "outcome": "error", "error": str(exc)})
        return 2
    kind = args.store or os.getenv("OMNIPITCH_BRIDGE_STORE", "sqlite")
    if kind == "cosmos":
        endpoint = os.getenv("COSMOS_ENDPOINT")
        if not endpoint or not endpoint.startswith("https://") or "AccountKey" in endpoint:
            log({"stage": "startup", "outcome": "error", "error": "COSMOS_ENDPOINT must be the https account endpoint (no keys)."})
            return 2
        from .cosmos_store import CosmosStore
        store = CosmosStore(endpoint, os.getenv("COSMOS_DATABASE", "omnipitch"), config.tenant_id)
    else:
        store = SqliteStore(args.db)
    cursor_id = f"eventhouse:{config.eventhouse_database}.{config.eventhouse_table}"
    outbox = None
    if args.push or os.getenv("OMNIPITCH_PUSH", "off").strip().lower() == "on":
        from .push import HUB, Outbox, WebPubSubClient
        try:
            client = WebPubSubClient(os.getenv("WEBPUBSUB_ENDPOINT", ""), os.getenv("WEBPUBSUB_HUB", HUB))
        except ValueError as exc:
            log({"stage": "startup", "outcome": "error", "error": str(exc)})
            return 2
        outbox = Outbox(store, client, utcnow, log=log)
    bridge = Bridge(reader, store, cursor_id, timedelta(seconds=args.lookback), log=log, outbox=outbox)
    log({"stage": "startup", "outcome": "ok", "source": cursor_id, "store": kind, "push": outbox is not None,
         "cursor": store.get_cursor(cursor_id)})

    cycle = 0
    while True:
        cycle += 1
        try:
            bridge.run_once()
            failed = store.expire_exhausted(utcnow())  # Recovery: abandoned last attempts become visibly failed.
            if failed:
                log({"stage": "recovery", "failed_jobs": [job["job_id"] for job in failed]})
            if args.reconcile_every and cycle % args.reconcile_every == 0:
                bridge.reconcile()
        except EventhouseError as exc:
            # Cursor is unchanged, so the next cycle retries the same window.
            log({"stage": "cycle", "outcome": "error", "code": exc.code, "error": str(exc)[:300]})
            if args.once:
                return 1
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
