"""Deterministic analysis of a revealed event prefix: metrics, moments and fallback insights."""
from __future__ import annotations

from .sample_data import AWAY, HOME, roster  # noqa: F401  (ensures package paths are set)
from omnipitch_analytics.detect import detect_moments  # noqa: E402
from omnipitch_analytics.metrics import (METRIC_VERSION, PPDA_WINDOW_MS, momentum, pass_network,  # noqa: E402
                                         player_stats, ppda, ppda_series, team_directions, team_stats, threat_grid)
from agents.narrate import build_fallback_insight  # noqa: E402

TEAMS = [HOME["id"], AWAY["id"]]


def narration_context(evidence_players: list[str] | None = None) -> dict:
    return {"teams": {HOME["id"]: HOME["name"], AWAY["id"]: AWAY["name"]},
            "players": {p["player_id"]: p["name"] for p in roster()}, "home": HOME["id"], "away": AWAY["id"],
            "match_teams": TEAMS, "evidence_players": evidence_players or []}


def analyse(events: list[dict]) -> dict:
    stats = {team: team_stats(events, team) for team in TEAMS}
    total_passes = sum(s["passes_attempted"] for s in stats.values())
    for s in stats.values():
        s["pass_share_pct"] = round(100 * s["passes_attempted"] / total_passes, 1) if total_passes else None
    current = {}
    if events:
        latest = events[-1]
        directions = team_directions(events)
        start = max(0, latest["match_time_ms"] - PPDA_WINDOW_MS)
        period_events = [e for e in events if e["period"] == latest["period"]]
        for team in TEAMS:
            window = ppda(period_events, team, latest["period"], start, latest["match_time_ms"] + 1, directions)
            window["closed"] = False
            current[team] = window
    return {
        "metric_version": METRIC_VERSION, "grid_version": threat_grid()["grid_version"],
        "through_sequence": events[-1]["sequence"] if events else 0, "teams": stats, "ppda_current": current,
        # Window evidence lists stay server-side; pressing moments freeze their own evidence.
        "ppda_series": [dict(window, evidence_ids=[]) for window in ppda_series(events, TEAMS)], "momentum": momentum(events, TEAMS),
        "players": player_stats(events), "pass_network": {team: pass_network(events, team) for team in TEAMS},
    }


def moments_with_insights(events: list[dict], run_id: str, match_id: str) -> list[dict]:
    by_id = {e["event_id"]: e for e in events}
    result = []
    for moment in detect_moments(events, run_id, match_id, TEAMS):
        actors = sorted({by_id[i]["player_id"] for i in moment["evidence_ids"] if by_id.get(i, {}).get("player_id")})
        moment["insight"] = build_fallback_insight(moment, narration_context(actors))
        result.append(moment)
    return result
