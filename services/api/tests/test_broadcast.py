"""Server-side playout: shared by every screen, cut off by evidence, goals first, stale dropped, revised in place."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app import main, replay as replay_module
from app.broadcast import STALE_AFTER_MATCH_MS, Channel, cue_for

from test_narration import context_for, moments_for_test
from test_phase4 import first_period_end, make_store, seek_to_sequence
from agents.narrate import build_fallback_insight

CUE = Draft202012Validator(json.loads((Path(__file__).resolve().parents[3] / "contracts/schemas/broadcast-cue.schema.json").read_text(encoding="utf-8")))


def moment(rule, seq, replay_ms, mode="fallback"):
    base = next(m for m in moments_for_test() if m["rule"] == rule)
    insight = {**build_fallback_insight(base, context_for(base)), "generation_mode": mode,
               "generation_status": "ai_accepted" if mode == "ai" else "rule_based"}
    return {**base, "moment_id": f"{base['moment_id']}-{seq}", "source_sequence": seq, "replay_ms": replay_ms, "insight": insight}


def test_cues_match_the_contract_in_both_languages():
    m = moment("transition", 10, 60000)
    for audience in ("fan", "analyst"):
        for language in ("en", "es"):
            cue = cue_for(m, audience, language)
            assert not list(CUE.iter_errors(cue)), list(CUE.iter_errors(cue))[:1]
    assert cue_for(m, "fan", "es")["measurements"][0]["value"].count(".") == 0


def test_scheduling_rules():
    a, b, g = (cue_for(moment(r, s, t), "fan", "en") for r, s, t in (("threat_gain", 10, 60000), ("transition", 20, 70000), ("chance", 25, 75000)))
    g = {**g, "kind": "major", "priority": 100}
    ch = Channel()
    ch.advance([a, b, g], "r1", 5, 30000, 0.0)
    assert ch.current is None                                    # not before the evidence cutoff
    ch.advance([a, b, g], "r1", 21, 70500, 1.0)
    assert ch.current["cue"]["message_id"] == b["message_id"]    # one at a time
    ch.advance([a, b, g], "r1", 25, 75100, 2.0)
    assert ch.current["cue"]["kind"] == "major"                  # the goal pre-empts
    ch.advance([a, b, g], "r1", 25, 75100, 2.0 + g["display_ms"] / 1000)
    assert ch.current is None or ch.current["cue"]["message_id"] != g["message_id"]
    late = Channel()
    late.advance([a], "r1", 30, 60000 + STALE_AFTER_MATCH_MS + 1, 0.0)
    assert late.current is None                                  # stale cues never air late
    rev = Channel()
    rev.advance([a], "r1", 10, 60000, 0.0)
    upgraded = cue_for(moment("threat_gain", 10, 60000, "ai"), "fan", "en")
    rev.advance([upgraded], "r1", 10, 61000, 0.5)
    assert (rev.current["cue"]["revision"], rev.current["shown_at"]) == (2, 0.0)  # revised in place
    ch.advance([a, b, g], "r1", 15, 65000, 20.0)
    assert ch.current is None and ch.queue([a, b, g], 15, 65000) == []          # a seek back clears, nothing floods back


def test_every_screen_gets_the_same_playout(monkeypatch):
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_playouts", {})
    client = TestClient(main.app)
    one = client.get("/api/v1/broadcast", params={"audience": "fan", "lang": "es"}).json()
    two = client.get("/api/v1/broadcast", params={"audience": "fan", "lang": "es"}).json()
    assert one["on_air"] and one["on_air"]["message_id"] == two["on_air"]["message_id"]
    assert one["on_air"]["language"] == "es" and one["schema_version"] == "broadcast-feed-1.0"
    assert not list(CUE.iter_errors(one["on_air"]))
