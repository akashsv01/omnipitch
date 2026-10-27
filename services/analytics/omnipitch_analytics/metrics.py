"""Deterministic match metrics over validated, deduplicated events.

All functions take plain event dictionaries in the global 105 x 68 frame and convert to a
team-relative attacking frame where a metric needs it. No database, network or model calls.
"""
from __future__ import annotations

from functools import lru_cache
import json
import math
from pathlib import Path

PITCH_LENGTH = 105.0
PITCH_WIDTH = 68.0
METRIC_VERSION = "metrics-v1"
FINAL_THIRD_X = 70.0
BOX_X = 88.5
BOX_Y = (13.84, 54.16)
PPDA_ZONE_X = 42.0  # Beyond40 on a 0-100 frame, scaled to a 105 m pitch.
PPDA_WINDOW_MS = 5 * 60 * 1000
PPDA_MIN_PASSES = 10
PPDA_MIN_ACTIONS = 3
DEFENSIVE_TYPES = ("tackle", "interception", "challenge", "foul")
GRID_PATH = Path(__file__).resolve().parents[3] / "analytics/threat-grid-v1.json"


@lru_cache(maxsize=1)
def threat_grid() -> dict:
    return json.loads(GRID_PATH.read_text(encoding="utf-8"))


def normalize(point: dict, direction: str) -> dict:
    """Team-relative frame: the team attacks towards x = 105."""
    if not 0 <= point["x"] <= PITCH_LENGTH or not 0 <= point["y"] <= PITCH_WIDTH:
        raise ValueError("point outside the 105 x 68 pitch")
    if direction == "positive_x":
        return {"x": point["x"], "y": point["y"]}
    if direction == "negative_x":
        return {"x": PITCH_LENGTH - point["x"], "y": PITCH_WIDTH - point["y"]}
    raise ValueError(f"unknown attacking direction {direction!r}")


def opposite(direction: str) -> str:
    return "negative_x" if direction == "positive_x" else "positive_x"


def grid_cell(point: dict) -> tuple[int, int]:
    grid = threat_grid()
    if not 0 <= point["x"] <= PITCH_LENGTH or not 0 <= point["y"] <= PITCH_WIDTH:
        raise ValueError("point outside the 105 x 68 pitch")
    cx = min(grid["columns"] - 1, math.floor(point["x"] / PITCH_LENGTH * grid["columns"]))
    cy = min(grid["rows"] - 1, math.floor(point["y"] / PITCH_WIDTH * grid["rows"]))
    return cx, cy


def threat_value(point: dict) -> float:
    cx, cy = grid_cell(point)
    return threat_grid()["values"][cy][cx]


def from_percent(point: dict) -> dict:
    """Provider coordinates given as 0-100 percentages of the pitch, converted to metres before any distance."""
    return {"x": point["x"] / 100 * PITCH_LENGTH, "y": point["y"] / 100 * PITCH_WIDTH}


def pass_distance_m(event: dict) -> float:
    return round(math.hypot(event["end"]["x"] - event["start"]["x"], event["end"]["y"] - event["start"]["y"]), 2)


def forward_progress_m(event: dict) -> float:
    start = normalize(event["start"], event["attacking_direction"])
    end = normalize(event["end"], event["attacking_direction"])
    return round(end["x"] - start["x"], 2)


def pass_difficulty(event: dict) -> dict | None:
    """Explainable pass difficulty indicator, 0-100. A heuristic from recorded inputs only, NOT a completion
    probability: no defender positions or pressure exist in this data. Components (points):
    length up to 40 (40 m or longer = 40), forward gain up to 25 (30 m or more), destination 20 inside the box or
    10 in the final third, and width up to 15 (a 25 m or wider switch). Bands: under 35 routine, 35-59 moderate,
    60+ difficult. Mirrored in apps/web/src/lib/geometry.ts (passDifficulty)."""
    if event["type"] != "pass" or not event.get("start") or not event.get("end") or not event.get("attacking_direction"):
        return None
    start = normalize(event["start"], event["attacking_direction"])
    end = normalize(event["end"], event["attacking_direction"])
    length = math.hypot(end["x"] - start["x"], end["y"] - start["y"])
    parts = {"length": min(1.0, length / 40) * 40, "forward": min(1.0, max(0.0, end["x"] - start["x"]) / 30) * 25,
             "destination": 20.0 if in_box(end) else 10.0 if end["x"] >= FINAL_THIRD_X else 0.0,
             "width": min(1.0, abs(end["y"] - start["y"]) / 25) * 15}
    score = round(sum(parts.values()))
    return {"score": score, "band": "difficult" if score >= 60 else "moderate" if score >= 35 else "routine",
            "parts": {k: round(v, 1) for k, v in parts.items()}}


def threat_delta(event: dict) -> dict | None:
    """Illustrative threat change for a completed pass only; None for any other action."""
    if event["type"] != "pass" or event["outcome"] != "completed":
        return None
    start = normalize(event["start"], event["attacking_direction"])
    end = normalize(event["end"], event["attacking_direction"])
    start_value, end_value = threat_value(start), threat_value(end)
    return {"start_cell": list(grid_cell(start)), "end_cell": list(grid_cell(end)),
            "start_value": start_value, "end_value": end_value,
            "delta": round(end_value - start_value, 3), "grid_version": threat_grid()["grid_version"]}


