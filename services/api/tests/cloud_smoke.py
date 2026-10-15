"""Phase 2 cloud smoke test: simulator -> Event Hubs -> Eventstream -> Eventhouse -> analytics/API.

Every stage reports PASS, FAIL or UNVERIFIED with a reason; nothing is inferred. Run from the repo root
after `az login` and filling services/api/.env (see docs/ARCHITECTURE.md, "Azure mode"):

    .venv/Scripts/python.exe services/api/tests/cloud_smoke.py --run-id smoke-YYYYMMDD-a
    # Fabric-side only, when someone else published the run (e.g. cross-tenant teammates):
    .venv/Scripts/python.exe services/api/tests/cloud_smoke.py --run-id <published-run> --skip-publish --api http://localhost:8000

Writes data/generated/cloud-smoke-<run_id>.json. Exit code 0 only if no stage failed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents"):
    sys.path.insert(0, str(ROOT / package))

from app.config import ConfigError, settings  # noqa: E402
from app.eventhouse import EventhouseError, EventhouseReader  # noqa: E402
from app.schemas import Event  # noqa: E402
from omnipitch_analytics.detect import detect_moments  # noqa: E402
from omnipitch_analytics.metrics import ppda_series, team_stats  # noqa: E402
from simulator.match import simulate_match  # noqa: E402

TEAMS = ["harbor", "vale"]
results: list[dict] = []


def stage(name: str, status: str, detail: str, **evidence) -> None:
    results.append({"stage": name, "status": status, "detail": detail, **evidence})
    print(f"[{status:10}] {name}: {detail}")


def http(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-id", default=f"smoke-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--scenario", default="standard")
    parser.add_argument("--count", type=int, default=400, help="Events in the fixture (first N of the seeded match)")
    parser.add_argument("--duplicate", type=int, default=25, help="Events delivered a second time")
    parser.add_argument("--skip-publish", action="store_true", help="Verify a run that was already published")
    parser.add_argument("--timeout", type=int, default=600, help="Seconds to wait for Eventstream ingestion")
    parser.add_argument("--api", help="Running API base URL (azure mode) to verify the API stage, e.g. http://localhost:8000")
    args = parser.parse_args()
    expected = simulate_match(args.seed, args.scenario, run_id=args.run_id)[:args.count]
    print(f"Run {args.run_id}: seed {args.seed}, {args.scenario}, {len(expected)} events, {args.duplicate} duplicates")

    # 1. Event Hubs ---------------------------------------------------------------------------
    if args.skip_publish:
        stage("event_hubs_send", "UNVERIFIED", "Skipped (--skip-publish); verify the publisher's report on the sending machine.")
    else:
        from simulator import publish
        code = publish.main(["--seed", str(args.seed), "--scenario", args.scenario, "--run-id", args.run_id,
                             "--count", str(args.count), "--duplicate", str(args.duplicate)])
        report = json.loads((ROOT / f"data/generated/publish-{args.run_id}.json").read_text(encoding="utf-8"))
        if code == 0:
            stage("event_hubs_send", "PASS", f"Sent {report['sent_first_delivery']} + {report.get('sent_duplicate_delivery', 0)} "
                  f"to {report['namespace']}/{report['eventhub']}", partition_key=report["partition_key"])
        else:
            stage("event_hubs_send", "FAIL", report.get("error", "publisher failed"))
            return finish(args.run_id)

    # 2. Eventhouse ingestion -------------------------------------------------------------------
    try:
        config = settings()
        reader = EventhouseReader(config)
    except (ConfigError, EventhouseError) as exc:
        stage("eventhouse_query", "UNVERIFIED", f"Not configured: {exc}")
        return finish(args.run_id)
    deadline = time.time() + args.timeout
    summary = None
    try:
        while time.time() < deadline:
            summary = reader.run_summary(args.run_id)
            if summary["unique_events"] >= len(expected) and summary["raw_rows"] >= len(expected) + (0 if args.skip_publish else args.duplicate):
                break
            print(f"  waiting for ingestion: {summary['raw_rows']} rows, {summary['unique_events']} unique")
            time.sleep(15)
    except EventhouseError as exc:
        stage("eventhouse_query", "FAIL", f"{exc.code}: {exc}")
        return finish(args.run_id)
    if not summary or summary["unique_events"] < len(expected):
        stage("eventhouse_query", "FAIL", f"Only {summary and summary['unique_events']} of {len(expected)} events arrived "
              f"within {args.timeout}s. Check the Eventstream is published and its destination table/mapping.")
        return finish(args.run_id)
    stage("eventhouse_query", "PASS", f"{config.eventhouse_database}.{config.eventhouse_table}: {summary['raw_rows']} rows, "
          f"{summary['unique_events']} unique event IDs", summary=summary)

    # 3. Deduplication and contract round trip --------------------------------------------------
    events = [Event.model_validate(e, strict=False).model_dump(mode="json") for e in reader.events(args.run_id)]
    same = events == expected
    stage("dedup_and_contract", "PASS" if same and len(events) == len(expected) else "FAIL",
          f"{summary['duplicate_rows']} duplicate rows collapsed; {len(events)} events after dedup; "
          f"payloads {'identical to' if same else 'DIFFER from'} the seeded fixture")

    # 4. Metrics parity: KQL vs Python, Eventhouse input vs local fixture -----------------------
    kql = {row["team_id"]: row for row in reader.team_counts(args.run_id)}
    mismatches = []
    for team in TEAMS:
        cloud, local = team_stats(events, team), team_stats(expected, team)
        if cloud != local:
            mismatches.append(f"{team}: python(eventhouse) != python(fixture)")
        for kql_name, py_name in (("pass_attempts", "passes_attempted"), ("passes_completed", "passes_completed"),
                                  ("shots", "shots"), ("goals", "goals"), ("defensive_actions", "defensive_actions")):
            if int(kql.get(team, {}).get(kql_name, -1)) != cloud[py_name]:
                mismatches.append(f"{team}.{kql_name}: kql {kql.get(team, {}).get(kql_name)} vs python {cloud[py_name]}")
        if abs(float(kql.get(team, {}).get("progression_m", -1)) - cloud["progression_m"]) > 0.15:
            mismatches.append(f"{team}.progression_m: kql {kql.get(team, {}).get('progression_m')} vs python {cloud['progression_m']}")
    stage("metrics_parity", "PASS" if not mismatches else "FAIL",
          "Progression, threat and counts match (KQL vs Python, Eventhouse vs fixture)" if not mismatches else "; ".join(mismatches),
          threat={team: team_stats(events, team)["threat_gained"] for team in TEAMS})

    # 5. PPDA windows and sparse-window claims ---------------------------------------------------
    series = ppda_series(events, TEAMS)
    same_series = series == ppda_series(expected, TEAMS)
    pressing = [m for m in detect_moments(events, args.run_id, events[0]["match_id"], TEAMS) if m["rule"] == "pressing_change"]
    gated = all(w["value"] is None or w["status"] == "ok" or not any(
        m["facts"]["window"]["start_ms"] == w["start_ms"] and m["period"] == w["period"] and m["team_id"] == w["team_id"] for m in pressing)
        for w in series)
    statuses = {s: sum(w["status"] == s for w in series) for s in ("ok", "insufficient_sample", "no_defensive_actions")}
    stage("ppda_and_sparse_windows", "PASS" if same_series and gated else "FAIL",
          f"windows {statuses}; {len(pressing)} pressing claims, none from sparse windows" if gated else "pressing claim from a sparse window")

    # 6. API in azure mode --------------------------------------------------------------------
    if not args.api:
        stage("api_reads_eventhouse", "UNVERIFIED", "Pass --api http://localhost:8000 with the API running in azure mode.")
    else:
        status, ready = http("GET", f"{args.api}/ready")
        if status != 200 or ready.get("mode") != "azure":
            stage("api_reads_eventhouse", "FAIL", f"/ready returned {status}: {ready}")
        else:
            _, current = http("GET", f"{args.api}/api/v1/replay")
            status, loaded = http("POST", f"{args.api}/api/v1/replay/eventhouse",
                                  {"run_id": current["state"]["run_id"], "source_run_id": args.run_id})
            if status != 200:
                stage("api_reads_eventhouse", "FAIL", f"load returned {status}: {loaded}")
            else:
                _, end = http("POST", f"{args.api}/api/v1/replay/control", {"run_id": args.run_id, "action": "seek", "elapsed_ms": 10**10})
                ok = (end["state"]["run_id"] == args.run_id and end["replay"]["source"] == "eventhouse"
                      and end["total_events"] == len(expected)
                      and all(end["analysis"]["teams"][t] | {"pass_share_pct": None} == team_stats(events, t) | {"pass_share_pct": None} for t in TEAMS))
                stage("api_reads_eventhouse", "PASS" if ok else "FAIL",
                      f"API source={end['replay']['source']} run={end['state']['run_id']} events={end['total_events']}; {end['replay']['source_detail']}")
    stage("browser_display", "UNVERIFIED", f"Manual: open the web app, Data quality tab -> load run {args.run_id}; "
          "top bar must read 'Azure · Eventhouse' and the parity table must say match.")
    return finish(args.run_id)


def finish(run_id: str) -> int:
    out = ROOT / f"data/generated/cloud-smoke-{run_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"run_id": run_id, "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "stages": results}, indent=1, default=str), encoding="utf-8")
    print(f"Report: {out}")
    return 1 if any(r["status"] == "FAIL" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
