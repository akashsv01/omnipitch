"""Push publication through the outbox (fake publisher) and the negotiate endpoint (fake Web PubSub client)."""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from omnipitch_bridge.bridge import Bridge
from omnipitch_bridge.push import PUSH_VALIDATOR, Outbox, group_for
from omnipitch_bridge.store import SqliteStore
from simulator.match import final_score, simulate_match
from test_bridge import T0, Clock, FakeEventhouse


class FakePublisher:
    def __init__(self, fail_times: int = 0):
        self.sent: list[tuple[str, dict]] = []
        self.fail_times = fail_times

    def send_to_group(self, group: str, message: dict) -> None:
        if self.fail_times:
            self.fail_times -= 1
            raise RuntimeError("Web PubSub HTTP 503 on groups")
        self.sent.append((group, message))


@pytest.fixture(scope="module")
def seeded_full() -> list[dict]:
    return simulate_match(7, "standard", run_id="push-test")


def setup(tmp_path, events, publisher, insight_source=None, store=None):
    store = store or SqliteStore(tmp_path / "bridge.sqlite3")
    clock = Clock(T0)
    source = FakeEventhouse()
    source.ingest(events, T0)
    outbox = Outbox(store, publisher, clock)
    return Bridge(source, store, "test", timedelta(minutes=2), clock, outbox=outbox,
                  insight_source=insight_source or (lambda run_id: [])), store, source, clock


def test_messages_are_valid_ordered_and_cover_state_moments_and_periods(tmp_path, seeded_full):
    publisher = FakePublisher()
    bridge, store, _, _ = setup(tmp_path, seeded_full, publisher)
    bridge.run_once()
    messages = [m for _, m in publisher.sent]
    for message in messages:
        PUSH_VALIDATOR.validate(message)
    assert {g for g, _ in publisher.sent} == {"run-push-test"}
    kinds = [m["type"] for m in messages]
    assert kinds[0] == "state" and messages[0]["state_version"] == 1206
    score = final_score(seeded_full)  # Independent reference: the simulator's own score.
    assert messages[0]["payload"]["replay_status"] == "finished"
    assert messages[0]["payload"]["score"] == {"home": score["harbor"], "away": score["vale"]}
    assert kinds.count("moment") == len(store.moments("push-test")) == 55
    assert [m["payload"]["period"] for m in messages if m["type"] == "period_reconciled"] == [1, 2]
    assert len({m["message_id"] for m in messages}) == len(messages)
    assert all(r["status"] == "sent" and r["attempts"] == 1 for r in store.outbox("push-test"))


def test_state_versions_increase_as_the_prefix_grows(tmp_path, seeded_full):
    publisher = FakePublisher()
    bridge, _, source, _ = setup(tmp_path, seeded_full[:300], publisher)
    bridge.run_once()
    source.ingest(seeded_full[300:700], T0 + timedelta(seconds=10))
    bridge.run_once()
    states = [m["state_version"] for _, m in publisher.sent if m["type"] == "state"]
    assert states == [300, 700]
    assert [m["payload"]["replay_status"] for _, m in publisher.sent if m["type"] == "state"] == ["playing", "playing"]


def test_reruns_and_duplicates_publish_nothing_new(tmp_path, seeded_full):
    publisher = FakePublisher()
    bridge, store, source, _ = setup(tmp_path, seeded_full, publisher)
    bridge.run_once()
    count = len(publisher.sent)
    source.ingest(seeded_full[-25:], T0 + timedelta(seconds=5))  # Re-delivered events.
    bridge.run_once()
    bridge.reconcile()
    bridge.run_once()
    assert len(publisher.sent) == count and len(store.outbox("push-test")) == count


def test_failed_send_is_retried_with_the_same_message_id(tmp_path, seeded_full):
    publisher = FakePublisher(fail_times=1)
    bridge, store, _, clock = setup(tmp_path, seeded_full[:100], publisher)
    first = bridge.run_once()
    assert first["publish_failed"] == 1
    failed = next(r for r in store.outbox("push-test") if r["attempts"] == 1 and r["status"] == "pending")
    assert "503" in failed["last_error"]
    clock.now += timedelta(seconds=3)
    bridge.run_once()
    resent = [m for _, m in publisher.sent if m["message_id"] == failed["message_id"]]
    assert len(resent) == 1 and resent[0]["sent_at"] == "2026-10-16T03:00:03.000Z"
    record = next(r for r in store.outbox("push-test") if r["message_id"] == failed["message_id"])
    assert (record["status"], record["attempts"], record["last_error"]) == ("sent", 2, None)


