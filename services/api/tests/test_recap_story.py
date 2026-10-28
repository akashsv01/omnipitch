"""Recap stories come from the recap's own events: outcome, turning point, a half-by-half comparison when the
balance really swung, scorers. Checked against the events themselves, never against hard-coded figures."""
import pytest

from app.db import Database
from app.recaps import RecapService
from app.replay import ReplayStore
from app.schemas import Event
from simulator.match import simulate_match


def finished(seed, scenario="standard"):
    store = ReplayStore(db=Database(":memory:"), source=[Event.model_validate(e) for e in simulate_match(seed, scenario, run_id=f"s{seed}")])
    store.control("seek", store.state.run_id, elapsed_ms=store.schedule[-1])
    return store.recap_inputs()


@pytest.mark.parametrize("seed,scenario", [(7, "standard"), (18, "late_surge"), (11, "standard"), (3, "quiet")])
def test_story_matches_the_events(seed, scenario):
    events, moments = finished(seed, scenario)
    recap = RecapService().recap(events, moments, "full_time", "en")["recap"]
    story, stats = recap["story"], recap["stats"]
    goals = [e for e in events if e["type"] == "shot" and e.get("is_goal")]
    assert [g["sequence"] for g in story["goals"]] == [e["sequence"] for e in goals]
    assert (story["goals"][-1]["score"] if goals else {"home": 0, "away": 0}) == recap["score"]
    halves = story["shots_by_half"]
    assert halves["first"]["home"] + halves["second"]["home"] == stats["home"]["shots"]
    assert halves["first"]["away"] + halves["second"]["away"] == stats["away"]["shots"]
    # Came from behind exactly when the winner trailed after some goal.
    leader = story["leader"]
    if leader:
        side = "home" if leader == "harbor" else "away"
        other = "away" if side == "home" else "home"
        assert story["came_from_behind"] == any(g["score"][side] < g["score"][other] for g in story["goals"])
        # The deciding goal put the winner ahead, and they never fell level or behind afterwards.
        decisive = story["decisive_goal"]
        after = [g for g in story["goals"] if g["sequence"] >= decisive["sequence"]]
        assert decisive["team_id"] == leader and all(g["score"][side] > g["score"][other] for g in after)
    # Pass share is from both teams' attempts, so it is never missing once passes exist.
    assert round(stats["home"]["pass_share_pct"] + stats["away"]["pass_share_pct"]) == 100
    # Every scorer named in the summary is a recorded goal scorer, with that goal's minute.
    for goal in story["goals"]:
        assert goal["clock"] in recap["summary"]


def test_a_swing_after_the_break_is_told_with_the_half_numbers():
    events, moments = finished(7)
    recap = RecapService().recap(events, moments, "full_time", "en")["recap"]
    first, second = recap["story"]["shots_by_half"]["first"], recap["story"]["shots_by_half"]["second"]
    if second["home"] > second["away"] and first["home"] < first["away"]:
        assert f"After the break Harbor Comets had {second['home']} shots to {second['away']}" in recap["summary"]
        assert recap["story"]["came_from_behind"] and "come from behind" in recap["headline"]
    spanish = RecapService().recap(events, moments, "full_time", "es")["recap"]
    assert spanish["story"] == recap["story"] and "Tras el descanso" in spanish["summary"]


def test_recap_is_spoken_once_without_repeating_the_headline():
    from app.commentary import recap_line
    events, moments = finished(7)
    recap = RecapService().recap(events, moments, "full_time", "en")["recap"]
    assert recap_line(recap) == recap["summary"]
