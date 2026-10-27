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
    """Metres and seconds at one decimal at most (27.05 -> 27.1, 7.25 -> 7.2, 38.0 -> 38). The frontend's
    metricText applies the same rule, so a sentence and the value beside it always match."""
    return f"{value:g}" if value == int(value) else f"{value:.1f}".rstrip("0").rstrip(".")


TRANSITION_MIN_PROGRESS_M = 35.0  # Mirrors the detector's trigger (omnipitch_analytics.detect); used only to pick wording.


def goal_context(moment: dict) -> str | None:
    """What a goal did to the score, from the frozen score after the goal (before = after minus this goal).

    One of: opening, equaliser, lead, extend, reduce, or None when the score is not in the facts."""
    score = moment.get("facts", {}).get("score")
    team = moment.get("team_id")
    if not isinstance(score, dict) or team not in score:
        return None
    mine_after = score[team]
    theirs = sum(goals for other, goals in score.items() if other != team)
    mine_before = mine_after - 1
    if mine_before == 0 and theirs == 0:
        return "opening"
    if mine_after == theirs:
        return "equaliser"
    if mine_before == theirs:
        return "lead"
    if mine_before > theirs:
        return "extend"
    return "reduce"


def transition_branch(moment: dict) -> str:
    """Which trigger the transition met: 'both', 'progress' (no shot) or 'shot' (short advance ending in a shot)."""
    metrics = {metric["name"]: metric["value"] for metric in moment["metrics"]}
    long = metrics.get("forward_progress", 0) >= TRANSITION_MIN_PROGRESS_M
    shot = bool(moment.get("facts", {}).get("ended_in_shot"))
    return "both" if long and shot else "progress" if long else "shot"


def fallback_limitation(reason: str | None) -> str:
    """Say why the template was used; never imply AI wrote it."""
    if not reason:
        return FALLBACK_LIMITATION
    return f"AI narration unavailable ({reason}); this text is a deterministic template from verified metrics."


def build_fallback_insight(moment: dict, context: dict, reason: str | None = None, status: str = "rule_based") -> dict:
    """context: {"teams": {id: name}, "players": {id: name}, "home": id, "away": id}.

    status says why the template is shown (see insight.schema.json generation_status); reason is the detail."""
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
        kind = goal_context(moment)
        headline = {"opening": f"{team} open the scoring", "equaliser": f"{team} equalise", "lead": f"{team} go ahead",
                    "extend": f"{team} extend the lead", "reduce": f"{team} pull a goal back"}.get(kind, f"Goal for {team}")
        casual = f"{player} scores from {_fmt(metrics['shot_distance'])} m. It is now {teams[home]} {score[home]}, {teams[away]} {score[away]}."
        analyst = (f"Goal at {clock}: shot from {_fmt(metrics['shot_distance'])} m, ending a possession with "
                   f"{int(metrics['possession_actions'])} recorded actions. Score {score[home]}-{score[away]}.")
    elif rule == "chance":
        headline = {"saved": f"{team} force a save"}.get(facts.get("outcome"), f"{team} test the goalkeeper")
        casual = f"{player} gets a shot on target from {_fmt(metrics['shot_distance'])} m."
        analyst = f"On-target shot at {clock} from {_fmt(metrics['shot_distance'])} m, outcome {facts['outcome']}. No shot-quality model is applied."
    elif rule == "threat_gain":
        headline = (f"{team} pass into the box" if facts.get("box_entry") else f"{team} reach the final third" if facts.get("final_third_entry")
                    else f"{team} move into a more dangerous area")
        where = " into the box" if facts.get("box_entry") else " into the final third" if facts.get("final_third_entry") else ""
        # A pass can raise the illustrative threat with little or no forward gain; never say "0 m forward".
        casual = (f"{player} plays the ball {_fmt(metrics['forward_progress'])} m forward{where}." if metrics["forward_progress"] >= 1
                  else f"{player} plays the ball across{where}.")
        analyst = (f"Completed pass at {clock}: {_fmt(metrics['pass_distance'])} m long, {_fmt(metrics['forward_progress'])} m forward. "
                   f"Illustrative threat {facts['start_value']:g} to {facts['end_value']:g} "
                   f"(+{metrics['threat_delta']:g}).")
    elif rule == "transition":
        headline = {"both": f"{team} break and shoot", "progress": f"{team} break forward after winning the ball",
                    "shot": f"{team} shoot soon after winning the ball"}[transition_branch(moment)]
        won = "an interception" if facts["turnover_type"] == "interception" else "a tackle"
        progress, elapsed, actions = metrics["forward_progress"], _fmt(metrics["elapsed"]), int(metrics["actions"])
        # Word the story by the trigger that fired: a long advance, a quick shot after the regain, or both.
        branch = transition_branch(moment)
        if branch == "both":
            casual = (f"{player} wins the ball with {won}; {team} move it {_fmt(progress)} m forward "
                      f"and get a shot away within {elapsed} seconds.")
            analyst = (f"Transition at {clock}: {facts['turnover_type']} won, then {actions} actions, "
                       f"{_fmt(progress)} m of forward progress and a shot within {elapsed} s.")
        elif branch == "progress":
            casual = (f"{player} wins the ball with {won}, and {team} carry it {_fmt(progress)} m forward "
                      f"in {elapsed} seconds. The move does not end in a shot.")
            analyst = (f"Transition at {clock}: {facts['turnover_type']} won, then {actions} actions and "
                       f"{_fmt(progress)} m of forward progress within {elapsed} s; the recorded sequence ends without a shot.")
        else:
            casual = f"{player} wins the ball with {won}, and {team} get a shot away {elapsed} seconds later."
            moved = f"{_fmt(progress)} m of forward progress" if progress >= 1 else "no forward passing progress"
            analyst = (f"Transition at {clock}: {facts['turnover_type']} won, then a shot {elapsed} s later, "
                       f"after {actions} actions and {moved}.")
    elif rule == "pressing_change":
        window = facts["window"]
        start, end = window["start_ms"] // 60000, window["end_ms"] // 60000
        # PPDA measures how many passes the opponents made per defensive action; it is not proof of a higher press.
        headline = f"{team} allow fewer passes per defensive action"
        casual = f"{team} made a defensive action after fewer opponent passes than in their previous spell."
        analyst = (f"PPDA fell from {metrics['previous_ppda']:g} to {metrics['ppda']:g} "
                   f"({int(metrics['opponent_passes'])} opponent passes, {int(metrics['defensive_actions'])} defensive actions, "
                   f"minutes {start}-{end} of period {moment['period']}). PPDA describes intensity, not where the pressure happened or whether it worked.")
    else:
        raise ValueError(f"no template for rule {rule!r}")
    return {
        "schema_version": INSIGHT_SCHEMA_VERSION, "run_id": moment["run_id"], "match_id": moment["match_id"],
        "moment_id": moment["moment_id"], "headline": headline, "casual_text": casual, "analyst_text": analyst,
        "language": "en", "evidence_ids": list(moment["evidence_ids"]), "metrics": [dict(m) for m in moment["metrics"]],
        "limitations": list(moment["limitations"]) + [fallback_limitation(reason)],
        "generation_mode": "fallback", "knowledge_source_ids": [f"{rule}-v1"],
        "generation_status": status, "generation_reason": reason[:300] if reason else None,
    }