def test_restart_between_send_and_mark_resends_once_and_counts_once(tmp_path, seeded_full):
    publisher = FakePublisher()
    store = SqliteStore(tmp_path / "bridge.sqlite3")
    original = store.update_outbox
    state = {"crashed": False}

    def crash_after_first_send(record, expected_version):
        if record["status"] == "sent" and not state["crashed"]:
            state["crashed"] = True
            raise RuntimeError("worker killed after sending, before marking sent")
        return original(record, expected_version)
    store.update_outbox = crash_after_first_send
    bridge, _, source, _ = setup(tmp_path, seeded_full[:100], publisher, store=store)
    with pytest.raises(RuntimeError):
        bridge.run_once()
    first_id = publisher.sent[0][1]["message_id"]
    restarted_store = SqliteStore(tmp_path / "bridge.sqlite3")
    restarted = Bridge(source, restarted_store, "test", timedelta(minutes=2), Clock(T0),
                       outbox=Outbox(restarted_store, publisher, Clock(T0)), insight_source=lambda run_id: [])
    restarted.run_once()
    ids = [m["message_id"] for _, m in publisher.sent]
    assert ids.count(first_id) == 2  # At-least-once: the browser drops the duplicate by message_id.
    records = restarted_store.outbox("push-test")
    assert all(r["status"] == "sent" for r in records) and len(records) == len(set(ids))


def test_insight_is_published_once_after_its_job_completes(tmp_path, seeded_full):
    publisher = FakePublisher()
    insights: dict[str, dict] = {}
    bridge, store, _, clock = setup(tmp_path, seeded_full[:400], publisher, insight_source=lambda run_id: list(insights.values()))
    bridge.run_once()
    job = store.claim_next("narrator", clock.now, run_id="push-test")
    from agents.narrate import build_fallback_insight
    from app.analysis import narration_context
    moment = next(m for m in store.moments("push-test") if m["moment_id"] == job["moment_id"])
    insights[job["moment_id"]] = {"insight_id": job["moment_id"], "run_id": "push-test",
                                  "insight": build_fallback_insight(moment, narration_context([]))}
    store.complete(job, "narrator", clock.now, "fallback", insight_id=job["moment_id"])
    bridge.run_once()
    bridge.run_once()
    pushed = [m for _, m in publisher.sent if m["type"] == "insight"]
    assert len(pushed) == 1 and pushed[0]["message_id"] == f"push-test:insight:{job['moment_id']}"
    assert pushed[0]["payload"]["generation_mode"] == "fallback"


def test_run_ids_are_checked_for_group_names():
    assert group_for("gate-20261020-d") == "run-gate-20261020-d"
    with pytest.raises(ValueError):
        group_for("bad/run id")


class FakeWebPubSub:
    def client_url(self, group: str, minutes: int = 60) -> dict:
        return {"url": f"wss://example.webpubsub.azure.com/client/hubs/omnipitch?access_token=fake-{group}", "group": group}


def test_negotiate_endpoint(monkeypatch):
    from app import main
    client = TestClient(main.app)
    monkeypatch.delenv("WEBPUBSUB_ENDPOINT", raising=False)
    monkeypatch.setattr(main, "_PUSH_CLIENT", None)
    response = client.get("/api/v1/negotiate", params={"run_id": "gate-20261020-d"})
    assert response.status_code == 503 and response.json()["detail"]["code"] == "push_not_configured"
    monkeypatch.setattr(main, "push_client", lambda: FakeWebPubSub())
    ok = client.get("/api/v1/negotiate", params={"run_id": "gate-20261020-d"})
    body = ok.json()
    assert ok.status_code == 200 and body["url"].startswith("wss://") and body["group"] == "run-gate-20261020-d"
    assert body["expires_at"].endswith("Z")
    bad = client.get("/api/v1/negotiate", params={"run_id": "bad/run id"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "invalid_run_id"


def test_reconcile_pass_publishes_what_it_enqueues(tmp_path, seeded_full):
    publisher = FakePublisher()
    store = SqliteStore(tmp_path / "bridge.sqlite3")
    plain = Bridge(FakeEventhouse(), store, "test", timedelta(minutes=2), Clock(T0))
    source = FakeEventhouse()
    source.ingest(seeded_full[:200], T0)
    plain.source = source
    plain.run_once()  # Processed earlier without push: nothing enqueued.
    assert store.outbox("push-test") == []
    pushing = Bridge(source, store, "test", timedelta(minutes=2), Clock(T0),
                     outbox=Outbox(store, publisher, Clock(T0)), insight_source=lambda run_id: [])
    pushing.reconcile()
    assert publisher.sent and all(r["status"] == "sent" for r in store.outbox("push-test"))
