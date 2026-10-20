"""Code-side validation for generated insights. Prose is never trusted to carry numbers.

validate_insight returns a list of error strings; an empty list means publishable.
finalize returns the candidate when valid, otherwise a labelled deterministic fallback.
"""
from __future__ import annotations

import re

from .narrate import build_fallback_insight, clock_label
from .semantics import fan_text_errors, semantic_errors

REQUIRED = {"schema_version", "run_id", "match_id", "moment_id", "headline", "casual_text", "analyst_text",
            "language", "evidence_ids", "metrics", "limitations", "generation_mode"}
OPTIONAL = {"knowledge_source_ids"}
FORBIDDEN = [
    (re.compile(r"\bprobabilit|\blikelihood|\bodds\b|\bchance of scoring|\bxg\b|expected goals", re.I),
     "probability or xG claim from an illustrative score"),
    (re.compile(r"\bkm/h\b|\bmph\b|\bsprint|\bspeed\b|\bpace of\b", re.I), "speed claim without tracking"),
    (re.compile(r"\bbypass(ed|es)?\b.*\bdefenders?\b|\bdefenders? (were )?(beaten|bypassed)", re.I),
     "bypassed-defender claim without positions"),
    (re.compile(r"\bheat ?map\b", re.I), "heat map claim from event locations"),
    (re.compile(r"\b(caused|forced|led to) (the |a )?(turnover|mistake|error)\b", re.I), "causal pressing claim"),
    (re.compile(r"\d\s*%"), "percentage not present in evidence"),
]
NUMBER = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?")
EVENT_ID = re.compile(r"\b[a-z]+-\d{3,}\b")  # e.g. evt-0340, pass-0001


def _allowed_numbers(moment: dict) -> set[str]:
    values: list[float] = [moment["period"]]
    for metric in moment["metrics"]:
        values.append(metric["value"])

    def walk(value):
        if isinstance(value, bool):
            return
        if isinstance(value, (int, float)):
            values.append(value)
            if value > 1000:  # Milliseconds may be quoted as minutes or seconds.
                values.extend([value / 60000, value // 60000, value / 1000])
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(moment["facts"])
    allowed = set()
    for value in values:
        for text in (f"{value:g}", f"{round(value, 1):g}", f"{round(value):g}", f"{abs(value):g}", f"{round(abs(value), 1):g}"):
            allowed.add(text)
    label = clock_label(moment["period"], moment["match_time_ms"])
    allowed.update(NUMBER.findall(label))
    return allowed


def validate_insight(insight: dict, moment: dict, context: dict) -> list[str]:
    errors: list[str] = []
    keys = set(insight)
    if missing := REQUIRED - keys:
        errors.append(f"missing fields: {sorted(missing)}")
    if extra := keys - REQUIRED - OPTIONAL:
        errors.append(f"unexpected fields: {sorted(extra)}")
    if errors:
        return errors
    if insight["schema_version"] not in ("1.0", "1.1") or insight["language"] != "en":
        errors.append("unsupported schema version or language")
    if insight["generation_mode"] not in ("ai", "fallback"):
        errors.append("generation_mode must be ai or fallback")
    for field in ("run_id", "match_id", "moment_id"):
        if insight[field] != moment[field]:
            errors.append(f"{field} does not match the evidence packet")
    for field in ("headline", "casual_text", "analyst_text"):
        if not isinstance(insight[field], str) or not insight[field].strip():
            errors.append(f"{field} must be nonempty text")
        elif len(insight[field]) > (90 if field == "headline" else 360):
            errors.append(f"{field} is too long")
    evidence = insight["evidence_ids"]
    if not isinstance(evidence, list) or not evidence:
        errors.append("evidence_ids must be a nonempty list")
    else:
        if len(set(evidence)) != len(evidence):
            errors.append("evidence_ids must be unique")
        if unknown := [item for item in evidence if item not in moment["evidence_ids"]]:
            errors.append(f"unknown evidence IDs: {unknown}")
    if not insight["limitations"]:
        errors.append("at least one limitation is required")
    known = {metric["name"]: metric for metric in moment["metrics"]}
    for metric in insight["metrics"]:
        reference = known.get(metric.get("name"))
        if reference is None:
            errors.append(f"metric {metric.get('name')!r} is not in the evidence")
        elif reference["unit"] != metric.get("unit") or abs(reference["value"] - float(metric.get("value", "nan"))) > 1e-9:
            errors.append(f"metric {metric['name']!r} disagrees with the evidence")
    text = " ".join(str(insight[field]) for field in ("headline", "casual_text", "analyst_text"))
    for pattern, reason in FORBIDDEN:
        if pattern.search(text):
            errors.append(f"forbidden claim: {reason}")
    errors.extend(semantic_errors(text, moment))
    errors.extend(fan_text_errors(str(insight["casual_text"])))
    allowed = _allowed_numbers(moment)
    # Evidence IDs of this moment may be cited in prose; their digits are identifiers, not claims.
    # Any other event-ID-shaped token is an unknown citation and is rejected.
    for cited in EVENT_ID.findall(text):
        if cited not in moment["evidence_ids"]:
            errors.append(f"unknown evidence ID in text: {cited!r}")
    scrubbed = EVENT_ID.sub(" ", text.replace(context.get("grid_label", "illustrative-threat-v1"), ""))
    for number in NUMBER.findall(scrubbed):
        if number not in allowed:
            errors.append(f"unsupported number {number!r}")
    actors = {moment.get("player_id")} | set(context.get("evidence_players", []))
    for player_id, name in context["players"].items():
        if name in text and player_id not in actors:
            errors.append(f"player {name!r} is not part of the evidence")
    for team_id, name in context["teams"].items():
        if team_id not in context.get("match_teams", context["teams"]) and name in text:
            errors.append(f"team {name!r} is not in this match")
    return errors


def finalize(candidate: dict | None, moment: dict, context: dict) -> tuple[dict, list[str]]:
    """Publish a valid candidate; otherwise return the labelled deterministic fallback."""
    if candidate is not None:
        errors = validate_insight(candidate, moment, context)
        if not errors:
            return candidate, []
    else:
        errors = ["no candidate output"]
    fallback = build_fallback_insight(moment, context)
    return fallback, errors
