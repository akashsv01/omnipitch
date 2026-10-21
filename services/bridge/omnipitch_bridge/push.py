"""Push publication: envelopes (contracts/schemas/push.schema.json), a durable outbox and Web PubSub.

Outbox rule: persist first, then publish. Every message is created once under its deterministic
message_id (<run_id>:<type>:<key>) and stored `pending`; a publish attempt stamps sent_at, sends, then
marks it `sent` with a conditional write. A failed send stays pending with its attempt count and error
and is retried with the same message_id next cycle. A crash between send and mark resends the same
message_id on restart (at-least-once); browsers drop duplicates by message_id, and only `state`
messages are ordered by state_version (agreed with the frontend owner, 2026-10-20).

Push is only a fast path: browsers fetch the snapshot API on every accepted message and on reconnect.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path
import re
import time
from typing import Callable, Protocol
from urllib import error, parse, request

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from .store import StaleOutbox, iso

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts/schemas"
HUB = "omnipitch"
SCOPE = "https://webpubsub.azure.com/.default"
API_VERSION = "2024-01-01"
RUN_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
TYPE_ORDER = {"state": 0, "moment": 1, "period_reconciled": 2, "insight": 3}


def _push_validator() -> Draft202012Validator:
    resources = []
    for path in CONTRACTS.glob("*.json"):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources += [(schema["$id"], Resource.from_contents(schema)), (path.name, Resource.from_contents(schema))]
    return Draft202012Validator(json.loads((CONTRACTS / "push.schema.json").read_text(encoding="utf-8")),
                                registry=Registry().with_resources(resources), format_checker=FormatChecker())


PUSH_VALIDATOR = _push_validator()


def group_for(run_id: str) -> str:
    if not RUN_ID.match(run_id or ""):
        raise ValueError("run_id must be 1-128 characters of letters, digits, '.', '_', ':' or '-'")
    return f"run-{run_id}"


def envelope(kind: str, run_id: str, key: object, state_version: int, payload: dict) -> dict:
    """An envelope without sent_at (stamped on each publication attempt)."""
    return {"schema_version": "1.0", "message_id": f"{run_id}:{kind}:{key}", "run_id": run_id, "type": kind,
            "state_version": state_version, "payload": payload}


def state_payload(prefix: list[dict], teams: dict) -> dict:
    """match-state for the processed gap-free prefix; state_version = its last sequence."""
    last = prefix[-1]
    score = {team: 0 for team in teams}
    for event in prefix:
        if event["type"] == "shot" and event.get("is_goal"):
            score[event["team_id"]] += 1
    home, away = list(teams.items())
    finished = any(e["type"] == "period_end" and e["period"] == 2 for e in prefix)
    return {"schema_version": "1.1", "run_id": last["run_id"], "match_id": last["match_id"],
            "state_version": last["sequence"], "period": last["period"], "match_time_ms": last["match_time_ms"],
            "home_team": {"id": home[0], "name": home[1]}, "away_team": {"id": away[0], "name": away[1]},
            "score": {"home": score[home[0]], "away": score[away[0]]}, "latest_event_sequence": last["sequence"],
            "replay_status": "finished" if finished else "playing", "synthetic": True}


def moment_ref(moment: dict) -> dict:
    return {key: moment[key] for key in ("moment_id", "rule", "priority", "period", "match_time_ms", "source_sequence")}


class Publisher(Protocol):
    def send_to_group(self, group: str, message: dict) -> None: ...


class WebPubSubClient:
    """Web PubSub data-plane REST with Entra ID (local auth is disabled on the resource). No keys."""

    def __init__(self, endpoint: str, hub: str = HUB, credential=None, timeout_s: float = 10.0):
        if not endpoint.startswith("https://") or "AccessKey" in endpoint:
            raise ValueError("WEBPUBSUB_ENDPOINT must be the https endpoint (no keys or connection strings).")
        self.endpoint, self.hub, self.timeout_s = endpoint.rstrip("/"), hub, timeout_s
        if credential is None:
            from app.config import credential as make_credential
            credential = make_credential(None)
        self.credential = credential
        self._token = None

    def _bearer(self) -> str:
        if self._token is None or self._token.expires_on - time.time() < 120:
            self._token = self.credential.get_token(SCOPE)
        return self._token.token

    def _post(self, path: str, query: dict, body: bytes | None, content_type: str | None = None) -> bytes:
        url = f"{self.endpoint}/api/hubs/{parse.quote(self.hub)}/{path}?{parse.urlencode({**query, 'api-version': API_VERSION})}"
        headers = {"Authorization": f"Bearer {self._bearer()}"}
        if content_type:
            headers["Content-Type"] = content_type
        req = request.Request(url, data=body if body is not None else b"", headers=headers, method="POST")
        try:
            with request.urlopen(req, timeout=self.timeout_s) as response:
                return response.read()
        except error.HTTPError as exc:  # Status and service error code only; never the request.
            raise RuntimeError(f"Web PubSub HTTP {exc.code} on {path.split('/')[0]}") from None

    def send_to_group(self, group: str, message: dict) -> None:
        self._post(f"groups/{parse.quote(group)}/:send", {}, json.dumps(message).encode("utf-8"), "application/json")

    def client_url(self, group: str, minutes: int = 60) -> dict:
        """Short-lived wss URL whose connection joins `group` on connect (receive-only)."""
        token = json.loads(self._post(":generateToken", {"minutesToExpire": minutes, "group": group}, None))["token"]
        host = parse.urlparse(self.endpoint).netloc
        return {"url": f"wss://{host}/client/hubs/{parse.quote(self.hub)}?access_token={parse.quote(token)}",
                "group": group}


class Outbox:
    def __init__(self, store, publisher: Publisher, clock: Callable[[], datetime],
                 log: Callable[[dict], None] = lambda record: None, max_per_cycle: int = 200):
        self.store, self.publisher, self.clock, self.log, self.max_per_cycle = store, publisher, clock, log, max_per_cycle
        self.sent_total = 0

    def enqueue(self, message: dict, known: set[str]) -> bool:
        """Validate and persist once; `known` holds the run's existing message_ids (avoids repeat writes)."""
        if message["message_id"] in known:
            return False
        PUSH_VALIDATOR.validate({**message, "sent_at": iso(self.clock())})
        now = iso(self.clock())
        created = self.store.create_outbox({"message_id": message["message_id"], "run_id": message["run_id"],
                                            "type": message["type"], "state_version": message["state_version"],
                                            "envelope": message, "status": "pending", "attempts": 0, "last_error": None,
                                            "created_at": now, "sent_at": None, "version": 1})
        known.add(message["message_id"])
        return created

    def publish_pending(self) -> dict:
        pending = sorted(self.store.outbox(status="pending"),
                         key=lambda r: (r["run_id"], TYPE_ORDER[r["type"]], r["state_version"], r["created_at"], r["message_id"]))
        sent = failed = 0
        for record in pending[:self.max_per_cycle]:
            now = self.clock()
            message = {**record["envelope"], "sent_at": iso(now)}
            try:
                self.publisher.send_to_group(group_for(record["run_id"]), message)
            except Exception as exc:  # Keep pending; same message_id next cycle.
                failed += 1
                self._update(record, attempts=record["attempts"] + 1, last_error=f"{type(exc).__name__}: {str(exc)[:200]}")
                self.log({"stage": "publish", "outcome": "retry_later", "message_id": record["message_id"],
                          "attempts": record["attempts"] + 1})
                continue
            if self._update(record, status="sent", attempts=record["attempts"] + 1, sent_at=iso(now), last_error=None):
                sent += 1
        self.sent_total += sent
        result = {"stage": "publish", "sent": sent, "failed": failed, "pending_before": len(pending)}
        if pending:
            self.log(result)
        return result

    def _update(self, record: dict, **changes) -> bool:
        updated = {**record, **changes, "version": record["version"] + 1}
        try:
            self.store.update_outbox(updated, record["version"])
            return True
        except StaleOutbox:
            return False  # Another publisher already updated it; nothing is counted twice.
