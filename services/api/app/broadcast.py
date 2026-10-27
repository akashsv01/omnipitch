"""Server-side broadcast playout (contract broadcast-cue-1.0, feed broadcast-feed-1.0).

One playout per (audience, language) channel, shared by every overlay and producer that asks for it, so all screens
show the same cue at the same time. Cues come from verified moments and their accepted text (English, or the server's
Spanish). Scheduling rules:
- a cue airs only once the replay has reached its evidence cutoff (match time places the claim);
- one cue is on air at a time, for display_ms of server wall-clock time;
- a major cue (goal) pre-empts a standard one;
- a cue more than stale_after_match_ms of match time behind the replay is dropped, never aired late;
- a rule-based cue that gains accepted AI text is revised in place (same message_id, revision 2) while on air or queued;
- a backward seek or a new run clears the air and the queue; nothing earlier floods back.
"""
from __future__ import annotations

from threading import Lock
from time import monotonic

from agents.narrate import clock_label

from .commentary import moment_line

PRIORITY = {"goal": 100, "chance": 80, "transition": 60, "pressing_change": 45, "threat_gain": 25}
STALE_AFTER_MATCH_MS = 3 * 60_000
LABELS = {
    "en": {"shot_distance": "Shot distance", "forward_progress": "Forward progression", "pass_distance": "Pass length",
           "elapsed": "Sequence time", "ppda": "PPDA", "previous_ppda": "Previous PPDA"},
    "es": {"shot_distance": "Distancia del disparo", "forward_progress": "Progresión", "pass_distance": "Longitud del pase",
           "elapsed": "Tiempo de la secuencia", "ppda": "PPDA", "previous_ppda": "PPDA anterior"},
}
SHOWN = {"goal": ["shot_distance"], "chance": ["shot_distance"], "threat_gain": ["forward_progress", "pass_distance"],
         "transition": ["forward_progress", "elapsed"], "pressing_change": ["ppda", "previous_ppda"]}


def _value(name: str, value: float, language: str) -> str:
    text = f"{value:g}" if name in ("ppda", "previous_ppda") or value == int(value) else f"{value:.1f}".rstrip("0").rstrip(".")
    return text.replace(".", ",") if language == "es" else text


def cue_for(moment: dict, audience: str, language: str) -> dict:
    insight = moment["insight"]
    status = insight.get("generation_status") or ("ai_accepted" if insight["generation_mode"] == "ai" else "rule_based")
    spanish = (insight.get("translations") or {}).get("es") if language == "es" else None
    headline = spanish["headline"] if spanish else insight["headline"]
    text = moment_line(moment, audience, language)[len(headline) + 2:]
    ai = status == "ai_accepted" and (language == "en" or (spanish or {}).get("generation_status") == "ai_accepted")
    metrics = {m["name"]: m for m in moment["metrics"]}
    shown = [n for n in SHOWN[moment["rule"]] if n in metrics][: 2 if audience == "fan" else 3]
    if audience == "fan":
        shown = [n for n in shown if n not in ("ppda", "previous_ppda")][:2]
    return {
        "schema_version": "broadcast-cue-1.0",
        "message_id": f"{moment['run_id']}:{moment['moment_id']}:{audience}:{language}",
        "revision": 2 if ai else 1, "revision_reason": "ai_accepted" if ai else "template",
        "run_id": moment["run_id"], "match_id": moment["match_id"], "moment_id": moment["moment_id"], "rule": moment["rule"],
        "kind": "major" if moment["rule"] == "goal" else "standard",
        "match_clock": {"period": moment["period"], "match_time_ms": moment["match_time_ms"], "label": clock_label(moment["period"], moment["match_time_ms"])},
        "replay_ms": int(moment.get("replay_ms", 0)), "evidence_cutoff_sequence": moment["source_sequence"],
        "source_ids": list(moment["evidence_ids"]), "audience": audience, "language": language,
        "headline": headline[:120], "text": text[:400],
        "measurements": [{"label": LABELS[language][n], "value": _value(n, metrics[n]["value"], language),
                          **({"unit": metrics[n]["unit"]} if metrics[n]["unit"] in ("m", "s") else {})} for n in shown],
        "priority": PRIORITY[moment["rule"]], "display_ms": 9000 if moment["rule"] == "goal" else 6500,
        "stale_after_match_ms": STALE_AFTER_MATCH_MS, "generation_status": status,
        "validation": "passed" if ai else "not_applicable", "synthetic": True,
    }


