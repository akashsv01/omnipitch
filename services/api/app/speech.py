"""Optional narration audio through Azure AI Speech, called from the server only.

Only accepted text is spoken: English is composed here from the moment's own validated insight (headline plus the
fan or analyst text); Spanish is the browser's rule-based translation of the same insight, accepted only when every
number in it belongs to the moment's evidence (the insight validator's allowed numbers). Audio is cached by
(text, language, voice, format), so replaying a moment never synthesizes twice. Credentials never reach the browser:
the server gets an Entra ID token for the Speech resource (role Cognitive Services Speech User) and sends
`Bearer aad#<resource id>#<token>` to the regional text-to-speech endpoint.

Configuration (services/api/.env): SPEECH_REGION and SPEECH_RESOURCE_ID, optional SPEECH_VOICE_EN / SPEECH_VOICE_ES.
Without them the service reports `speech_not_configured` and the browser keeps the full text and caption experience.
"""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import os
import re
from threading import Lock
from typing import Callable
from xml.sax.saxutils import escape

from agents.validation import _allowed_numbers

OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3"
DEFAULT_VOICES = {"en": "en-GB-RyanNeural", "es": "es-ES-AlvaroNeural"}
MAX_CHARS = 600
NUMBER = re.compile(r"(?<![\w.,])\d+(?:[.,]\d+)?")


class SpeechError(Exception):
    def __init__(self, code: str, message: str, status: int):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def spoken_text(moment: dict, audience: str) -> str:
    """The accepted English text for a moment: what the match room shows, nothing else."""
    insight = moment["insight"]
    body = insight["casual_text"] if audience == "fan" else insight["analyst_text"]
    return f"{insight['headline']}. {body}"


def check_translation(text: str, moment: dict) -> list[str]:
    """A translation may restate the moment's numbers (with a decimal comma) but may not add any."""
    allowed = _allowed_numbers(moment)
    errors = [f"number {n!r} is not in this moment's evidence" for n in NUMBER.findall(text) if n.replace(",", ".") not in allowed]
    if len(text) > MAX_CHARS:
        errors.append(f"text longer than {MAX_CHARS} characters")
    return errors


class SpeechService:
    def __init__(self, synthesize: Callable[[str, str], bytes] | None, voices: dict[str, str] | None = None,
                 reason: str | None = None, cache_size: int = 256):
        self.synthesize, self.voices = synthesize, voices or dict(DEFAULT_VOICES)
        self.reason = reason if synthesize is None else None
        self.cache: OrderedDict[str, bytes] = OrderedDict()
        self.cache_size, self.lock = cache_size, Lock()
        self.calls = 0

    def status(self) -> dict:
        return {"configured": self.synthesize is not None, "reason": self.reason,
                "voices": self.voices if self.synthesize else {}, "format": OUTPUT_FORMAT}

    def audio(self, text: str, language: str, rate: str | None = None) -> tuple[bytes, str]:
        """MP3 for text; `rate` (for example "+12%") speeds live commentary up, recaps keep the voice's own pace."""
        if self.synthesize is None:
            raise SpeechError("speech_not_configured", self.reason or "Azure Speech is not configured.", 503)
        voice = self.voices[language]
        key = hashlib.sha256(f"{voice}|{language}|{OUTPUT_FORMAT}|{rate or ''}|{text}".encode()).hexdigest()
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key], key
        body = escape(text) if not rate else f"<prosody rate='{escape(rate)}'>{escape(text)}</prosody>"
        ssml = (f"<speak version='1.0' xml:lang='{'es-ES' if language == 'es' else 'en-GB'}'>"
                f"<voice name='{voice}'>{body}</voice></speak>")
        try:
            audio = self.synthesize(ssml, OUTPUT_FORMAT)
        except SpeechError:
            raise
        except Exception as exc:  # Network, auth or service errors: reported, never replaced with silence.
            raise SpeechError("speech_failed", f"{type(exc).__name__}: {str(exc)[:160]}", 502) from exc
        self.calls += 1
        with self.lock:
            self.cache[key] = audio
            while len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
        return audio, key


def from_env() -> SpeechService:
    region, resource = os.getenv("SPEECH_REGION", "").strip(), os.getenv("SPEECH_RESOURCE_ID", "").strip()
    voices = {"en": os.getenv("SPEECH_VOICE_EN", DEFAULT_VOICES["en"]), "es": os.getenv("SPEECH_VOICE_ES", DEFAULT_VOICES["es"])}
    if not region or not resource.startswith("/subscriptions/"):
        return SpeechService(None, voices, reason="SPEECH_REGION and SPEECH_RESOURCE_ID are not set on the server.")
    try:
        from azure.identity import DefaultAzureCredential
        import httpx
    except ImportError as exc:
        return SpeechService(None, voices, reason=f"Azure packages missing: {exc.name}")
    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"

    def synthesize(ssml: str, output_format: str) -> bytes:
        token = credential.get_token("https://cognitiveservices.azure.com/.default").token
        response = httpx.post(url, content=ssml.encode("utf-8"), timeout=15.0, headers={
            "Authorization": f"Bearer aad#{resource}#{token}", "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": output_format, "User-Agent": "omnipitch-api"})
        if response.status_code != 200:
            raise SpeechError("speech_failed", f"Speech service returned {response.status_code}", 502)
        return response.content

    return SpeechService(synthesize, voices)
