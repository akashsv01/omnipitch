"""Spanish stories, built on the server from the same frozen moment as the English template (narrate.py), branch for
branch, so both languages state the same numbers. Names, scores and units are never translated; decimals use a comma.

story_es: the rule-based Spanish story (always available, valid by construction).
translate_insight: a Spanish version of accepted AI text via the model, accepted only if it keeps exactly the
English text's numbers, names and score; otherwise the rule-based Spanish story is used and the reason is recorded.
"""
from __future__ import annotations

import json
import re

from .narrate import _fmt, clock_label, goal_context, transition_branch

TEAM = {"harbor": "Harbor Comets", "vale": "Vale Owls"}
NUMBER = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?")


def _n(value: float) -> str:
    return _fmt(value).replace(".", ",")


def _raw(value) -> str:
    return f"{value:g}".replace(".", ",") if isinstance(value, (int, float)) else str(value)


def story_es(moment: dict, context: dict) -> dict:
    team = TEAM.get(moment.get("team_id") or "", "El equipo")
    player = context["players"].get(moment.get("player_id") or "", "Un jugador")
    metric = {m["name"]: m["value"] for m in moment["metrics"]}.get
    facts = moment["facts"]
    clock = clock_label(moment["period"], moment["match_time_ms"])
    rule = moment["rule"]
    if rule == "goal":
        kind = goal_context(moment)
        score = facts.get("score") or {}
        headline = {"opening": f"{team} abren el marcador", "equaliser": f"{team} empatan", "lead": f"{team} se ponen por delante",
                    "extend": f"{team} amplían la ventaja", "reduce": f"{team} recortan distancias"}.get(kind, f"Gol de {team}")
        h, a = score.get("harbor", 0), score.get("vale", 0)
        return {"headline": headline,
                "casual_text": f"{player} marca desde {_n(metric('shot_distance', 0))} m. Ahora: Harbor Comets {h}, Vale Owls {a}.",
                "analyst_text": (f"Gol en el {clock}: disparo desde {_n(metric('shot_distance', 0))} m, al final de una posesión con "
                                 f"{round(metric('possession_actions', 0))} acciones registradas. Marcador {h}-{a}.")}
    if rule == "chance":
        outcome = {"saved": "parado", "blocked": "bloqueado", "off_target": "fuera", "goal": "gol"}.get(str(facts.get("outcome")), str(facts.get("outcome")))
        return {"headline": f"{team} obligan a parar al portero" if facts.get("outcome") == "saved" else f"{team} ponen a prueba al portero",
                "casual_text": f"{player} dispara a puerta desde {_n(metric('shot_distance', 0))} m.",
                "analyst_text": f"Disparo a puerta en el {clock} desde {_n(metric('shot_distance', 0))} m, resultado: {outcome}. No se aplica un modelo de calidad de disparo."}
    if rule == "threat_gain":
        where = " hasta el área" if facts.get("box_entry") else " hasta el último tercio" if facts.get("final_third_entry") else ""
        headline = (f"{team} pasan al área" if facts.get("box_entry") else f"{team} llegan al último tercio" if facts.get("final_third_entry")
                    else f"{team} avanzan a una zona más peligrosa")
        return {"headline": headline,
                "casual_text": (f"{player} lleva el balón {_n(metric('forward_progress', 0))} m hacia delante{where}." if metric("forward_progress", 0) >= 1
                                else f"{player} mueve el balón en horizontal{where}."),
                "analyst_text": (f"Pase completado en el {clock}: {_n(metric('pass_distance', 0))} m de largo, {_n(metric('forward_progress', 0))} m hacia delante. "
                                 f"Amenaza ilustrativa de {_raw(facts.get('start_value'))} a {_raw(facts.get('end_value'))} (+{_raw(metric('threat_delta', 0))}).")}
    if rule == "transition":
        won = "una intercepción" if facts.get("turnover_type") == "interception" else "una entrada"
        turnover = "intercepción ganada" if facts.get("turnover_type") == "interception" else "entrada ganada"
        fp, t, actions = _n(metric("forward_progress", 0)), _n(metric("elapsed", 0)), round(metric("actions", 0))
        branch = transition_branch(moment)
        headline = {"both": f"{team} salen rápido y disparan", "progress": f"{team} salen rápido tras recuperar el balón",
                    "shot": f"{team} disparan poco después de recuperar el balón"}[branch]
        if branch == "both":
            return {"headline": headline,
                    "casual_text": f"{player} recupera el balón con {won}; {team} avanzan {fp} m y disparan en menos de {t} segundos.",
                    "analyst_text": f"Transición en el {clock}: {turnover}, luego {actions} acciones, {fp} m de progresión y un disparo en {t} s."}
        if branch == "progress":
            return {"headline": headline,
                    "casual_text": f"{player} recupera el balón con {won} y {team} avanzan {fp} m en {t} segundos. La jugada no termina en disparo.",
                    "analyst_text": f"Transición en el {clock}: {turnover}, luego {actions} acciones y {fp} m de progresión en {t} s; la secuencia registrada termina sin disparo."}
        moved = f"{fp} m de progresión" if metric("forward_progress", 0) >= 1 else "sin progresión con pases"
        return {"headline": headline,
                "casual_text": f"{player} recupera el balón con {won} y {team} disparan {t} segundos después.",
                "analyst_text": f"Transición en el {clock}: {turnover}, luego un disparo {t} s después, tras {actions} acciones y {moved}."}
    if rule == "pressing_change":
        window = facts.get("window") or {}
        return {"headline": f"{team} permiten menos pases por acción defensiva",
                "casual_text": f"{team} hicieron una acción defensiva tras menos pases del rival que en su tramo anterior.",
                "analyst_text": (f"El PPDA bajó de {_raw(metric('previous_ppda', 0))} a {_raw(metric('ppda', 0))} "
                                 f"({round(metric('opponent_passes', 0))} pases rivales, {round(metric('defensive_actions', 0))} acciones defensivas, "
                                 f"minutos {window.get('start_ms', 0) // 60000}-{window.get('end_ms', 0) // 60000} del periodo {moment['period']}). "
                                 f"El PPDA describe intensidad, no dónde fue la presión ni si funcionó.")}
    raise ValueError(f"no Spanish template for rule {rule!r}")


