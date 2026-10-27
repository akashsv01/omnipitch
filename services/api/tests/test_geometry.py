"""Distances are metres in one global frame; distinct measures are never interchanged (ARCHITECTURE: Metrics)."""
import math

from omnipitch_analytics.metrics import forward_progress_m, from_percent, pass_difficulty, pass_distance_m, shot_distance_m

PASS = {"type": "pass", "outcome": "completed", "start": {"x": 36, "y": 47}, "end": {"x": 60, "y": 28}}


def test_illustrative_fixture_in_metres():
    assert pass_distance_m(PASS) == 30.61
    assert forward_progress_m({**PASS, "attacking_direction": "positive_x"}) == 24
    # The same pass by a team attacking -x moves the ball 24 m towards its own goal.
    assert forward_progress_m({**PASS, "attacking_direction": "negative_x"}) == -24


def test_percentages_are_converted_before_distances():
    start, end = from_percent(PASS["start"]), from_percent(PASS["end"])
    assert round(math.hypot(end["x"] - start["x"], end["y"] - start["y"]), 1) == 28.3
    assert round(pass_distance_m({"start": start, "end": end}), 1) == 28.3


def test_shot_distance_mirrors_by_attacking_direction():
    right = {"start": {"x": 90, "y": 30}, "attacking_direction": "positive_x"}
    left = {"start": {"x": 15, "y": 38}, "attacking_direction": "negative_x"}
    assert shot_distance_m(right) == shot_distance_m(left) == round(math.hypot(15, 4), 1)


def test_pass_difficulty_is_explainable_and_bounded():
    # Same fixtures as check-pitch.mjs (passDifficulty): 30.6 m diagonal forward, a short square pass, a long ball into the box.
    diagonal = pass_difficulty({**PASS, "attacking_direction": "positive_x"})
    assert diagonal == {"score": 62, "band": "difficult", "parts": {"length": 30.6, "forward": 20.0, "destination": 0.0, "width": 11.4}}
    square = pass_difficulty({"type": "pass", "start": {"x": 40, "y": 30}, "end": {"x": 41, "y": 36}, "attacking_direction": "positive_x"})
    assert square["band"] == "routine" and square["score"] == 11
    into_box = pass_difficulty({"type": "pass", "start": {"x": 60, "y": 34}, "end": {"x": 95, "y": 30}, "attacking_direction": "positive_x"})
    assert into_box["score"] == 83 and into_box["parts"]["destination"] == 20
    mirrored = pass_difficulty({"type": "pass", "start": {"x": 45, "y": 34}, "end": {"x": 10, "y": 38}, "attacking_direction": "negative_x"})
    assert mirrored == into_box  # the same pass by the team attacking the other way
    assert pass_difficulty({"type": "shot", "start": {"x": 1, "y": 1}}) is None
