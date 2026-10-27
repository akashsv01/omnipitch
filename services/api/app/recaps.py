"""Recap service: deterministic halftime/full-time recaps, with an optional AI rewrite of final recaps.

The AI rewrite is explicit (OMNIPITCH_RECAP_AI=on and AZURE_OPENAI_* set), runs once per final recap in a
background thread so requests never wait on the model, and every response reports its status.
"""
from __future__ import annotations

import os
import time
from threading import Lock, Thread

from agents.recap import build_recap, narrate_recap

from .analysis import AWAY, HOME, narration_context

OFF = {"mode": "off", "status": "off", "reason": "OMNIPITCH_RECAP_AI is not on"}


class RecapService:
    def __init__(self, client=None, requested: bool = False, background: bool = True):
        self.client, self.requested, self.background = client, requested, background
        self.enabled = requested and client is not None
        self._lock = Lock()
        self._ai: dict[tuple, tuple[str, dict | None, str | None]] = {}
        self._primed: set[tuple] = set()

    def ai_status(self, key: tuple, recap: dict) -> tuple[dict, dict]:
        if not self.enabled:
            reason = "AZURE_OPENAI_ENDPOINT/DEPLOYMENT not set" if self.requested else OFF["reason"]
            return recap, {"mode": "off", "status": "off", "reason": reason}
        if recap["status"] != "final":
            return recap, {"mode": "on", "status": "waiting", "reason": "AI rewrite runs once the period has ended"}
        with self._lock:
            entry = self._ai.get(key)
            if entry is None:
                self._ai[key] = ("pending", None, None)
                start = True
            else:
                start = False
        if start:
            if self.background:
                Thread(target=self._narrate, args=(key, recap), daemon=True).start()
            else:
                self._narrate(key, recap)
        state, ai_recap, reason = self._ai[key]
        if state == "ready" and ai_recap is not None:
            return ai_recap, {"mode": "on", "status": "ready", "reason": None}
        return recap, {"mode": "on", "status": state, "reason": reason}

    def _narrate(self, key: tuple, recap: dict) -> None:
        context = narration_context([])
        result, reason = narrate_recap(recap, context, HOME["id"], AWAY["id"], self.client)
        with self._lock:
            self._ai[key] = ("ready", result, None) if reason is None else ("fallback", None, reason)

    def recap(self, events: list[dict], moments: list[dict], scope: str, language: str = "en", wait_s: float = 0.0) -> dict | None:
        """Cut off at the revealed prefix: aggregates, key moments, AI facts and cache keys all use the same events."""
        recap = build_recap(events, moments, scope, narration_context([]), HOME["id"], AWAY["id"], language)
        if recap is None:
            return None
        # Cut off and keyed by run, scope, cutoff, status and language: a Spanish rewrite never stands in for English.
        key = (recap["run_id"], scope, recap["through_sequence"], recap["status"], language)
        template = recap
        recap, ai = self.ai_status(key, template)
        # A narrated recap may wait briefly for its AI rewrite so the spoken and shown versions are the same one.
        deadline = time.monotonic() + wait_s
        while ai["status"] == "pending" and time.monotonic() < deadline:
            time.sleep(0.25)
            recap, ai = self.ai_status(key, template)
        return {"recap": recap, "ai": ai}

    def unprimed(self, ends: list[tuple[str, int, int]]) -> bool:
        scopes = {1: "first_half", 2: "full_time"}
        with self._lock:
            return any((run, scopes[period], sequence) not in self._primed for run, period, sequence in ends)

    def prime(self, events: list[dict], moments: list[dict]) -> list[str]:
        """Create each period's final recap as soon as its period_end is revealed (and start the AI rewrite when
        enabled), so half-time and full-time summaries exist without anyone opening the Recap tab."""
        started = []
        for scope, period in (("first_half", 1), ("full_time", 2)):
            end = next((e for e in events if e["type"] == "period_end" and e["period"] == period), None)
            if end is None:
                continue
            key = (end["run_id"], scope, end["sequence"])
            with self._lock:
                if key in self._primed:
                    continue
                self._primed.add(key)
            # The recap covers events up to and including this period_end, never later ones.
            for language in ("en", "es"):
                self.recap([e for e in events if e["sequence"] <= end["sequence"]], moments, scope, language)
            started.append(scope)
        return started


def from_env() -> RecapService:
    if os.getenv("OMNIPITCH_RECAP_AI", "off").strip().lower() != "on":
        return RecapService()
    from agents.model import AzureOpenAIClient, AzureOpenAIConfig
    config = AzureOpenAIConfig.from_env()
    return RecapService(AzureOpenAIClient(config) if config else None, requested=True)