def in_box(point: dict) -> bool:
    return point["x"] >= BOX_X and BOX_Y[0] <= point["y"] <= BOX_Y[1]


def final_third_entry(event: dict) -> bool:
    if event["type"] != "pass" or event["outcome"] != "completed":
        return False
    start = normalize(event["start"], event["attacking_direction"])
    end = normalize(event["end"], event["attacking_direction"])
    return start["x"] < FINAL_THIRD_X <= end["x"]


def box_entry(event: dict) -> bool:
    if event["type"] != "pass" or event["outcome"] != "completed":
        return False
    start = normalize(event["start"], event["attacking_direction"])
    end = normalize(event["end"], event["attacking_direction"])
    return not in_box(start) and in_box(end)


def shot_distance_m(event: dict) -> float:
    start = normalize(event["start"], event["attacking_direction"])
    return round(math.hypot(PITCH_LENGTH - start["x"], PITCH_WIDTH / 2 - start["y"]), 1)


def team_directions(events: list[dict]) -> dict[tuple[str, int], str]:
    """Attack direction by (team, period), taken from recorded events."""
    directions: dict[tuple[str, int], str] = {}
    for event in events:
        if event.get("team_id") and event.get("attacking_direction"):
            directions.setdefault((event["team_id"], event["period"]), event["attacking_direction"])
    return directions


def ppda(events: list[dict], defending_team: str, period: int, start_ms: int, end_ms: int,
         directions: dict | None = None) -> dict:
    """PPDA(team, window) = opponent pass attempts in zone / defensive actions in zone.

    Both counts use the defending team's attacking frame; zone is x > 42 m. Window is
    [start_ms, end_ms) of period-local match time. Zero actions returns null plus a reason.
    """
    directions = directions or team_directions(events)
    defending_direction = directions.get((defending_team, period))
    passes = actions = 0
    evidence: list[str] = []
    if defending_direction is None:
        for (team, team_period), direction in directions.items():
            if team != defending_team and team_period == period:
                defending_direction = opposite(direction)
    for event in events:
        if event["period"] != period or not start_ms <= event["match_time_ms"] < end_ms or not event.get("start"):
            continue
        if defending_direction is None:
            break
        zone_x = normalize(event["start"], defending_direction)["x"]
        if zone_x <= PPDA_ZONE_X:
            continue
        if event["type"] == "pass" and event["team_id"] != defending_team:
            passes += 1
            evidence.append(event["event_id"])
        elif event["type"] in DEFENSIVE_TYPES and event["team_id"] == defending_team:
            actions += 1
            evidence.append(event["event_id"])
    result = {"team_id": defending_team, "period": period, "start_ms": start_ms, "end_ms": end_ms,
              "opponent_passes": passes, "defensive_actions": actions, "value": None,
              "status": "ok", "reason": None, "zone": "x > 42 m in the defending team's attacking frame",
              "metric_version": METRIC_VERSION, "evidence_ids": evidence}
    if actions == 0:
        result.update(status="no_defensive_actions", reason="No defensive actions in zone; PPDA is undefined.")
        return result
    result["value"] = round(passes / actions, 2)
    if passes < PPDA_MIN_PASSES or actions < PPDA_MIN_ACTIONS:
        result.update(status="insufficient_sample",
                      reason=f"Needs at least {PPDA_MIN_PASSES} opponent passes and {PPDA_MIN_ACTIONS} defensive actions.")
    return result


def ppda_series(events: list[dict], teams: list[str]) -> list[dict]:
    """Nonoverlapping 5-minute windows per team and period; never crosses halftime."""
    directions = team_directions(events)
    series = []
    for period in (1, 2):
        period_events = [event for event in events if event["period"] == period]
        if not period_events:
            continue
        last_ms = period_events[-1]["match_time_ms"]
        closed = any(event["type"] == "period_end" for event in period_events)
        window_start = 0
        while window_start <= last_ms:
            window_end = window_start + PPDA_WINDOW_MS
            is_closed = closed or last_ms >= window_end
            for team in teams:
                entry = ppda(period_events, team, period, window_start, window_end, directions)
                entry["closed"] = is_closed
                series.append(entry)
            window_start = window_end
    return series


