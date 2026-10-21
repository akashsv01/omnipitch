"""Bounded narration workflow: Analyst + Tactical Coach (concurrent) -> Broadcaster -> validate -> one repair.

The model writes prose only. Authoritative values come from the frozen evidence packet: metrics are
copied from the moment's typed fields, evidence IDs must be a subset of the moment's, and every
number in the prose must already exist in the evidence (agents.validation). Anything else is
rejected; after one repair attempt the caller falls back to the deterministic template.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
import time

from .model import ModelClient, ModelError, ModelTimeout
from .narrate import INSIGHT_SCHEMA_VERSION
from .prompts import PROMPT_VERSION, build_messages
from .validation import validate_insight

AI_LIMITATION = "AI-written from the verified evidence packet; numbers and names were checked in code before publishing."


@dataclass
class WorkflowResult:
    insight: dict | None
    errors: list[str]
    trace: dict = field(default_factory=dict)


class Deadline:
    def __init__(self, seconds: float, clock=time.monotonic):
        self.clock = clock
        self.ends = clock() + seconds

    def remaining(self, cap: float) -> float:
        left = self.ends - self.clock()
        if left <= 0:
            raise ModelTimeout("narration time budget exhausted")
        return min(cap, left)


def _call(client: ModelClient, role: str, messages: list[dict], deadline: Deadline, per_call: float, trace: dict) -> dict:
    started = time.perf_counter()
    try:
        output = client.complete(role, messages, deadline.remaining(per_call))
        trace[role] = {"ms": round((time.perf_counter() - started) * 1000), "keys": sorted(output)}
        usage = client.last_usage() if hasattr(client, "last_usage") else None
        if usage:
            trace[role]["usage"] = usage  # Tokens per role, for cost tracing (bridge trace_report).
        return output
    except ModelError as exc:
        trace[role] = {"ms": round((time.perf_counter() - started) * 1000), "error": type(exc).__name__}
        raise


def _candidate(moment: dict, broadcaster: dict) -> dict:
    """Assemble an insight. Metrics are copied from the evidence, never taken from model text."""
    evidence = broadcaster.get("evidence_ids")
    return {
        "schema_version": INSIGHT_SCHEMA_VERSION, "run_id": moment["run_id"], "match_id": moment["match_id"],
        "moment_id": moment["moment_id"],
        "headline": str(broadcaster.get("headline", "")).strip(),
        "casual_text": str(broadcaster.get("casual_text", "")).strip(),
        "analyst_text": str(broadcaster.get("analyst_text", "")).strip(),
        "language": "en",
        "evidence_ids": evidence if isinstance(evidence, list) and evidence else list(moment["evidence_ids"]),
        "metrics": [dict(metric) for metric in moment["metrics"]],
        "limitations": list(moment["limitations"]) + [AI_LIMITATION],
        "generation_mode": "ai", "knowledge_source_ids": [f"{moment['rule']}-v1"],
    }


def run_workflow(moment: dict, context: dict, client: ModelClient, budget_s: float = 45.0,
                 per_call_s: float = 20.0) -> WorkflowResult:
    """Return a validated AI insight, or (None, errors) when output stayed invalid after one repair.

    ModelTimeout / ModelRateLimited / ModelError propagate so the worker can choose retry_wait or fallback.
    """
    deadline = Deadline(budget_s)
    trace: dict = {"model": client.name, "prompt_version": PROMPT_VERSION}
    with ThreadPoolExecutor(max_workers=2) as pool:
        analyst_future = pool.submit(_call, client, "analyst", build_messages("analyst", moment, context), deadline, per_call_s, trace)
        coach_future = pool.submit(_call, client, "coach", build_messages("coach", moment, context), deadline, per_call_s, trace)
        analyst, coach = analyst_future.result(), coach_future.result()
    approved = {"analyst": analyst, "coach": coach}
    broadcaster = _call(client, "broadcaster", build_messages("broadcaster", moment, context, approved), deadline, per_call_s, trace)
    candidate = _candidate(moment, broadcaster)
    errors = validate_insight(candidate, moment, context)
    if not errors:
        return WorkflowResult(candidate, [], trace)
    # One repair: show the Broadcaster exactly what code rejected; it may only rephrase.
    repair_messages = build_messages("broadcaster", moment, context, {
        **approved, "previous_output": broadcaster,
        "rejected_because": errors[:8],
        "instruction": "Rewrite so that every rejection is fixed. Use only numbers, names and IDs present in the evidence.",
    })
    trace["repair"] = True
    repaired = _call(client, "broadcaster_repair", repair_messages, deadline, per_call_s, trace)
    candidate = _candidate(moment, repaired)
    repaired_errors = validate_insight(candidate, moment, context)
    if not repaired_errors:
        return WorkflowResult(candidate, [], trace)
    return WorkflowResult(None, errors + [f"after repair: {error}" for error in repaired_errors], trace)


def summarize_errors(errors: list[str]) -> str:
    return json.dumps(errors[:5])[:480]