class Channel:
    def __init__(self):
        self.run_id: str | None = None
        self.seq = 0
        self.current: dict | None = None
        self.done: set[str] = set()
        self.log: list[dict] = []

    def _note(self, cue: dict, event: str, at: float) -> None:
        self.log = (self.log + [{"at_ms": int(at * 1000), "message_id": cue["message_id"], "clock": cue["match_clock"]["label"],
                                 "headline": cue["headline"], "event": event, "revision": cue["revision"]}])[-40:]

    def advance(self, cues: list[dict], run_id: str, seq: int, replay_ms: int, now: float) -> None:
        stale = lambda cue: replay_ms - cue["replay_ms"] > cue["stale_after_match_ms"]  # noqa: E731
        reached = lambda cue: cue["evidence_cutoff_sequence"] <= seq  # noqa: E731
        new_run = run_id != self.run_id
        if new_run or seq < self.seq:
            if self.current:
                self._note(self.current["cue"], "reset", now)
            self.current = None
            self.done = {c["message_id"] for c in cues if reached(c) and (stale(c) or not new_run)}
            self.run_id = run_id
        self.seq = seq
        if self.current:
            latest = next((c for c in cues if c["message_id"] == self.current["cue"]["message_id"]), None)
            if latest is None:
                self.current = None
            else:
                if latest["revision"] > self.current["cue"]["revision"]:
                    self.current["cue"] = latest
                    self._note(latest, "revised", now)
                if (now - self.current["shown_at"]) * 1000 >= self.current["cue"]["display_ms"]:
                    self._note(self.current["cue"], "expired", now)
                    self.current = None
                elif stale(self.current["cue"]):
                    self._note(self.current["cue"], "stale", now)
                    self.current = None
        candidates = [c for c in cues if reached(c) and c["message_id"] not in self.done]
        for cue in candidates:
            if stale(cue):
                self.done.add(cue["message_id"])
                self._note(cue, "stale", now)
        ready = sorted((c for c in candidates if not stale(c)), key=lambda c: (-c["priority"], -c["replay_ms"]))
        if ready and self.current and ready[0]["kind"] == "major" and self.current["cue"]["kind"] != "major":
            self._note(self.current["cue"], "preempted", now)
            self.current = None
        if ready and not self.current:
            self.current = {"cue": ready[0], "shown_at": now}
            self.done.add(ready[0]["message_id"])
            self._note(ready[0], "shown", now)

    def queue(self, cues: list[dict], seq: int, replay_ms: int) -> list[dict]:
        return sorted((c for c in cues if c["evidence_cutoff_sequence"] <= seq and c["message_id"] not in self.done
                       and replay_ms - c["replay_ms"] <= c["stale_after_match_ms"]), key=lambda c: (-c["priority"], -c["replay_ms"]))


class Playout:
    def __init__(self, clock=monotonic):
        self.clock = clock
        self.channels: dict[tuple[str, str], Channel] = {}
        self.lock = Lock()

    def feed(self, moments: list[dict], run_id: str, seq: int, replay_ms: int, clock: str, audience: str, language: str) -> dict:
        cues = [cue_for(m, audience, language) for m in moments]
        with self.lock:
            channel = self.channels.setdefault((audience, language), Channel())
            channel.advance(cues, run_id, seq, replay_ms, self.clock())
            on_air = channel.current
            return {"schema_version": "broadcast-feed-1.0", "run_id": run_id, "audience": audience, "language": language,
                    "position": {"sequence": seq, "replay_ms": replay_ms, "clock": clock},
                    "on_air": on_air["cue"] if on_air else None,
                    "on_air_for_ms": int((self.clock() - on_air["shown_at"]) * 1000) if on_air else None,
                    "queue": channel.queue(cues, seq, replay_ms)[:6], "log": channel.log[-12:]}
