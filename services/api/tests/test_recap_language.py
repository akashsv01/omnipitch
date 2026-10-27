"""Recaps in English and Spanish from one cutoff, created automatically when a period ends."""
import re

from fastapi.testclient import TestClient

from agents.recap import build_recap
from app import main, replay as replay_module
from app.analysis import AWAY, HOME, narration_context
from app.recaps import RecapService

from test_phase4 import first_period_end, make_store, schema_validator, seek_to_sequence

DIGITS = re.compile(r"\d+")


def both(store, scope):
    events, moments = store.recap_inputs()
    return [build_recap(events, moments, scope, narration_context([]), HOME["id"], AWAY["id"], lang) for lang in ("en", "es")]


def test_spanish_recap_keeps_names_scores_and_numbers():
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    en, es = both(store, "first_half")
    validate = schema_validator("recap")
    validate.validate(en), validate.validate(es)
    assert (en["language"], es["language"]) == ("en", "es")
    # Same facts: score, cutoff, key moments, and the same digits in the same order in the summary.
    for field in ("score", "through_sequence", "key_moments", "status", "sources"):
        assert en[field] == es[field]
    assert DIGITS.findall(en["summary"]) == DIGITS.findall(es["summary"])
    for team in ("Harbor Comets", "Vale Owls"):
        assert (team in en["summary"]) == (team in es["summary"])  # Names are never translated.
    assert "al descanso" in es["summary"] and "tiro" in es["summary"]
    assert not re.search(r"pressed more intensely|presionó más", en["tactical_trend"]["text"] + es["tactical_trend"]["text"])


def test_recaps_are_created_when_each_period_ends(monkeypatch):
    store, _ = make_store()
    service = RecapService()
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_recaps", service)
    client = TestClient(main.app)
    end = first_period_end(store)
    seek_to_sequence(store, end - 20)
    client.get("/api/v1/replay")
    assert service._primed == set()  # Nothing is final yet.
    seek_to_sequence(store, end)
    client.get("/api/v1/replay")
    assert (store.state.run_id, "first_half", end) in service._primed
    client.get("/api/v1/replay")
    assert len(service._primed) == 1  # Idempotent: one recap per period end.
    body = client.get("/api/v1/replay/recap", params={"scope": "first_half", "lang": "es"}).json()
    assert body["recap"]["language"] == "es" and body["ai"]["status"] == "off"  # AI rewrite off in this test service
    assert client.get("/api/v1/replay/recap", params={"scope": "first_half", "lang": "fr"}).status_code == 422


def test_a_recap_never_includes_events_after_its_cutoff():
    store, _ = make_store()
    end = first_period_end(store)
    seek_to_sequence(store, end + 120)
    later = both(store, "full_time")[0]
    seek_to_sequence(store, end - 40)       # Backwards: the earlier state must not show later facts.
    earlier = both(store, "first_half")[0]
    assert earlier["through_sequence"] <= end - 40 + 1 < later["through_sequence"]
    assert all(k["source_sequence"] <= earlier["through_sequence"] for k in earlier["key_moments"])
    assert earlier["status"] == "provisional"


def test_recap_rewrite_rejects_judgements_and_reads_spanish_decimals():
    from agents.recap import validate_recap_text
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    en, es = both(store, "first_half")
    context = narration_context([])
    assert any("judgement" in e for e in validate_recap_text("Vale lead after dominating shots", en["summary"], en, context, HOME["id"], AWAY["id"]))
    assert validate_recap_text(es["headline"], es["summary"], es, context, HOME["id"], AWAY["id"]) == []
    passes = next(m["value"] for m in en["player_focus"]["metrics"] if m["name"] == "passes_completed")
    name = en["player_focus"]["name"]
    assert validate_recap_text(en["headline"], f"{name} completed {passes:g} passes.", en, context, HOME["id"], AWAY["id"]) == []
    assert validate_recap_text(en["headline"], "A three-pass move led to the goal.", en, context, HOME["id"], AWAY["id"])