def team_stats(events: list[dict], team: str) -> dict:
    stats = {"team_id": team, "passes_attempted": 0, "passes_completed": 0, "completion_pct": None,
             "progression_m": 0.0, "final_third_entries": 0, "box_entries": 0, "shots": 0,
             "shots_on_target": 0, "goals": 0, "threat_gained": 0.0, "defensive_actions": 0,
             "turnovers_won": 0, "fouls": 0, "pass_share_pct": None}
    for event in events:
        if event.get("team_id") != team:
            continue
        kind = event["type"]
        if kind == "pass":
            stats["passes_attempted"] += 1
            if event["outcome"] == "completed":
                stats["passes_completed"] += 1
                stats["progression_m"] += max(0.0, forward_progress_m(event))
                stats["threat_gained"] += threat_delta(event)["delta"]
                stats["final_third_entries"] += final_third_entry(event)
                stats["box_entries"] += box_entry(event)
        elif kind == "shot":
            stats["shots"] += 1
            stats["shots_on_target"] += bool(event["on_target"])
            stats["goals"] += bool(event["is_goal"])
        elif kind in DEFENSIVE_TYPES:
            stats["defensive_actions"] += 1
            stats["fouls"] += kind == "foul"
            stats["turnovers_won"] += kind in ("tackle", "interception") and event["outcome"] == "won"
    if stats["passes_attempted"]:
        stats["completion_pct"] = round(100 * stats["passes_completed"] / stats["passes_attempted"], 1)
    stats["progression_m"] = round(stats["progression_m"], 1)
    stats["threat_gained"] = round(stats["threat_gained"], 3)
    return stats


def player_stats(events: list[dict]) -> list[dict]:
    players: dict[str, dict] = {}
    for event in events:
        player = event.get("player_id")
        if not player:
            continue
        row = players.setdefault(player, {
            "player_id": player, "team_id": event["team_id"], "passes": 0, "passes_completed": 0,
            "progression_m": 0.0, "threat_gained": 0.0, "shots": 0, "goals": 0, "defensive_actions": 0,
            "actions": 0, "sum_x": 0.0, "sum_y": 0.0,
        })
        row["actions"] += 1
        # Average in the team's attacking frame so halves with swapped ends do not cancel out.
        location = normalize(event["start"], event["attacking_direction"])
        row["sum_x"] += location["x"]
        row["sum_y"] += location["y"]
        if event["type"] == "pass":
            row["passes"] += 1
            if event["outcome"] == "completed":
                row["passes_completed"] += 1
                row["progression_m"] += max(0.0, forward_progress_m(event))
                row["threat_gained"] += threat_delta(event)["delta"]
        elif event["type"] == "shot":
            row["shots"] += 1
            row["goals"] += bool(event["is_goal"])
        elif event["type"] in DEFENSIVE_TYPES:
            row["defensive_actions"] += 1
    result = []
    for row in players.values():
        actions = row.pop("actions")
        sum_x, sum_y = row.pop("sum_x"), row.pop("sum_y")
        row["action_count"] = actions
        row["progression_m"] = round(row["progression_m"], 1)
        row["threat_gained"] = round(row["threat_gained"], 3)
        row["mean_action_location"] = {"x": round(sum_x / actions, 1), "y": round(sum_y / actions, 1)}
        result.append(row)
    return sorted(result, key=lambda row: (-row["threat_gained"], row["player_id"]))


def momentum(events: list[dict], teams: list[str], bucket_ms: int = PPDA_WINDOW_MS) -> list[dict]:
    """Positive illustrative threat added by completed passes per 5-minute bucket."""
    buckets: dict[tuple[int, int], dict] = {}
    for event in events:
        if event["type"] in ("period_start", "period_end"):
            key = (event["period"], event["match_time_ms"] // bucket_ms)
            if event["type"] == "period_start":
                buckets.setdefault(key, {"period": key[0], "start_ms": key[1] * bucket_ms, **{team: 0.0 for team in teams}, "shots": {team: 0 for team in teams}})
            continue
        key = (event["period"], event["match_time_ms"] // bucket_ms)
        bucket = buckets.setdefault(key, {"period": key[0], "start_ms": key[1] * bucket_ms,
                                          **{team: 0.0 for team in teams}, "shots": {team: 0 for team in teams}})
        delta = threat_delta(event)
        if delta and delta["delta"] > 0:
            bucket[event["team_id"]] += delta["delta"]
        if event["type"] == "shot":
            bucket["shots"][event["team_id"]] += 1
    rows = []
    for key in sorted(buckets):
        bucket = buckets[key]
        rows.append({"period": bucket["period"], "start_ms": bucket["start_ms"], "end_ms": bucket["start_ms"] + bucket_ms,
                     "threat": {team: round(bucket[team], 3) for team in teams}, "shots": bucket["shots"]})
    return rows


def pass_network(events: list[dict], team: str, minimum: int = 3) -> list[dict]:
    """Completed pass counts between consecutive actors of the same possession."""
    links: dict[tuple[str, str], int] = {}
    previous = None
    for event in events:
        if previous and event.get("possession_id") == previous.get("possession_id") and previous["type"] == "pass" \
                and previous["outcome"] == "completed" and previous["team_id"] == team and event.get("team_id") == team \
                and event.get("player_id") and event["player_id"] != previous["player_id"]:
            pair = (previous["player_id"], event["player_id"])
            links[pair] = links.get(pair, 0) + 1
        previous = event if event.get("team_id") else previous
    return sorted(({"from": a, "to": b, "count": count} for (a, b), count in links.items() if count >= minimum),
                  key=lambda link: -link["count"])
