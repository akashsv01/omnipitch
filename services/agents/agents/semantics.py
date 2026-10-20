"""Meaning-level checks that the number/name/ID validator cannot do.

Each rule is deterministic and uses only the moment's typed fields:

- score state (lead, level, equaliser, "1-0") is only claimable on goal moments, whose facts carry
  the score after the goal, and must agree with it;
- box position: a shot from <= 16.5 m of the goal centre is provably inside the penalty box (the box
  is 16.5 m deep and 40.32 m wide); "outside the box", "edge of the box" and "long range" are never
  provable from event locations, and "in/inside the box" needs that proof or a recorded box entry;
- pass counts ("a three-pass move") are not in any evidence packet: possession actions are not passes;
- defender-breach phrasing ("broke through the defence") needs defender positions, which we never have;
- a transition starts with the team WINNING the ball: saying it was "stopped by a tackle" or "lost the ball"
  reverses the recorded facts;
- fan text never narrates what the evidence lacks ("no score info is given") - limitations carry that.
"""
from __future__ import annotations

import re

BOX_DEPTH_M = 16.5

DEFENDER_BREACH = re.compile(
    r"\b(broke|break(s|ing)?|broken|cut(s|ting)?|slic(ed|es|ing)|carv(ed|es|ing)) (right )?(through|open)\b"
    r"|\bpenetrat\w*|\bsplit(s|ting)? (open )?the (defen\w*|back\w*)|\bthrough the (defen\w*|back ?line)"
    r"|\bbeat(s|ing)? (the |his |her |their )?(defender|marker|man|full-?back|centre-?back|keeper)s?\b", re.I)
OUTSIDE_BOX = re.compile(r"\boutside (of )?the (penalty )?(box|area)\b|\bedge of the (penalty )?(box|area)\b"
                         r"|\blong[- ]range\b|\bfrom distance\b", re.I)
INSIDE_BOX = re.compile(r"\b(inside|in|into|within) the (penalty )?(box|area)\b", re.I)
PASS_COUNT = re.compile(r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[- ]pass(es)?\b"
                        r"|\b(\d+|two|three|four|five|six|seven|eight|nine|ten) passes\b", re.I)
LEAD = re.compile(r"\b(took|take|takes|taking|extend\w*|in|into|have|has|had|with) the lead\b|\blead(s|ing)? by\b"
                  r"|\b(went|go|goes|going|are|is|was|were|now) ahead\b|\bput (\w+ ){0,3}ahead\b", re.I)
LEVEL = re.compile(r"\bequali[sz]\w*|\blevel(led|ling|s)? (the score|it|things|terms)\b|\b(score|scores|scoreline) (level|tied)\b"
                   r"|\b(kept|keep|keeps|keeping|stay(s|ed)?|leave(s)?|left) (it |the score |things |the game |the match )?(level|tied|all square)\b"
                   r"|\ball square\b|\bdeadlock\w*", re.I)
BEHIND = re.compile(r"\b(behind|trailing|trail(s|ed)? by)\b", re.I)
TURNOVER_REVERSED = re.compile(r"\b(stopped|ended|halted|broken up|cut short|ended) by (a |the )?(tackle|interception|turnover)"
                               r"|\blost (the ball|possession)\b|\bgave (the ball|it|possession) away\b|\bturned (it|the ball) over\b", re.I)
META_IN_FAN_TEXT = re.compile(r"\b(no|not|without) (score|scoring|tracking|position\w*) (info|information|data)\b|\bevidence\b"
                              r"|\b(is|was|are) not (given|provided|available) here\b|\binfo (is|was) (not )?(given|provided)\b", re.I)
# Other score-state wording ("keep the score intact", "the scoreline stays"): allowed only where the score is evidence.
SCORE_STATE = re.compile(r"\b(score|scoreline|scores)( \w+){0,2} (intact|unchanged|the same|as it was|stays|stayed|remains|remained|untouched)\b"
                         r"|\b(keep|keeps|kept|keeping|preserv\w*|protect\w*|maintain\w*|hold\w*|defend\w*) (the|their|its|a) (score|scoreline|lead|advantage|clean sheet)\b"
                         r"|\bthe scoreline\b|\bstill (level|ahead|behind|in front)\b", re.I)
