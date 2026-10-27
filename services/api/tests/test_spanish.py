"""Server-side Spanish: the same numbers as English, names kept, translations accepted only when they keep the facts."""
import re

from agents.narrate import build_fallback_insight
from agents.narrate_es import check_translation, story_es, translate_insight
from app.translations import TranslationService

from test_narration import context_for, moments_for_test

DIGITS = re.compile(r"\d+(?:[.,]\d+)?")


def digits(text):
    return sorted(d.replace(",", ".") for d in DIGITS.findall(text.replace("'", " ")))


def test_spanish_template_states_the_same_numbers_for_every_rule():
    moments = moments_for_test()
    assert {m["rule"] for m in moments} >= {"goal", "chance", "threat_gain", "transition", "pressing_change"} - {"goal"}
    for moment in moments:
        en, es = build_fallback_insight(moment, context_for(moment)), story_es(moment, context_for(moment))
        for field in ("casual_text", "analyst_text"):
            assert digits(en[field]) == digits(es[field]), (moment["rule"], field, en[field], es[field])
        assert "v1" not in es["analyst_text"] and "grid" not in es["analyst_text"]


class Translator:
    name = "fake"

    def __init__(self, change=None):
        self.change = change

    def complete(self, role, messages, timeout):
        import json
        english = json.loads(messages[-1]["content"])
        out = {k: f"ES: {v}".replace(".", ",") for k, v in english.items()}
        return self.change(out) if self.change else out


def ai_moment():
    moment = next(m for m in moments_for_test() if m["rule"] == "transition")
    insight = {**build_fallback_insight(moment, context_for(moment)), "generation_mode": "ai", "generation_status": "ai_accepted"}
    return {**moment, "insight": insight}


def test_ai_translation_is_accepted_only_when_it_keeps_the_facts():
    moment = ai_moment()
    good, reason = translate_insight(moment["insight"], context_for(moment), Translator())
    assert reason is None and good["casual_text"].startswith("ES:")
    bad, reason = translate_insight(moment["insight"], context_for(moment), Translator(lambda o: {**o, "casual_text": o["casual_text"] + " 99 m"}))
    assert bad is None and "numbers differ" in reason
    assert check_translation({"headline": "A", "casual_text": "Kofi Adeyemi", "analyst_text": "x"},
                             {"headline": "A", "casual_text": "otro", "analyst_text": "x"}, context_for(moment))


def test_service_translates_ai_text_and_falls_back_with_status():
    moment = ai_moment()
    ok = TranslationService(Translator(), background=False).spanish(moment, context_for(moment))
    assert ok["generation_status"] == "ai_accepted"
    off = TranslationService().spanish(moment, context_for(moment))
    assert off["generation_status"] == "skipped" and off["headline"] == story_es(moment, context_for(moment))["headline"]
    rejected = TranslationService(Translator(lambda o: {**o, "headline": "1 2 3"}), background=False).spanish(moment, context_for(moment))
    assert rejected["generation_status"] == "rejected"


def test_spanish_meaning_checks_reject_unsupported_claims():
    moment = ai_moment()
    english = {k: moment["insight"][k] for k in ("headline", "casual_text", "analyst_text")}
    for headline, reason in (("Harbor Comets rompen la defensa tras ganar el balón", "defender breach"),
                             ("Harbor Comets rompen al ataque", "defender breach"), ("Harbor Comets dominan", "judgement")):
        assert any(reason in e for e in check_translation(english, {**english, "headline": headline}, context_for(moment))), headline
