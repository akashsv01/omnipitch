"""Live commentary lines, composed on the server from revealed events, accepted insight text and recaps.

The browser asks for a line by reference (an event, a moment or a recap scope); it never sends text. Each line is:
- play-by-play from one validated event (kick-off, half-time, full-time, shots, saves, goals with the score at that
  moment, ball wins in the opponent's half, fouls, passes into the box, long balls, switches of play and long passing
  moves), in English or Spanish, for fans (short) or analysts (with the measurement the event supports). Each situation
  has several wordings, chosen per event (stable, so caption and audio always match), plus context the events up to
  that point support: a player's shot count, a team's pressure spell, the score situation;
- context from a detected moment, using its accepted insight text (AI-written and validated, or rule-based) in
  the viewer's language;
- a recap, read from the recap built at that period's cutoff.
Nothing after the replay's current position can be referenced, so no line can leak a later score or event.
`speakable` turns display text into words a voice reads well (minutes, metres, seconds, score dashes).
"""
from __future__ import annotations

import hashlib
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


def _pick(key: str, options: list):
    """A stable choice per event: the same event always gets the same wording, so the caption and the audio,
    which are composed separately from the same reference, always match."""
    return options[int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % len(options)]


def _index(events: list[dict], event: dict) -> int:
    i = event["sequence"] - 1
    if 0 <= i < len(events) and events[i]["sequence"] == event["sequence"]:
        return i
    return next(k for k, e in enumerate(events) if e["sequence"] == event["sequence"])


def _minute(event: dict) -> float:
    return (event["period"] - 1) * 45 + event["match_time_ms"] / 60000


