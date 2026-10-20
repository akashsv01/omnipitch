"""Rebuild eval_set.json: moments from seeded matches plus good and adversarial outputs.

Run from the repository root:
    .venv/Scripts/python.exe services/agents/fixtures/build_eval_set.py
The output is deterministic. Each case states whether the validator must accept it and which
error it must report, so model candidates can later be scored against the same set.
"""
import copy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
for package in ("services/simulator", "services/analytics", "services/agents"):
    sys.path.insert(0, str(ROOT / package))

from agents.narrate import build_fallback_insight  # noqa: E402
from omnipitch_analytics.detect import detect_moments  # noqa: E402
from simulator.match import AWAY, HOME, roster, simulate_match  # noqa: E402

TEAMS = [HOME["id"], AWAY["id"]]


def context(moment: dict, events: dict) -> dict:
    actors = sorted({events[i]["player_id"] for i in moment["evidence_ids"] if events[i].get("player_id")})
    return {"teams": {HOME["id"]: HOME["name"], AWAY["id"]: AWAY["name"]},
            "players": {p["player_id"]: p["name"] for p in roster()}, "home": HOME["id"], "away": AWAY["id"],
            "match_teams": TEAMS, "evidence_players": actors}


def pick(moments: list[dict], rule: str, count: int) -> list[dict]:
    return [m for m in moments if m["rule"] == rule][:count]


def main() -> None:
    selected = []
    for seed, scenario in ((7, "standard"), (21, "standard"), (21, "quiet"), (7, "high_press")):
        events = simulate_match(seed, scenario, run_id=f"eval-{seed}-{scenario}")
        by_id = {e["event_id"]: e for e in events}
        moments = detect_moments(events, f"eval-{seed}-{scenario}", "harbor-vale", TEAMS)
        for rule in ("goal", "chance", "threat_gain", "transition", "pressing_change"):
            for moment in pick(moments, rule, 1):
                selected.append((moment, context(moment, by_id)))
    outsider = next(p for p in roster() if p["team_id"] == "vale" and p["position"] == "ST")
    cases = []

    def add(case_id, moment, ctx, candidate, valid, expect=None, note=""):
        cases.append({"case_id": case_id, "note": note, "moment": moment, "context": ctx, "candidate": candidate,
                      "expected_valid": valid, "expected_error": expect})

    for index, (moment, ctx) in enumerate(selected):
        good = build_fallback_insight(moment, ctx)
        add(f"fallback-{moment['rule']}-{index}", moment, ctx, good, True, note="Deterministic template must always validate.")
    goal = next((m, c) for m, c in selected if m["rule"] == "goal")
    gain = next((m, c) for m, c in selected if m["rule"] == "threat_gain")
    press = next((m, c) for m, c in selected if m["rule"] == "pressing_change")
    trans = next((m, c) for m, c in selected if m["rule"] == "transition")

    def mutate(base, change):
        candidate = copy.deepcopy(build_fallback_insight(*base))
        candidate["generation_mode"] = "ai"
        change(candidate)
        return candidate

    adversarial = [
        ("invented-number", gain, lambda c: c.update(casual_text=c["casual_text"] + " That pass travelled 41 m."), "unsupported number"),
        ("probability-claim", gain, lambda c: c.update(casual_text="This raised the scoring probability."), "probability"),
        ("percentage-claim", gain, lambda c: c.update(analyst_text="Threat rose by 12% on this pass."), "percentage"),
        ("unknown-evidence", goal, lambda c: c.update(evidence_ids=c["evidence_ids"] + ["evt-9999"]), "unknown evidence IDs"),
        ("empty-evidence", goal, lambda c: c.update(evidence_ids=[]), "evidence_ids must be a nonempty list"),
        ("metric-mismatch", goal, lambda c: c["metrics"][0].update(value=c["metrics"][0]["value"] + 3), "disagrees with the evidence"),
        ("invented-metric", gain, lambda c: c["metrics"].append({"name": "xg", "value": 0.4, "unit": "goals"}), "not in the evidence"),
        ("speed-claim", trans, lambda c: c.update(casual_text="A lightning sprint upfield."), "speed claim"),
        ("causal-press", press, lambda c: c.update(analyst_text="The press forced the turnover."), "causal pressing claim"),
        ("bypassed-defenders", gain, lambda c: c.update(analyst_text="The pass bypassed four defenders."), "bypassed-defender"),
        ("unseen-player", gain, lambda c: c.update(casual_text=f"{outsider['name']} made the run."), "not part of the evidence"),
        ("missing-limitations", goal, lambda c: c.update(limitations=[]), "at least one limitation"),
        ("wrong-moment", goal, lambda c: c.update(moment_id="other-run:goal:v1:evt-0001"), "moment_id does not match"),
        ("extra-field", goal, lambda c: c.update(confidence=0.9), "unexpected fields"),
        ("heat-map", press, lambda c: c.update(casual_text="Their heat map shows a high line."), "heat map"),
        # Meaning errors seen on the live gate runs (2026-10-20).
        ("score-state-on-chance", next((b for b in selected if b[0]["rule"] == "chance"), gain),
         lambda c: c.update(casual_text="The keeper's save kept the score level."), "score state"),
        ("outside-the-box", next((b for b in selected if b[0]["rule"] == "chance"), gain),
         lambda c: c.update(casual_text="A good chance from outside the box."), "outside the box"),
        ("pass-count", goal, lambda c: c.update(casual_text="He finished a quick three-pass move."), "pass count"),
        ("defence-breach", goal, lambda c: c.update(analyst_text="The attack broke through Harbor's defense."),
         "defenders broken through"),
    ]
    for case_id, base, change, expected in adversarial:
        add(case_id, base[0], base[1], mutate(base, change), False, expected)
    add("valid-ai-rewrite", gain[0], gain[1],
        mutate(gain, lambda c: c.update(casual_text=f"{c['casual_text']} A promising step forward.")), True,
        note="Rewording without new facts is acceptable.")
    out = Path(__file__).with_name("eval_set.json")
    out.write_text(json.dumps({"version": "eval-v1", "cases": cases}, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} cases to {out}")


if __name__ == "__main__":
    main()
