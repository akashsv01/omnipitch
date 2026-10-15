"""Deterministic fallback narration from a frozen evidence packet.

Used whenever a model is unavailable, times out or fails validation. Every number in the
text comes from typed moment fields, so the validator accepts it by construction.
"""
from __future__ import annotations

INSIGHT_SCHEMA_VERSION = "1.1"
FALLBACK_LIMITATION = "AI narration is not connected; this text is a deterministic template from verified metrics."


def clock_label(period: int, match_time_ms: int) -> str:
    minute = match_time_ms // 60000 + 1
    base = 45 if period == 1 else 90
    if minute > 45:
        return f"{base}+{minute - 45}'"
    return f"{minute + base - 45}'"


def _fmt(value: float) -> str:
    return f"{value:g}" if abs(value) >= 10 or value == int(value) else f"{value:.1f}".rstrip("0").rstrip(".")


def build_fallback_insight(moment: dict, context: dict) -> dict:
    """context: {"teams": {id: name}, "players": {id: name}, "home": id, "away": id}."""
    teams, players = context["teams"], context["players"]
    team = teams.get(moment["team_id"], "The team")
    player = players.get(moment["player_id"]) if moment.get("player_id") else None
    metrics = {metric["name"]: metric["value"] for metric in moment["metrics"]}
    facts = moment["facts"]
    clock = clock_label(moment["period"], moment["match_time_ms"])
    rule = moment["rule"]
    if rule == "goal":
        home, away = context["home"], context["away"]
        score = facts["score"]
        headline = f"Goal for {team}"
        casual = f"{player} scores from {_fmt(metrics['shot_distance'])} m. It is now {teams[home]} {score[home]}, {teams[away]} {score[away]}."
        analyst = (f"Goal at {clock}: shot from {_fmt(metrics['shot_distance'])} m, ending a possession with "
                   f"{int(metrics['possession_actions'])} recorded actions. Score {score[home]}-{score[away]}.")
    elif rule == "chance":
        headline = f"{team} test the goalkeeper"
        casual = f"{player} gets a shot on target from {_fmt(metrics['shot_distance'])} m."
        analyst = f"On-target shot at {clock} from {_fmt(metrics['shot_distance'])} m, outcome {facts['outcome']}. No shot-quality model is applied."
    elif rule == "threat_gain":
        headline = f"{team} move into a more dangerous area"
        where = " into the box" if facts.get("box_entry") else " into the final third" if facts.get("final_third_entry") else ""
        casual = f"{player} plays the ball {_fmt(metrics['forward_progress'])} m forward{where}."
        analyst = (f"Completed pass at {clock}: {_fmt(metrics['pass_distance'])} m long, {_fmt(metrics['forward_progress'])} m forward. "
                   f"Illustrative threat {facts['start_value']:g} to {facts['end_value']:g} "
                   f"(+{metrics['threat_delta']:g}, {facts['grid_version']}).")
    elif rule == "transition":
        headline = f"{team} break after winning the ball"
        won = "an interception" if facts["turnover_type"] == "interception" else "a tackle"
        progress = metrics["forward_progress"]
        if progress >= 1:
            ending = " and finish with a shot" if facts["ended_in_shot"] else ""
            casual = f"{player} wins the ball with {won}, and {team} go {_fmt(progress)} m upfield in {_fmt(metrics['elapsed'])} seconds{ending}."
            moved = f"{_fmt(progress)} m of forward progress"
        else:
            casual = f"{player} wins the ball with {won}, and {team} get a shot away within {_fmt(metrics['elapsed'])} seconds."
            moved = "no further passing progress"
        analyst = (f"Transition at {clock}: {facts['turnover_type']} won, then {int(metrics['actions'])} actions and "
                   f"{moved} within {_fmt(metrics['elapsed'])} s{', ending in a shot' if facts['ended_in_shot'] else ''}.")
    elif rule == "pressing_change":
        window = facts["window"]
        start, end = window["start_ms"] // 60000, window["end_ms"] // 60000
        headline = f"{team} press higher"
        casual = f"{team} are disrupting their opponents' build-up more often in this spell."
        analyst = (f"PPDA fell from {metrics['previous_ppda']:g} to {metrics['ppda']:g} "
                   f"({int(metrics['opponent_passes'])} opponent passes, {int(metrics['defensive_actions'])} defensive actions, "
                   f"minutes {start}-{end} of period {moment['period']}). Consistent with increased pressure.")
    else:
        raise ValueError(f"no template for rule {rule!r}")
    return {
        "schema_version": INSIGHT_SCHEMA_VERSION, "run_id": moment["run_id"], "match_id": moment["match_id"],
        "moment_id": moment["moment_id"], "headline": headline, "casual_text": casual, "analyst_text": analyst,
        "language": "en", "evidence_ids": list(moment["evidence_ids"]), "metrics": [dict(m) for m in moment["metrics"]],
        "limitations": list(moment["limitations"]) + [FALLBACK_LIMITATION],
        "generation_mode": "fallback", "knowledge_source_ids": [f"{rule}-v1"],
    }
