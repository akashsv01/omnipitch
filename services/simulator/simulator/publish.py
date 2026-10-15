"""Publish a seeded synthetic match to Azure Event Hubs.

Authentication uses Azure Identity (the signed-in `az login` identity locally); no connection
strings or keys. The identity needs the "Azure Event Hubs Data Sender" role on the namespace
or event hub. Every event is validated against contracts/schemas/event.schema.json first.

Example (PowerShell, repository root):
    $env:PYTHONPATH = "$PWD/services/simulator"
    .venv/Scripts/python.exe -m simulator.publish --seed 7 --run-id smoke-20261014a --count 400 --duplicate 25
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from .match import SCENARIOS, simulate_match

ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = ROOT / "services/api/.env"


def load_env_file(path: Path = ENV_FILE) -> None:
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def validate(events: list[dict]) -> None:
    from jsonschema import Draft202012Validator, FormatChecker
    schema = json.loads((ROOT / "contracts/schemas/event.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    ids = set()
    for event in events:
        validator.validate(event)
        if event["event_id"] in ids:
            raise ValueError(f"duplicate event_id {event['event_id']} inside one send batch")
        ids.add(event["event_id"])


def explain(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}"
    lowered = text.lower()
    if "credentialunavailable" in lowered or "az login" in lowered:
        return "No Azure credential available. Run 'az login' in this environment."
    if "unauthorized" in lowered or "401" in text or "403" in text or "forbidden" in lowered:
        return ("Signed in, but this identity cannot send. Assign 'Azure Event Hubs Data Sender' on the namespace "
                "or event hub, wait a few minutes for propagation, then retry.")
    if "not found" in lowered or "404" in text or "entitynotfound" in lowered:
        return "Event hub not found. Check EVENTHUB_NAME and EVENTHUB_FULLY_QUALIFIED_NAMESPACE."
    if "getaddrinfo" in lowered or "name resolution" in lowered or "nodename" in lowered:
        return "Namespace host did not resolve. Check EVENTHUB_FULLY_QUALIFIED_NAMESPACE."
    return text[:500]


def send(events: list[dict], namespace: str, hub: str, partition_key: str) -> int:
    from azure.eventhub import EventData, EventHubProducerClient
    from azure.identity import AzureCliCredential, DefaultAzureCredential
    # EVENTHUB_TENANT_ID pins the tenant that owns the namespace when the CLI is signed in to several tenants.
    tenant = os.getenv("EVENTHUB_TENANT_ID")
    credential = AzureCliCredential(tenant_id=tenant) if tenant else DefaultAzureCredential(exclude_interactive_browser_credential=True)
    sent = 0
    with EventHubProducerClient(fully_qualified_namespace=namespace, eventhub_name=hub, credential=credential) as producer:
        batch = producer.create_batch(partition_key=partition_key)
        for event in events:
            data = EventData(json.dumps(event, separators=(",", ":")))
            data.content_type = "application/json"
            data.properties = {"run_id": event["run_id"], "event_id": event["event_id"], "schema_version": event["schema_version"]}
            try:
                batch.add(data)
            except ValueError:  # Batch full: send and start another.
                producer.send_batch(batch)
                sent += len(batch)
                batch = producer.create_batch(partition_key=partition_key)
                batch.add(data)
        if len(batch):
            producer.send_batch(batch)
            sent += len(batch)
    return sent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--scenario", choices=SCENARIOS, default="standard")
    parser.add_argument("--run-id", required=True, help="Use a new, distinct run ID per smoke test")
    parser.add_argument("--count", type=int, default=0, help="Send only the first N events (0 = full match)")
    parser.add_argument("--duplicate", type=int, default=0, help="Re-send the first N events as a second delivery")
    parser.add_argument("--dry-run", action="store_true", help="Validate and write the report without sending")
    args = parser.parse_args(argv)
    load_env_file()
    events = simulate_match(args.seed, args.scenario, run_id=args.run_id)
    if args.count:
        events = events[:args.count]
    validate(events)
    namespace = os.getenv("EVENTHUB_FULLY_QUALIFIED_NAMESPACE")
    hub = os.getenv("EVENTHUB_NAME")
    report = {"run_id": args.run_id, "match_id": events[0]["match_id"], "seed": args.seed, "scenario": args.scenario,
              "namespace": namespace, "eventhub": hub, "partition_key": f"{args.run_id}:{events[0]['match_id']}",
              "unique_events": len(events), "duplicates_requested": min(args.duplicate, len(events)),
              "first_event_id": events[0]["event_id"], "last_event_id": events[-1]["event_id"],
              "event_ids": [e["event_id"] for e in events], "dry_run": args.dry_run,
              "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    out = ROOT / f"data/generated/publish-{args.run_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not args.dry_run:
        if not namespace or not hub:
            print("Set EVENTHUB_FULLY_QUALIFIED_NAMESPACE and EVENTHUB_NAME (services/api/.env or environment).", file=sys.stderr)
            return 2
        try:
            report["sent_first_delivery"] = send(events, namespace, hub, report["partition_key"])
            if args.duplicate:
                report["sent_duplicate_delivery"] = send(events[:args.duplicate], namespace, hub, report["partition_key"])
        except Exception as exc:  # Report the cause precisely; never claim success.
            report["error"] = explain(exc)
            out.write_text(json.dumps(report, indent=1), encoding="utf-8")
            print(f"FAILED: {report['error']}", file=sys.stderr)
            return 1
    report["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    action = "Validated (dry run)" if args.dry_run else f"Sent {report.get('sent_first_delivery')} + {report.get('sent_duplicate_delivery', 0)} duplicate"
    print(f"{action} events for run {args.run_id} to {namespace}/{hub}. Report: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
