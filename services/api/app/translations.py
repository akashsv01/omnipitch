"""Spanish for every insight in the snapshot (`insight.translations.es`).

Rule-based insights get the server's Spanish template (agents.narrate_es.story_es) from the same frozen moment.
Accepted AI text gets a model translation in a background thread, accepted only if it keeps the English numbers and
names exactly; until then, or if it fails, the Spanish template stands in and the status says so. Translations are
cached by moment and English text, so a revised AI text is translated again and nothing stale is reused.
"""
from __future__ import annotations

import hashlib
import os
from threading import Lock, Thread

from agents.narrate_es import story_es, translate_insight


class TranslationService:
    def __init__(self, client=None, background: bool = True):
        self.client, self.background = client, background
        self._lock = Lock()
        self._cache: dict[str, tuple[str, dict | None, str | None]] = {}
        self.calls = 0

    @staticmethod
    def _key(moment: dict) -> str:
        insight = moment["insight"]
        text = "|".join(insight[k] for k in ("headline", "casual_text", "analyst_text"))
        return f"{moment['moment_id']}:{hashlib.sha256(text.encode()).hexdigest()[:16]}"

    def spanish(self, moment: dict, context: dict) -> dict:
        insight = moment["insight"]
        template = {**story_es({k: v for k, v in moment.items() if k != "insight"}, context)}
        if insight["generation_mode"] != "ai":
            return {**template, "generation_status": insight.get("generation_status") or "rule_based"}
        if self.client is None:
            return {**template, "generation_status": "skipped", "generation_reason": "AI translation is not configured"}
        key = self._key(moment)
        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                self._cache[key] = ("pending", None, None)
        if entry is None:
            if self.background:
                Thread(target=self._translate, args=(key, insight, context), daemon=True).start()
            else:
                self._translate(key, insight, context)
            entry = self._cache[key]
        state, spanish, reason = entry
        if state == "ready" and spanish:
            return {**spanish, "generation_status": "ai_accepted"}
        status = "pending" if state == "pending" else "rejected" if reason and "rejected" in reason else "provider_failure"
        return {**template, "generation_status": status, "generation_reason": reason}

    def _translate(self, key: str, insight: dict, context: dict) -> None:
        spanish, reason = translate_insight(insight, context, self.client)
        self.calls += 1
        with self._lock:
            self._cache[key] = ("ready", spanish, None) if spanish else ("failed", None, reason)

    def attach(self, moments: list[dict], context: dict) -> list[dict]:
        return [{**m, "insight": {**m["insight"], "translations": {"es": self.spanish(m, context)}}} for m in moments]


def from_env() -> TranslationService:
    """AI translation uses the narration model settings (AZURE_OPENAI_*); without them, Spanish is rule-based."""
    if os.getenv("OMNIPITCH_TRANSLATE", "on").strip().lower() == "off":
        return TranslationService()
    try:
        from agents.model import AzureOpenAIClient, AzureOpenAIConfig
        config = AzureOpenAIConfig.from_env()
        return TranslationService(AzureOpenAIClient(config) if config else None)
    except Exception:  # noqa: BLE001  (missing Azure packages: Spanish stays rule-based)
        return TranslationService()
