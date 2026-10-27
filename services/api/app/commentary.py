"""Live commentary lines, composed on the server from revealed events, accepted insight text and recaps.

The browser asks for a line by reference (an event, a moment or a recap scope); it never sends text. Each line is:
- play-by-play from one validated event (kick-off, half-time, full-time, shots, saves, goals with the score at that
  moment, and ball wins in the opponent's half), in English or Spanish, for fans (short) or analysts (with the
  measurement the event supports);
- context from a detected moment, using its accepted insight text (AI-written and validated, or rule-based) in
  the viewer's language;
- a recap, read from the recap built at that period's cutoff.
Nothing after the replay's current position can be referenced, so no line can leak a later score or event.
`speakable` turns display text into words a voice reads well (minutes, metres, seconds, score dashes).
"""
from __future__ import annotations

import re

from agents.narrate import clock_label
from omnipitch_analytics.metrics import forward_progress_m, normalize, pass_distance_m, shot_distance_m

TEAM = {"harbor": "Harbor Comets", "vale": "Vale Owls"}


def _score_after(events: list[dict], upto_sequence: int) -> dict:
    score = {"harbor": 0, "vale": 0}
    for event in events:
        if event["sequence"] > upto_sequence:
            break
        if event["type"] == "shot" and event.get("is_goal"):
            score[event["team_id"]] += 1
    return score


def _m(value: float, es: bool) -> str:
    text = f"{round(value)}"
    return f"{text} m"


def event_line(event: dict, events: list[dict], players: dict, audience: str, language: str) -> tuple[str, int] | None:
    """(text, priority) for an event worth saying aloud, or None for routine actions."""
    es, analyst = language == "es", audience == "analyst"
    team = TEAM.get(event.get("team_id") or "", "")
    player = players.get(event.get("player_id") or "", "")
    kind, period = event["type"], event["period"]
    if kind == "period_start":
        if period == 1:
            return ("¡Comienza el partido! Harbor Comets contra Vale Owls." if es else "Kick-off: Harbor Comets against Vale Owls."), 90
        return ("Arranca la segunda parte." if es else "The second half is under way."), 90
    if kind == "period_end":
        s = _score_after(events, event["sequence"])
        line = f"Harbor Comets {s['harbor']}, Vale Owls {s['vale']}."
        if period == 1:
            return (f"Descanso. {line}" if es else f"Half-time. {line}"), 95
        return (f"Final del partido. {line}" if es else f"Full-time. {line}"), 95
    if kind == "shot":
        distance = shot_distance_m(event)
        at = (f" desde {_m(distance, es)}" if es else f" from {_m(distance, es)}") if analyst else ""
        if event.get("is_goal"):
            s = _score_after(events, event["sequence"])
            score = f"Harbor Comets {s['harbor']}, Vale Owls {s['vale']}."
            return ((f"¡Gol de {team}! Marca {player}{at}. {score}" if es else f"Goal for {team}! {player} scores{at}. {score}"), 100)
        outcome = event.get("outcome")
        if outcome == "saved":
            return ((f"Disparo de {player}{at}, y el portero lo para." if es else f"{player} shoots{at}, and it's saved."), 70)
        if outcome == "blocked":
            return ((f"Disparo de {player}{at}, bloqueado." if es else f"{player}'s shot{at} is blocked."), 55)
        return ((f"{player} dispara{at}, pero se va fuera." if es else f"{player} shoots{at}, but it's wide."), 55)
    if kind in ("tackle", "interception") and event.get("outcome") == "won" and event.get("start"):
        # Only ball wins in the opponent's half: the ones that can start an attack.
        if normalize(event["start"], event["attacking_direction"])["x"] < 52.5:
            return None
        how = ("con una intercepción" if kind == "interception" else "con una entrada") if es else \
              ("with an interception" if kind == "interception" else "with a tackle")
        return ((f"{player} recupera el balón para {team} {how} en campo rival." if es
                 else f"{player} wins it back for {team} {how} in the opponent's half."), 40)
    if kind == "pass" and event.get("outcome") == "completed" and analyst and event.get("end"):
        start, end = normalize(event["start"], event["attacking_direction"]), normalize(event["end"], event["attacking_direction"])
        if start["x"] < 88.5 <= end["x"] and 13.84 <= end["y"] <= 54.16:
            length, gain = pass_distance_m(event), forward_progress_m(event)
            return ((f"{player} mete el balón en el área: pase de {_m(length, es)}, {_m(gain, es)} hacia delante." if es
                     else f"{player} plays it into the box: a {_m(length, es)} pass, {_m(gain, es)} forward."), 35)
    return None


def moment_line(moment: dict, audience: str, language: str, brief: bool = False) -> str:
    """Context for a detected moment, from its accepted insight text in the viewer's language. `brief` keeps only the
    headline, for fast replays where a full explanation would still be playing long after the moment has passed."""
    insight = moment["insight"]
    source = (insight.get("translations") or {}).get("es") if language == "es" else None
    if source:
        return f"{source['headline']}." if brief else f"{source['headline']}. {source['casual_text'] if audience == 'fan' else source['analyst_text']}"
    return f"{insight['headline']}." if brief else f"{insight['headline']}. {insight['casual_text'] if audience == 'fan' else insight['analyst_text']}"


def recap_line(recap: dict) -> str:
    return f"{recap['headline']}. {recap['summary']}"


MINUTE = re.compile(r"\b(\d{1,3})\+(\d{1,2})'")
SIMPLE_MINUTE = re.compile(r"\b(\d{1,3})'")
METRES = re.compile(r"(\d+(?:[.,]\d+)?)\s?m\b")
SECONDS = re.compile(r"(\d+(?:[.,]\d+)?)\s?s\b")
SCORE = re.compile(r"\b(\d)-(\d)\b")


def speakable(text: str, language: str) -> str:
    """Words for the voice: "45+2'" -> "45 plus 2 minutes", "12.5 m" -> "12.5 metres", "1-0" -> "1 0" read as a score."""
    es = language == "es"
    text = MINUTE.sub(lambda m: f"{'minuto' if es else 'minute'} {m.group(1)} {'más' if es else 'plus'} {m.group(2)}", text)
    text = SIMPLE_MINUTE.sub(lambda m: f"{'minuto' if es else 'minute'} {m.group(1)}", text)
    text = METRES.sub(lambda m: f"{m.group(1)} {'metros' if es else 'metres'}", text)
    text = SECONDS.sub(lambda m: f"{m.group(1)} {'segundos' if es else 'seconds'}", text)
    text = SCORE.sub(lambda m: f"{m.group(1)} {'a' if es else 'to'} {m.group(2)}", text)
    return text


def clock_of(event: dict) -> str:
    return clock_label(event["period"], event["match_time_ms"])
