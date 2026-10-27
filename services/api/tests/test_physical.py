"""Simulated physical data: reproducible, realistic, consistent with the recorded events, and cut at the replay."""
from fastapi.testclient import TestClient

from app import main, replay as replay_module
from app.sample_data import roster
from simulator.match import simulate_match
from simulator.physical import ball_speed_mps, physical_summary, physical_windows

from test_phase4 import first_period_end, make_store, seek_to_sequence


def test_reproducible_and_in_realistic_ranges():
    events = simulate_match(7, "standard", run_id="phys")
    assert physical_windows(events, roster()) == physical_windows(events, roster())
    windows = physical_windows(events, roster())
    assert all(200 <= w["distance_m"] <= 780 and 5.6 <= w["top_speed_mps"] <= 9.8 for w in windows)
    totals = {}
    for w in windows:
        totals[w["player_id"]] = totals.get(w["player_id"], 0) + w["distance_m"]
    outfield = [v for k, v in totals.items() if not k.endswith("-01")]
    assert 8_000 <= min(outfield) and max(outfield) <= 14_500  # about 9-14 km over a full match
    speeds = [ball_speed_mps(e) for e in events if e["type"] in ("pass", "shot")]
    assert all(s is None or 8 <= s <= 33 for s in speeds)


def test_consistent_with_recorded_involvement():
    events = simulate_match(7, "standard", run_id="phys")
    windows = physical_windows(events, roster())
    busy, quiet = [], []
    for w in windows:
        actions = sum(1 for e in events if e.get("player_id") == w["player_id"] and e["period"] == w["period"]
                      and w["start_ms"] <= e["match_time_ms"] < w["end_ms"])
        (busy if actions >= 4 else quiet if actions == 0 else []).append(w["distance_m"])
    assert sum(busy) / len(busy) > sum(quiet) / len(quiet)  # more on-ball involvement, more running


def test_endpoint_is_cut_at_the_replay_and_labelled_simulated(monkeypatch):
    store, _ = make_store()
    seek_to_sequence(store, first_period_end(store) - 200)
    monkeypatch.setattr(replay_module, "replay_store", store)
    body = TestClient(main.app).get("/api/v1/replay/physical", params={"sprint_alert_mps": 8.5}).json()
    revealed = store.dicts[:store.state.latest_event_sequence]
    assert body["simulated"] is True and body["sprint_alert_mps"] == 8.5
    assert body["through_ms"] <= revealed[-1]["match_time_ms"]          # only closed windows before the replay
    assert {b["event_id"] for b in body["ball_speeds"]} <= {e["event_id"] for e in revealed}
    assert all(a["top_speed_mps"] >= 8.5 for a in body["alerts"])
    full = physical_summary(simulate_match(7, "standard", run_id=store.state.run_id), roster())
    assert len(full["ball_speeds"]) > len(body["ball_speeds"])