def _numbers(text: str) -> list[str]:
    return sorted(n.replace(",", ".") for n in NUMBER.findall(text.replace("'", " ")))


def check_translation(english: dict, spanish: dict, context: dict) -> list[str]:
    """The translation must keep exactly the English numbers and the same player and team names."""
    errors = []
    for field in ("headline", "casual_text", "analyst_text"):
        if not str(spanish.get(field, "")).strip():
            errors.append(f"{field} is empty")
            continue
        if _numbers(spanish[field]) != _numbers(english[field]):
            errors.append(f"{field}: numbers differ from the English text")
        for name in list(context["players"].values()) + list(TEAM.values()):
            if (name in english[field]) != (name in spanish[field]):
                errors.append(f"{field}: name {name!r} added or dropped")
    text = " ".join(map(str, spanish.values()))
    for pattern, reason in SPANISH_FORBIDDEN:
        if pattern.search(text):
            errors.append(f"unsupported claim in translation: {reason}")
    return errors


# Meaning checks for Spanish, mirroring the English ones (agents.semantics): claims this data cannot support.
SPANISH_FORBIDDEN = [
    (re.compile(r"\b(probabilidad|xg|goles esperados)\b", re.I), "probability or xG"),
    (re.compile(r"\b(caus[óo]|provoc[óo]|forz[óo])\b", re.I), "causation"),
    (re.compile(r"\b(romp\w*|super\w*|atraves\w*|perfor\w*)\b[^.]{0,30}?\b(defensa|l[íi]nea|defensores|zaga|ataque)\b", re.I), "defender breach"),
    (re.compile(r"\b(domin\w*|aplast\w*|brillante|espectacular|letal)\b", re.I), "unsupported judgement"),
    (re.compile(r"\bvelocidad\b|\bkm/h\b", re.I), "speed"),
]


def translate_insight(insight: dict, context: dict, client, timeout: float = 20.0) -> tuple[dict | None, str | None]:
    """(spanish, reason). spanish is None when the model failed or its output did not keep the facts."""
    from .model import ModelError
    english = {k: insight[k] for k in ("headline", "casual_text", "analyst_text")}
    messages = [
        {"role": "system", "content": (
            "Translate this football match explanation into natural Spanish (Spain) for sports fans. Keep every number exactly, "
            "using a decimal comma; keep player and team names unchanged; keep units (m, s). Add nothing and remove nothing: "
            "no claims about defences, defenders, lines, dominance, speed or causes that the English does not make. "
            "Translate 'break forward' as 'salen rápido', 'move into a more dangerous area' as 'avanzan a una zona más peligrosa'. "
            "Return JSON {\"headline\", \"casual_text\", \"analyst_text\"}.")},
        {"role": "user", "content": json.dumps(english, ensure_ascii=False)}]
    try:
        out = client.complete("translator", messages, timeout)
    except ModelError as exc:
        return None, f"model error: {str(exc)[:120]}"
    spanish = {k: str(out.get(k, "")).strip() for k in english}
    if errors := check_translation(english, spanish, context):
        return None, f"translation rejected: {errors[0]}"
    return spanish, None
