"""Live commentary: server-composed lines, cut off at the replay position, with narrated recaps at real period ends."""
from urllib.parse import unquote

from fastapi.testclient import TestClient

from app import main, replay as replay_module
from app.commentary import speakable
from app.recaps import RecapService
from app.speech import SpeechService

from test_phase4 import first_period_end, make_store, seek_to_sequence


class FakeSpeech:
    def __init__(self):
        self.spoken = []

    def __call__(self, ssml, output_format):
        self.spoken.append(ssml)
        return b"ID3-fake"


def setup(monkeypatch, upto):
    store, _ = make_store()
    seek_to_sequence(store, upto)
    synth = FakeSpeech()
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_speech", SpeechService(synth))
    monkeypatch.setattr(main, "_recaps", RecapService())
    return TestClient(main.app), store, synth


def lines(client, store, after=0, **params):
    return client.get("/api/v1/commentary/lines", params={"run_id": store.state.run_id, "after": after, **params}).json()


def test_lines_follow_the_replay_and_never_run_ahead(monkeypatch):
    client, store, _ = setup(monkeypatch, 200)
    body = lines(client, store)
    assert body["lines"][0]["kind"] == "period_start" and body["lines"][0]["text"].startswith("Kick-off")
    assert all(line["sequence"] <= store.state.latest_event_sequence for line in body["lines"])
    assert not any(line["kind"] == "period_end" for line in body["lines"])
    later = lines(client, store, after=body["through"])
    assert later["lines"] == []  # Nothing new until the replay moves on.
    goals = [e for e in store.dicts if e["type"] == "shot" and e.get("is_goal")]
    seek_to_sequence(store, goals[0]["sequence"])
    goal_line = next(l for l in lines(client, store)["lines"] if l["kind"] == "shot" and "Goal" in l["text"])
    # The score in a goal line is the score at that goal, not the final one.
    assert goal_line["text"].endswith("Harbor Comets 0, Vale Owls 1.") or goal_line["text"].endswith("Harbor Comets 1, Vale Owls 0.")
    assert lines(client, store, after=0, run_id="another-run")["stale"] is True


def test_spanish_and_analyst_lines(monkeypatch):
    client, store, _ = setup(monkeypatch, 600)
    es = lines(client, store, lang="es")["lines"]
    assert es[0]["text"].startswith("¡Comienza el partido!")
    analyst = [l for l in lines(client, store, audience="analyst")["lines"] if l["kind"] == "shot"]
    assert analyst and all(" m" in l["text"] for l in analyst)  # Analysts hear the measurement the event supports.


def test_audio_is_composed_from_references_and_cut_off(monkeypatch):
    client, store, synth = setup(monkeypatch, 200)
    first = lines(client, store)["lines"][0]
    response = client.post("/api/v1/commentary/audio", json={"run_id": store.state.run_id, "ref": first["ref"], "audience": "fan", "language": "en"})
    assert response.status_code == 200 and unquote(response.headers["x-caption"]) == first["text"]
    future = next(e for e in store.dicts if e["sequence"] > 400 and e["type"] == "shot")
    assert client.post("/api/v1/commentary/audio", json={"run_id": store.state.run_id, "ref": f"event:{future['event_id']}",
                                                         "audience": "fan", "language": "en"}).status_code == 404
    # A recap is narrated only once its half has actually ended, never because playback stopped.
    assert client.post("/api/v1/commentary/audio", json={"run_id": store.state.run_id, "ref": "recap:first_half",
                                                         "audience": "fan", "language": "en"}).status_code == 404
    seek_to_sequence(store, first_period_end(store))
    recap = client.post("/api/v1/commentary/audio", json={"run_id": store.state.run_id, "ref": "recap:first_half", "audience": "fan", "language": "es"})
    assert recap.status_code == 200 and "al descanso" in unquote(recap.headers["x-caption"])
    assert client.post("/api/v1/commentary/audio", json={"run_id": "old-run", "ref": first["ref"], "audience": "fan", "language": "en"}).status_code == 409


def test_speakable_reads_minutes_metres_and_scores():
    assert speakable("Goal at 45+2': shot from 14 m. Score 1-0.", "en") == "Goal at minute 45 plus 2: shot from 14 metres. Score 1 to 0."
    assert speakable("Gol en el 25': 12,5 m en 4,5 s.", "es") == "Gol en el minuto 25: 12,5 metros en 4,5 segundos."


def test_wording_varies_but_is_stable_per_event(monkeypatch):
    client, store, _ = setup(monkeypatch, 1100)
    first = lines(client, store)["lines"]
    again = lines(client, store)["lines"]
    assert [l["text"] for l in first] == [l["text"] for l in again]  # Same event, same words: caption and audio match.
    shots = [l["text"] for l in first if l["kind"] == "shot"]
    names = {p["name"] for p in __import__("app.sample_data", fromlist=["roster"]).roster()}

    def shape(text):
        for name in sorted(names, key=len, reverse=True):
            text = text.replace(name, "P").replace(name.split(" ")[-1], "P")
        return text.split(".")[0]
    assert len({shape(t) for t in shots}) >= 5  # Not one sentence per outcome any more.
    kinds = {l["kind"] for l in first}
    assert {"foul", "pass"} <= kinds  # Fouls and passing play fill the gaps between shots.
    es = lines(client, store, lang="es")["lines"]
    assert any(l["kind"] == "foul" and "falta" in l["text"].lower() for l in es)


def test_brief_moment_lines_keep_only_the_headline(monkeypatch):
    # Fast replays read a moment's headline only, so the line ends before the match has moved on.
    client, store, _ = setup(monkeypatch, 600)
    full = {l["ref"]: l["text"] for l in lines(client, store)["lines"] if l["ref"].startswith("moment:")}
    brief = {l["ref"]: l["text"] for l in lines(client, store, brief="true")["lines"] if l["ref"].startswith("moment:")}
    assert full and full.keys() == brief.keys()
    for ref, text in brief.items():
        assert full[ref].startswith(text) and len(text) < len(full[ref]) and text.count(". ") == 0
    ref = next(iter(brief))
    response = client.post("/api/v1/commentary/audio", json={"run_id": store.state.run_id, "ref": ref, "audience": "fan", "language": "en", "brief": True})
    assert response.status_code == 200 and unquote(response.headers["x-caption"]) == brief[ref]