ORDINAL = {"en": {2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth"},
           "es": {2: "segundo", 3: "tercer", 4: "cuarto", 5: "quinto", 6: "sexto"}}

# Shot wording by outcome. {p} player, {at} where it was hit from (words for fans, metres for analysts).
SHOT = {
    "en": {
        "saved": ["{p} shoots{at}, and it's saved.", "Good save! {p} is denied{at}.", "{p} tests the goalkeeper{at}.",
                  "{p} forces a stop from the keeper{at}."],
        "blocked": ["{p}'s shot{at} is blocked.", "Blocked! {p}'s effort{at} is charged down.",
                    "{p} shoots{at}, but a defender gets in the way."],
        "wide": ["{p} shoots{at}, but it's wide.", "{p} goes for goal{at}, but misses the target.", "{p} misses the target{at}.",
                 "{p} lets fly{at}, and it goes past the post."],
    },
    "es": {
        "saved": ["Disparo de {p}{at}, y el portero lo para.", "¡Buena parada! {p} no puede marcar{at}.",
                  "{p} pone a prueba al portero{at}.", "{p} obliga al portero a intervenir{at}."],
        "blocked": ["Disparo de {p}{at}, bloqueado.", "¡Bloqueado! La defensa tapa el disparo de {p}{at}.",
                    "{p} dispara{at}, pero un defensa se cruza."],
        "wide": ["{p} dispara{at}, pero se va fuera.", "{p} lo intenta{at}, pero no encuentra la portería.",
                 "Fuera el disparo de {p}{at}.", "{p} chuta{at} y el balón se marcha junto al palo."],
    },
}
GOAL = {"en": ["Goal for {t}! {p} scores{at}.", "Goal! {p} finds the net for {t}{at}.", "Goal for {t}! {p} puts it away{at}."],
        "es": ["¡Gol de {t}! Marca {p}{at}.", "¡Gol! {p} la mete para {t}{at}.", "¡Gol de {t}! {p} no perdona{at}."]}
GOAL_CONTEXT = {"en": {"opening": "The deadlock is broken.", "equaliser": "All square again.", "lead": "{t} go in front.",
                       "extend": "{t} extend the lead.", "reduce": "{t} pull one back."},
                "es": {"opening": "Se rompe el empate.", "equaliser": "Todo igualado otra vez.", "lead": "{t} se ponen por delante.",
                       "extend": "{t} amplían la ventaja.", "reduce": "{t} recortan distancias."}}
BALL_WIN = {"en": ["{p} wins it back for {t} {how} in the opponent's half.", "Turnover! {p} steals it high up the pitch {how}.",
                   "{p} pounces {how}, and {t} have it back in the opponent's half.",
                   "Great pressure from {p}, who wins it {how} deep in the opponent's half.",
                   "{t} win it high: {p} {how}."],
            "es": ["{p} recupera el balón para {t} {how} en campo rival.", "¡Robo! {p} se la quita arriba {how}.",
                   "{p} aprieta y recupera {how}: {t} vuelven a tenerla en campo rival.",
                   "Gran presión de {p}, que recupera {how} en campo contrario.",
                   "{t} la recuperan arriba: {p}, {how}."]}
FOUL = {"en": ["Foul by {p}. Free kick to {o}.", "{p} brings a player down, and it's a free kick to {o}.",
               "The referee blows for a foul by {p}.", "{p} is penalised, and {o} have a free kick."],
        "es": ["Falta de {p}. Tiro libre para {o}.", "{p} derriba a un rival: tiro libre para {o}.", "El árbitro pita falta de {p}.",
               "Se señala falta de {p}; tiro libre para {o}."]}
INTO_BOX = {"en": ["{p} finds a teammate in the box.", "{p} slips it into the area.", "Into the box from {p}."],
            "es": ["{p} encuentra a un compañero en el área.", "{p} mete el balón en el área.", "Pase al área de {p}."]}
LONG_BALL = {"en": ["{p} goes long, about {l} to find a teammate.", "A long ball from {p}, about {l}, and it's controlled.",
                    "{p} picks out a teammate with a {l} pass."],
             "es": ["{p} busca en largo: unos {l} hasta un compañero.", "Balón largo de {p}, unos {l}, y llega a su destino.",
                    "{p} encuentra a un compañero con un pase de {l}."]}
SWITCH = {"en": ["{p} switches the play to the other flank.", "A big switch from {p}, right across the pitch."],
          "es": ["{p} cambia el juego de banda.", "Gran cambio de orientación de {p}, de lado a lado."]}
MOVE = {"en": ["{t} keeping the ball well: {n} passes in this move.", "Patient from {t}, {n} passes and counting."],
        "es": ["{t} mueven bien el balón: {n} pases en esta jugada.", "Paciencia de {t}: {n} pases seguidos."]}


def _shot_context(event: dict, events: list[dict], i: int, team: str, player: str, language: str) -> str:
    """One short piece of context a commentator would add, chosen from what the events up to this shot support."""
    es = language == "es"
    options = []
    shots_by_player = 1 + sum(1 for e in events[:i] if e["type"] == "shot" and e.get("player_id") == event.get("player_id"))
    if 2 <= shots_by_player <= 6 and player:
        surname = player.split(" ")[-1]
        nth = ORDINAL[language][shots_by_player]
        options.append(f"Es el {nth} intento de {surname}." if es else f"That's the {nth} attempt from {surname}.")
    now = _minute(event)
    recent = sum(1 for e in events[:i + 1] if e["type"] == "shot" and e.get("team_id") == event.get("team_id")
                 and e["period"] == event["period"] and now - _minute(e) <= 10)
    if recent >= 3:
        options.append(f"{team} aprietan: {recent} disparos en diez minutos." if es else f"{team} keep pushing: {recent} shots in ten minutes.")
    before = _score_after(events, event["sequence"] - 1)
    mine = before.get(event.get("team_id") or "", 0)
    theirs = sum(before.values()) - mine
    if mine == theirs - 1:
        options.append(f"{team} siguen buscando el empate." if es else f"{team} still chasing the equaliser.")
    elif mine > theirs:
        options.append(f"{team} buscan ampliar la ventaja." if es else f"{team} looking to stretch the lead.")
    elif mine == theirs and now >= 75:
        options.append("Sigue el empate, y el tiempo se agota." if es else "Still level, with time running out.")
    if not options or not _pick(f"{event['event_id']}|say-context", [True, True, False]):
        return ""
    return " " + _pick(f"{event['event_id']}|context", options)


def event_line(event: dict, events: list[dict], players: dict, audience: str, language: str) -> tuple[str, int] | None:
    """(text, priority) for an event worth saying aloud, or None for routine actions. Wording varies per event
    (stable for that event) and adds context the recorded events support: shot counts, pressure spells, the score."""
    es, analyst = language == "es", audience == "analyst"
    lang = "es" if es else "en"
    team = TEAM.get(event.get("team_id") or "", "")
    other = next((name for key, name in TEAM.items() if key != event.get("team_id")), "")
    player = players.get(event.get("player_id") or "", "")
    kind, period = event["type"], event["period"]
    key = event["event_id"]
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
        i = _index(events, event)
        distance = shot_distance_m(event)
        if analyst:
            at = f" desde {_m(distance, es)}" if es else f" from {_m(distance, es)}"
        else:  # Fans hear where it was hit from in words, not metres.
            band = "close" if distance <= 11 else "box" if distance <= 18 else "far" if distance > 25 else ""
            at = {"close": " desde cerca" if es else " from close range", "box": " dentro del área" if es else " inside the box",
                  "far": " desde lejos" if es else " from distance", "": ""}[band]
        if event.get("is_goal"):
            s = _score_after(events, event["sequence"])
            before = _score_after(events, event["sequence"] - 1)
            mine, theirs = before.get(event["team_id"], 0), sum(before.values()) - before.get(event["team_id"], 0)
            situation = "opening" if mine == theirs == 0 else "equaliser" if mine == theirs - 1 else "lead" if mine == theirs \
                else "extend" if mine > theirs else "reduce"
            context = GOAL_CONTEXT[lang][situation].format(t=team)
            score = f"Harbor Comets {s['harbor']}, Vale Owls {s['vale']}."
            return f"{_pick(key, GOAL[lang]).format(t=team, p=player, at=at)} {context} {score}", 100
        outcome = event.get("outcome")
        variant = outcome if outcome in ("saved", "blocked") else "wide"
        text = _pick(key, SHOT[lang][variant]).format(p=player, at=at) + _shot_context(event, events, i, team, player, lang)
        return text, 70 if variant == "saved" else 55
    if kind in ("tackle", "interception") and event.get("outcome") == "won" and event.get("start"):
        # Only ball wins in the opponent's half: the ones that can start an attack.
        if normalize(event["start"], event["attacking_direction"])["x"] < 52.5:
            return None
        how = ("con una intercepción" if kind == "interception" else "con una entrada") if es else \
              ("with an interception" if kind == "interception" else "with a tackle")
        return _pick(key, BALL_WIN[lang]).format(p=player, t=team, how=how), 40
    if kind == "foul" and player:
        return _pick(key, FOUL[lang]).format(p=player, o=other), 38
    if kind == "pass" and event.get("outcome") == "completed" and event.get("end") and event.get("attacking_direction"):
        start, end = normalize(event["start"], event["attacking_direction"]), normalize(event["end"], event["attacking_direction"])
        length = pass_distance_m(event)
        if start["x"] < 88.5 <= end["x"] and 13.84 <= end["y"] <= 54.16:
            if analyst:
                gain = forward_progress_m(event)
                return ((f"{player} mete el balón en el área: pase de {_m(length, es)}, {_m(gain, es)} hacia delante." if es
                         else f"{player} plays it into the box: a {_m(length, es)} pass, {_m(gain, es)} forward."), 45)
            return _pick(key, INTO_BOX[lang]).format(p=player), 45
        moved = _passes_in_move(events, _index(events, event))
        if moved in (8, 12, 16):
            return _pick(key, MOVE[lang]).format(t=team, n=moved), 42
        if abs(end["y"] - start["y"]) >= 30:
            return _pick(key, SWITCH[lang]).format(p=player), 34
        if length >= 35:
            return _pick(key, LONG_BALL[lang]).format(p=player, l=_m(length, es)), 36
    return None


def _passes_in_move(events: list[dict], i: int) -> int:
    """Completed passes so far in this possession by the team in possession, up to and including event i."""
    event, count = events[i], 0
    for e in reversed(events[:i + 1]):
        if e.get("possession_id") != event.get("possession_id") or e.get("team_id") != event.get("team_id"):
            break
        if e["type"] == "pass" and e.get("outcome") == "completed":
            count += 1
    return count


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
