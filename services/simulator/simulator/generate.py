"""Generate reproducible synthetic events: a full state-machine match or a short pass fixture."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import random

from .match import SCENARIOS, simulate_match

BASELINE = "2026-01-01T12:00:00Z"
DEMO_RUN_ID = "demo-run-001"
MATCH_ID = "demo"
PLAYERS = ("harbor-01", "harbor-02", "harbor-03", "harbor-04")


def generate_events(seed: int = 7, run_id: str = DEMO_RUN_ID, count: int = 5,
                    baseline: str = BASELINE) -> list[dict]:
    if not run_id.strip():
        raise ValueError("run_id must be nonempty")
    if not 1 <= count <= 1000:
        raise ValueError("count must be between 1 and 1000")
    clock = datetime.fromisoformat(baseline.replace("Z", "+00:00"))
    if clock.tzinfo is None or clock.utcoffset() != timedelta(0):
        raise ValueError("baseline must have an explicit UTC timezone")
    rng = random.Random(seed)
    start = {"x": 35.0, "y": 34.0}
    events = []
    for index in range(count):
        end = {"x": round(min(105.0, max(0.0, start["x"] + rng.uniform(-4, 12))), 2),
               "y": round(min(68.0, max(0.0, start["y"] + rng.uniform(-10, 10))), 2)}
        events.append({
            "schema_version": "1.1", "run_id": run_id, "match_id": MATCH_ID,
            "event_id": f"pass-{index + 1:04d}", "sequence": index + 1,
            "period": 1, "match_time_ms": (index + 1) * 3000,
            "emitted_at": (clock + timedelta(seconds=(index + 1) * 3)).isoformat().replace("+00:00", "Z"),
            "team_id": "harbor", "player_id": PLAYERS[index % len(PLAYERS)],
            "possession_id": "possession-001", "type": "pass", "outcome": "completed",
            "start": start.copy(), "end": end.copy(), "attacking_direction": "positive_x",
            "on_target": None, "is_goal": None, "synthetic": True,
        })
        start = end
    return events


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--mode", choices=("match", "passes"), default="match",
                        help="match: full two-period simulation; passes: short completed-pass fixture")
    parser.add_argument("--scenario", choices=SCENARIOS, default="standard")
    parser.add_argument("--count", type=int, default=5, help="Pass count for --mode passes")
    parser.add_argument("--baseline", default=BASELINE, help="Fixed UTC timestamp baseline")
    args = parser.parse_args()
    try:
        if args.mode == "match":
            events = simulate_match(args.seed, args.scenario, args.run_id, baseline=args.baseline)
        else:
            events = generate_events(args.seed, args.run_id, args.count, args.baseline)
    except ValueError as exc:
        parser.error(str(exc))
    from jsonschema import Draft202012Validator, FormatChecker
    schema_path = Path(__file__).resolve().parents[3] / "contracts/schemas/event.schema.json"
    validator = Draft202012Validator(json.loads(schema_path.read_text(encoding="utf-8")),
                                    format_checker=FormatChecker())
    for event in events:
        validator.validate(event)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(event, sort_keys=True) + "\n" for event in events), encoding="utf-8")
    print(f"Wrote {len(events)} validated synthetic events to {args.output}")


if __name__ == "__main__":
    main()
