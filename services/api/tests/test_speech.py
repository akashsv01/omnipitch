"""Narration audio: accepted text only, cached, cutoff-safe, explicit when Azure Speech is not configured."""
from fastapi.testclient import TestClient

from app import main, replay as replay_module
from app.speech import SpeechService, check_translation, spoken_text

from test_phase4 import first_period_end, make_store, seek_to_sequence


class FakeSpeech:
    def __init__(self):
        self.ssml = []

    def __call__(self, ssml, output_format):
        self.ssml.append(ssml)
        return b"ID3-fake-mp3"


def setup(monkeypatch, synth=None):
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store))
    service = SpeechService(synth) if synth else SpeechService(None, reason="SPEECH_REGION and SPEECH_RESOURCE_ID are not set on the server.")
    monkeypatch.setattr(replay_module, "replay_store", store)
    monkeypatch.setattr(main, "_speech", service)
    moment = store.snapshot().moments[0].model_dump(mode="json")
    return TestClient(main.app), store, service, moment


def test_not_configured_is_explicit(monkeypatch):
    client, _, _, moment = setup(monkeypatch)
    assert client.get("/api/v1/speech/status").json()["configured"] is False
    response = client.post("/api/v1/speech/moment", json={"moment_id": moment["moment_id"], "audience": "fan", "language": "en"})
    assert response.status_code == 503 and response.json()["detail"]["code"] == "speech_not_configured"


def test_english_is_the_accepted_text_and_is_cached(monkeypatch):
    synth = FakeSpeech()
    client, _, service, moment = setup(monkeypatch, synth)
    body = {"moment_id": moment["moment_id"], "audience": "fan", "language": "en", "text": "Ignored: anything a client sends."}
    first = client.post("/api/v1/speech/moment", json=body)
    second = client.post("/api/v1/speech/moment", json=body)
    assert first.status_code == 200 and first.headers["content-type"] == "audio/mpeg"
    assert first.content == second.content and service.calls == 1  # Same text, language and voice: synthesized once.
    assert "Ignored" not in synth.ssml[0] and moment["insight"]["headline"] in synth.ssml[0].replace("&amp;", "&")
    client.post("/api/v1/speech/moment", json={**body, "audience": "analyst"})
    assert service.calls == 2  # Different accepted text, new synthesis.


def test_spanish_is_composed_on_the_server_and_client_text_is_ignored(monkeypatch):
    synth = FakeSpeech()
    client, _, _, moment = setup(monkeypatch, synth)
    response = client.post("/api/v1/speech/moment", json={"moment_id": moment["moment_id"], "audience": "fan", "language": "es",
                                                          "text": "Un pase de 987 metros."})
    assert response.status_code == 200
    assert "987" not in synth.ssml[-1] and "es-ES" in synth.ssml[-1]
    from urllib.parse import unquote
    assert unquote(response.headers["x-caption"]).startswith(moment["insight"]["translations"]["es"]["headline"])
    assert check_translation("Un avance de 12,5 m.", {**moment, "metrics": [{"name": "x", "value": 12.5, "unit": "m"}]}) == []


def test_future_moments_are_never_narrated(monkeypatch):
    client, store, _, moment = setup(monkeypatch, FakeSpeech())
    seek_to_sequence(store, moment["source_sequence"] - 1 if moment["source_sequence"] > 1 else 1)
    response = client.post("/api/v1/speech/moment", json={"moment_id": moment["moment_id"], "audience": "fan", "language": "en"})
    assert response.status_code == 404 and response.json()["detail"]["code"] == "moment_not_available"
