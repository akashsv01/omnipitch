"""Regression: template explanations follow the evidence (walkthrough review, 2026-10-25).

A 3.7 m advance ending in a shot was described as moving "a long way forward"; goals all read the same.
The fallback text now branches on the transition trigger and on what the goal did to the score, and every
variant still passes the insight validator."""
import pytest

from agents.narrate import build_fallback_insight, goal_context, transition_branch
from agents.validation import validate_insight
from app.analysis import narration_context

CONTEXT = {"teams": {"harbor": "Harbor Comets", "vale": "Vale Owls"}, "players": {"p1": "Remy Lachance"},
           "home": "harbor", "away": "vale"}


def moment(rule, metrics, facts, team="vale"):
    return {"moment_id": f"run:{rule}:v1:evt-0001", "run_id": "run", "match_id": "m", "rule": rule, "rule_version": "v1",
            "metric_version": "metrics-v1", "priority": 2, "team_id": team, "player_id": "p1", "period": 1,
            "match_time_ms": 24 * 60000, "anchor_sequence": 1, "source_sequence": 3, "evidence_ids": ["evt-0001", "evt-0002"],
            "metrics": [{"name": n, "value": v, "unit": u} for n, v, u in metrics], "facts": facts, "limitations": []}


def transition(progress, ended_in_shot, elapsed=6.5):
    return moment("transition", [("forward_progress", progress, "m"), ("elapsed", elapsed, "s"), ("actions", 3, "events")],
                  {"turnover_type": "interception", "ended_in_shot": ended_in_shot})


def test_short_advance_ending_in_a_shot_uses_the_shot_branch():
    m = transition(3.7, True)
    assert transition_branch(m) == "shot"
    insight = build_fallback_insight(m, CONTEXT)
    text = insight["casual_text"] + " " + insight["analyst_text"]
    assert "shot away 6.5 seconds later" in insight["casual_text"]
    assert "long way" not in text and "upfield" not in text
    assert "3.7 m of forward progress" in insight["analyst_text"]   # disclosed, not emphasised
    assert validate_insight(insight, m, CONTEXT) == []


def test_long_advance_without_a_shot_never_implies_a_shot():
    m = transition(42.2, False, 4.8)
    assert transition_branch(m) == "progress"
    insight = build_fallback_insight(m, CONTEXT)
    assert "42.2 m forward" in insight["casual_text"]
    assert "does not end in a shot" in insight["casual_text"]
    assert "ends without a shot" in insight["analyst_text"]
    assert "shot away" not in insight["casual_text"]
    assert validate_insight(insight, m, CONTEXT) == []


def test_long_advance_ending_in_a_shot_states_both_triggers():
    m = transition(38.0, True, 9.1)
    assert transition_branch(m) == "both"
    insight = build_fallback_insight(m, CONTEXT)
    assert "38 m forward" in insight["casual_text"] and "shot away within 9.1 seconds" in insight["casual_text"]
    assert validate_insight(insight, m, CONTEXT) == []


@pytest.mark.parametrize("score, team, kind, headline", [
    ({"harbor": 0, "vale": 1}, "vale", "opening", "Vale Owls open the scoring"),
    ({"harbor": 1, "vale": 1}, "vale", "equaliser", "Vale Owls equalise"),
    ({"harbor": 1, "vale": 2}, "vale", "lead", "Vale Owls go ahead"),
    ({"harbor": 0, "vale": 2}, "vale", "extend", "Vale Owls extend the lead"),
    ({"harbor": 1, "vale": 3}, "harbor", "reduce", "Harbor Comets pull a goal back"),
])
def test_goal_wording_follows_the_verified_score_before_and_after(score, team, kind, headline):
    m = moment("goal", [("shot_distance", 10.6, "m"), ("possession_actions", 3, "events")], {"score": score, "outcome": "goal"}, team)
    assert goal_context(m) == kind
    insight = build_fallback_insight(m, CONTEXT)
    assert insight["headline"] == headline
    assert validate_insight(insight, m, CONTEXT) == []


def test_goal_without_score_facts_stays_neutral():
    m = moment("goal", [("shot_distance", 10.6, "m"), ("possession_actions", 3, "events")], {"outcome": "goal", "score": {}})
    assert goal_context(m) is None


def test_context_helper_is_unchanged():
    assert narration_context([])["teams"]


def test_headlines_follow_the_evidence_instead_of_repeating():
    shot = build_fallback_insight(transition(3.7, True), CONTEXT)["headline"]
    long_run = build_fallback_insight(transition(42.2, False), CONTEXT)["headline"]
    both = build_fallback_insight(transition(38.0, True), CONTEXT)["headline"]
    assert len({shot, long_run, both}) == 3
    box = moment("threat_gain", [("threat_delta", 0.21, "illustrative threat"), ("forward_progress", 20.0, "m"), ("pass_distance", 27.05, "m")],
                 {"start_value": 0.04, "end_value": 0.25, "grid_version": "illustrative-threat-v1", "box_entry": True, "final_third_entry": True})
    insight = build_fallback_insight(box, CONTEXT)
    assert insight["headline"] == "Vale Owls pass into the box"
    assert "27.1 m long" in insight["analyst_text"]          # one decimal everywhere, never 27.05 in prose
    assert validate_insight(insight, box, CONTEXT) == []


def test_pressing_wording_states_the_measure_not_a_tactic():
    m = moment("pressing_change", [("ppda", 4.2, "passes per defensive action"), ("previous_ppda", 9.0, "passes per defensive action"),
                                   ("opponent_passes", 21, "passes"), ("defensive_actions", 5, "actions")],
               {"window": {"start_ms": 600000, "end_ms": 900000}, "previous_window": {}, "zone": "x > 42 m", "window_ms": 300000})
    insight = build_fallback_insight(m, CONTEXT)
    assert "press higher" not in insight["headline"] and "fewer passes per defensive action" in insight["headline"]


def test_unsupported_adjectives_are_rejected():
    from agents.semantics import semantic_errors
    m = transition(3.7, True)
    assert any("unsupported judgement" in e for e in semantic_errors("A stunning counter from Vale Owls.", m))
    assert not semantic_errors("Vale Owls get a shot away 6.5 seconds later.", m)


def test_sideways_threat_gain_never_says_zero_metres_forward():
    from agents.narrate_es import story_es
    m = moment("threat_gain", [("forward_progress", 0.2, "m"), ("pass_distance", 9.0, "m"), ("threat_delta", 0.12, "illustrative")],
               {"box_entry": False, "final_third_entry": False, "start_value": 0.1, "end_value": 0.22, "grid_version": "g"})
    assert " 0 m" not in build_fallback_insight(m, CONTEXT)["casual_text"] and "across" in build_fallback_insight(m, CONTEXT)["casual_text"]
    assert "horizontal" in story_es(m, CONTEXT)["casual_text"]