SCORELINE = re.compile(r"(?<![\w.])(\d{1,2})\s*[-–]\s*(\d{1,2})(?![\w.])")
MINUTE_RANGE = re.compile(r"\bminutes? \d{1,3}\s*[-–]\s*\d{1,3}\b", re.I)


def shot_distance(moment: dict) -> float | None:
    for metric in moment["metrics"]:
        if metric["name"] == "shot_distance":
            return float(metric["value"])
    return None


def derived_facts(moment: dict, context: dict) -> dict:
    """Facts derived in code for the evidence packet, so the model never has to guess them."""
    facts: dict = {}
    distance = shot_distance(moment)
    if distance is not None:
        facts["shot_location"] = ("inside the penalty box" if distance <= BOX_DEPTH_M
                                  else "box position not determined by this evidence")
    score = moment.get("facts", {}).get("score")
    if moment["rule"] == "goal" and isinstance(score, dict):
        facts["score_after_goal"] = {context["teams"].get(team, team): goals for team, goals in score.items()}
    else:
        facts["score_state"] = "not in this evidence; do not describe the score, a lead or a level game"
    facts_ = moment.get("facts", {})
    if moment["rule"] == "transition":
        team = context["teams"].get(moment.get("team_id"), "The team")
        facts["what_happened"] = (f"{team} WON the ball with a {facts_.get('turnover_type', 'turnover')}, then moved forward "
                                  + ("and finished with a shot" if facts_.get("ended_in_shot") else "without a shot"))
    if any(metric["name"] == "possession_actions" for metric in moment["metrics"]):
        facts["possession_actions_means"] = "all recorded actions in the possession, not only passes"
    return facts


def _goal_score(moment: dict) -> tuple[int, int] | None:
    """(scoring team's goals, opponent's goals) after the goal, from frozen facts."""
    score = moment.get("facts", {}).get("score")
    if moment["rule"] != "goal" or not isinstance(score, dict) or moment.get("team_id") not in score:
        return None
    mine = score[moment["team_id"]]
    theirs = sum(goals for team, goals in score.items() if team != moment["team_id"])
    return mine, theirs


def semantic_errors(text: str, moment: dict) -> list[str]:
    errors: list[str] = []
    if DEFENDER_BREACH.search(text):
        errors.append("unsupported claim: defenders broken through or beaten (no defender positions)")
    if OUTSIDE_BOX.search(text):
        errors.append("unsupported claim: outside the box or long range (not provable from event locations)")
    distance = shot_distance(moment)
    proven_inside = (distance is not None and distance <= BOX_DEPTH_M) or bool(moment.get("facts", {}).get("box_entry"))
    if INSIDE_BOX.search(text) and not proven_inside:
        errors.append("unsupported claim: in the box (not proven by this evidence)")
    if PASS_COUNT.search(text):
        errors.append("unsupported claim: pass count (possession actions are not passes)")
    if moment["rule"] == "transition" and TURNOVER_REVERSED.search(text):
        errors.append("claim contradicts evidence: the team won the ball in a transition, it did not lose it")
    scan = MINUTE_RANGE.sub(" ", text)
    goal = _goal_score(moment)
    lines = [(int(a), int(b)) for a, b in SCORELINE.findall(scan)]
    if goal is None:
        if LEAD.search(scan) or LEVEL.search(scan) or BEHIND.search(scan) or SCORE_STATE.search(scan) or lines:
            errors.append("unsupported claim: score state (the score is not in this evidence)")
        return errors
    mine, theirs = goal
    if LEAD.search(scan) and not mine > theirs:
        errors.append(f"score claim contradicts evidence: lead claimed at {mine}-{theirs}")
    if LEVEL.search(scan) and mine != theirs:
        errors.append(f"score claim contradicts evidence: level claimed at {mine}-{theirs}")
    if BEHIND.search(scan) and not mine < theirs:
        errors.append(f"score claim contradicts evidence: behind claimed at {mine}-{theirs}")
    for line in lines:
        if sorted(line) != sorted((mine, theirs)):
            errors.append(f"scoreline {line[0]}-{line[1]} contradicts evidence ({mine}-{theirs})")
    return errors


def fan_text_errors(casual_text: str) -> list[str]:
    """Fan text tells the story; what the evidence lacks belongs in limitations, not in prose."""
    return ["fan text narrates missing evidence; keep it in limitations"] if META_IN_FAN_TEXT.search(casual_text) else []
