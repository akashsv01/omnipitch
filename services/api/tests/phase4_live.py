"""Phase 4 live check: narrated Cosmos insights reach the match room through the API's validated overlay,
recaps link to verified moments, and a restarted API restores score, clock and insights.

Runs against Cosmos DB and the configured Azure OpenAI deployment. Every stage reports PASS / FAIL / UNVERIFIED.

Normal path (joint gate): publish the run (simulator.publish), the bridge creates moments and jobs, then

    .venv/Scripts/python.exe services/api/tests/phase4_live.py --run-id gate-20261020-c

Without the bridge, --seed-local creates the same moments and jobs the bridge would (same detector, create-only)
for a fresh run ID, so the narration -> overlay -> UI half can be checked on its own. The Eventhouse hop is then
UNVERIFIED for that run. Model calls are capped by --ai-jobs; the rest is drained fallback-only at no model cost.
The run's events are written to data/generated/<run>.jsonl: upload that file in the UI with
OMNIPITCH_INSIGHTS=cosmos to see the narrated insights. Report: data/generated/phase4-live-<run>.json.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
for package in ("services/api", "services/simulator", "services/analytics", "services/agents", "services/bridge"):
    sys.path.insert(0, str(ROOT / package))

from app.analysis import AWAY, HOME, narration_context  # noqa: E402
from app.config import load_env_file  # noqa: E402

results: list[dict] = []


def stage(name: str, status: str, detail: str, **evidence) -> None:
    results.append({"stage": name, "status": status, "detail": detail, **evidence})
    print(f"[{status:10}] {name}: {detail}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--scenario", default="standard")
    parser.add_argument("--ai-jobs", type=int, default=6, help="Jobs narrated with the live model (cost cap)")
    parser.add_argument("--seed-local", action="store_true", help="Create the bridge's moments/jobs locally (no Eventhouse)")
    parser.add_argument("--wait", type=int, default=600, help="Seconds to wait for bridge jobs")
    parser.add_argument("--store", choices=("cosmos", "sqlite"), default="cosmos",
                        help="sqlite = offline rehearsal in a temp folder (implies --seed-local; use --ai-jobs 0 for no model calls)")
    args = parser.parse_args()
    load_env_file()
    from agents.model import AzureOpenAIClient, AzureOpenAIConfig
    from agents.recap import build_recap
    from agents.worker import NarrationWorker
    from app.db import Database
    from app.insight_overlay import InsightOverlay
    from app.replay import ReplayStore
    from app.schemas import Event
    from omnipitch_analytics.detect import detect_moments
    from omnipitch_bridge.store import new_job
    from simulator.match import simulate_match

    if args.store == "sqlite":
        from agents.insights import SqliteInsightStore
        from omnipitch_bridge.store import SqliteStore
        scratch = Path(tempfile.mkdtemp(prefix="phase4-rehearsal-"))
        store, insights = SqliteStore(scratch / "bridge.sqlite3"), SqliteInsightStore(scratch / "narration.sqlite3")
        args.seed_local = True
    else:
        endpoint, database = os.environ["COSMOS_ENDPOINT"], os.getenv("COSMOS_DATABASE", "omnipitch")
        from agents.insights import CosmosInsightStore
        from omnipitch_bridge.cosmos_store import CosmosStore
        store = CosmosStore(endpoint, database)
        insights = CosmosInsightStore(endpoint, database, client=store.client)
    events = simulate_match(args.seed, args.scenario, run_id=args.run_id)
    events_file = ROOT / f"data/generated/{args.run_id}.jsonl"
    events_file.parent.mkdir(parents=True, exist_ok=True)
    events_file.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")

    # 1. Moments and jobs: from the bridge, or created locally exactly as the bridge would.
    if args.seed_local:
        now = datetime.now(timezone.utc)
        created = 0
        for moment in detect_moments(events, args.run_id, events[0]["match_id"], [HOME["id"], AWAY["id"]]):
            created += store.create_moment(moment, now)
            store.create_job(new_job(moment, now))
        stage("eventhouse_bridge", "UNVERIFIED", f"--seed-local: {created} moments and jobs created locally with the bridge's detector; Eventhouse not used")
    else:
        deadline = time.time() + args.wait
        while not store.jobs(args.run_id) and time.time() < deadline:
            print("  waiting for bridge jobs ...", flush=True)
            time.sleep(30)
    jobs = store.jobs(args.run_id)
    if not jobs:
        stage("bridge_jobs", "UNVERIFIED", f"No jobs for {args.run_id}; run the bridge on the Eventhouse side or use --seed-local.")
        return finish(args.run_id)
    stage("jobs", "PASS", f"{len(jobs)} jobs, {len(store.moments(args.run_id))} moments", statuses=dict(Counter(j["status"] for j in jobs)))

    # 2. Narrate: live model on a capped number of jobs (prompts v3), the rest fallback-only.
    config = AzureOpenAIConfig.from_env()
    context_for = lambda moment: narration_context([])  # noqa: E731
    def worker(client, owner, reason="no model configured"):
        return NarrationWorker(store, insights, client, owner, context_for, run_id=args.run_id, no_model_reason=reason)
    if config is None or args.ai_jobs <= 0:
        stage("live_ai_insight", "UNVERIFIED", "no model calls (--ai-jobs 0 or AZURE_OPENAI_* not set)")
    else:
        ai = worker(AzureOpenAIClient(config), "phase4-ai").drain(args.ai_jobs)
        ready = [r for r in ai if r["status"] == "ready"]
        stage("live_ai_insight", "PASS" if ready else "FAIL", f"{len(ready)} of {len(ai)} model-narrated jobs published validated AI insights",
              outcomes=[{k: r[k] for k in ("job_id", "status", "error")} for r in ai])
    rest = worker(None, "phase4-fallback", "phase 4 live check cost cap: narrated without the model").drain()
    print(f"  {len(rest)} remaining jobs narrated fallback-only", flush=True)
    records = insights.insights(args.run_id)

    # 3. The API's overlay shows them: every stored insight re-validates against the API's own moment.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:  # Windows keeps SQLite files open.
        db_path = str(Path(tmp) / "replay.sqlite3")
        now = [0.0]
        overlay = InsightOverlay(insights.insights, "cosmos", ttl_s=0)
        source = [Event.model_validate(e) for e in events]
        replay = ReplayStore(clock=lambda: now[0], db=Database(db_path), source=source[:5], overlay=overlay)
        replay.load(events_file.read_text(encoding="utf-8"), replay.state.run_id)  # The UI's upload path.
        replay.control("seek", replay.state.run_id, elapsed_ms=replay.schedule[-1])
        snap = replay.snapshot()
        status = snap.insights
        ai_records = sum(r["insight"]["generation_mode"] == "ai" for r in records)
        ok = status.status == "ok" and status.narrated == len(records) and status.rejected == 0 and status.ai == ai_records
        stage("overlay_shows_insights", "PASS" if ok else "FAIL",
              f"stored {len(records)} ({ai_records} ai); overlay narrated {status.narrated}, ai {status.ai}, rejected {status.rejected}, status {status.status}",
              error=status.error)

        # 4. Recaps link to verified moments and carry the narrated headlines.
        rev, moments = replay.recap_inputs()
        by_id = {m["moment_id"]: m for m in moments}
        recap_ok, notes = True, []
        for scope in ("first_half", "full_time"):
            recap = build_recap(rev, moments, scope, narration_context([]), HOME["id"], AWAY["id"])
            linked = recap and all(k["moment_id"] in by_id and k["headline"] == by_id[k["moment_id"]]["insight"]["headline"]
                                   for k in recap["key_moments"])
            recap_ok &= bool(linked and recap["status"] == "final")
            if recap:
                notes.append(f"{scope}: {recap['headline']} ({len(recap['key_moments'])} key moments, "
                             f"{sum(k['generation_mode'] == 'ai' for k in recap['key_moments'])} ai)")
        stage("recaps_link_verified_moments", "PASS" if recap_ok else "FAIL", "; ".join(notes))

        # 5. Restarted API: same score, clock and insights.
        before = snap
        restarted = ReplayStore(clock=lambda: now[0], db=Database(db_path), overlay=InsightOverlay(insights.insights, "cosmos", ttl_s=0))
        after = restarted.snapshot()
        same = (restarted.restored and after.state.score == before.state.score
                and (after.replay.clock_period, after.replay.clock_ms) == (before.replay.clock_period, before.replay.clock_ms)
                and after.insights.version == before.insights.version
                and [(m.moment_id, m.insight.headline) for m in after.moments] == [(m.moment_id, m.insight.headline) for m in before.moments])
        stage("restart_restores_state_and_insights", "PASS" if same else "FAIL",
              f"score {after.state.score.home}-{after.state.score.away}, clock P{after.replay.clock_period} {after.replay.clock_ms} ms, insights version {after.insights.version}")
    print(f"Events for the UI upload: {events_file}")
    return finish(args.run_id)


def finish(run_id: str) -> int:
    out = ROOT / f"data/generated/phase4-live-{run_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"run_id": run_id, "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "stages": results}, indent=1, default=str), encoding="utf-8")
    print(f"Report: {out}")
    return 1 if any(r["status"] == "FAIL" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
