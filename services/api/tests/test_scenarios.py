"""Seeded scenarios are reproducible and internally consistent; late_surge seed 18 is the documented comeback."""
import pytest

from omnipitch_analytics.metrics import team_stats
from simulator.match import SCENARIOS, simulate_match


def running_scores(events):
    score, trace = {"harbor": 0, "vale": 0}, []
    for event in events:
        if event["type"] == "shot" and event["is_goal"]:
            score[event["team_id"]] += 1
            trace.append((event["period"], dict(score)))
    return score, trace


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_scenarios_are_reproducible_and_consistent(scenario):
    events = simulate_match(11, scenario, run_id="scenario-test")
    assert events == simulate_match(11, scenario, run_id="scenario-test")  # Same seed, same match.
    assert [e["sequence"] for e in events] == list(range(1, len(events) + 1))
    for before, after in zip(events, events[1:]):  # Chronology within and across periods.
        assert (after["period"], after["match_time_ms"]) >= (before["period"], before["match_time_ms"])
    markers = [(e["type"], e["period"]) for e in events if e["type"].startswith("period_")]
    assert markers == [("period_start", 1), ("period_end", 1), ("period_start", 2), ("period_end", 2)]
    for event in events:
        if event["type"] == "shot":
            assert event["is_goal"] <= event["on_target"]  # A goal is always on target.
        if event.get("team_id"):
            # Each team attacks one way per half and swaps at half-time.
            expected = ("positive_x" if event["team_id"] == "harbor" else "negative_x") if event["period"] == 1 else \
                       ("negative_x" if event["team_id"] == "harbor" else "positive_x")
            assert event["attacking_direction"] == expected
    score, _ = running_scores(events)
    assert score == {team: team_stats(events, team)["goals"] for team in ("harbor", "vale")}  # Reconciles with stats.


def test_late_surge_seed_18_is_a_comeback():
    events = simulate_match(18, "late_surge", run_id="comeback")
    final, trace = running_scores(events)
    assert any(score["vale"] < score["harbor"] for _, score in trace)  # Vale trail at some point...
    assert final["vale"] > final["harbor"]                             # ...and win.
    late = [e for e in events if e["period"] == 2 and e["match_time_ms"] >= 15 * 60000]
    vale_shots = sum(e["type"] == "shot" and e["team_id"] == "vale" for e in late)
    harbor_shots = sum(e["type"] == "shot" and e["team_id"] == "harbor" for e in late)
    assert vale_shots > harbor_shots


def test_existing_scenarios_are_unchanged_by_the_new_one():
    # The standard seed-7 match every fixture and gate run was built from.
    events = simulate_match(7, "standard", run_id="demo-run-001")
    assert len(events) == 1206
    assert [e["sequence"] for e in events if e["type"] == "period_end"] == [618, 1206]
