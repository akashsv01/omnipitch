"""Phase 2 gates: simulator invariants, hand-checked metrics, PPDA gates, detection,
duplicate/out-of-order ingestion, persistence and grounded-output validation."""
import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
import pytest

from agents.narrate import build_fallback_insight, clock_label
from agents.prompts import SHARED_CONTRACT, build_messages, evidence_packet
from agents.validation import finalize, validate_insight
from app import main, replay as replay_module
from app.db import Database
from app.replay import ReplayStore
from omnipitch_analytics.detect import detect_moments
from omnipitch_analytics.metrics import (forward_progress_m, grid_cell, normalize, ppda, team_stats,
                                         threat_delta, threat_grid)
from simulator.match import final_score, simulate_match

ROOT = Path(__file__).resolve().parents[3]
TEAMS = ["harbor", "vale"]


def schema_validator(name):
    schemas = [json.loads(path.read_text()) for path in (ROOT / "contracts/schemas").glob("*.json")]
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in schemas)
    schema = next(s for s in schemas if s["$id"].endswith(f"/{name}.schema.json"))
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def event(seq, kind="pass", outcome="completed", team="harbor", start=(40, 30), end=(60, 30), period=1,
          time_ms=None, direction="positive_x", player=None, possession="possession-001", **extra):
    shot = kind == "shot"
    return {
        "schema_version": "1.1", "run_id": "fixture", "match_id": "harbor-vale", "event_id": f"evt-{seq:04d}",
        "sequence": seq, "period": period, "match_time_ms": seq * 3000 if time_ms is None else time_ms,
        "emitted_at": "2026-01-01T12:00:00Z", "team_id": team, "player_id": player or f"{team}-02",
        "possession_id": possession, "type": kind, "outcome": outcome,
        "start": {"x": start[0], "y": start[1]}, "end": {"x": end[0], "y": end[1]} if kind in ("pass", "shot") else None,
        "attacking_direction": direction, "on_target": extra.get("on_target") if shot else None,
        "is_goal": extra.get("is_goal") if shot else None, "synthetic": True,
    }


# Simulator ---------------------------------------------------------------------------------

@pytest.mark.parametrize("seed,scenario", [(7, "standard"), (21, "quiet"), (3, "high_press")])
def test_simulated_match_is_valid_and_consistent(seed, scenario):
    events = simulate_match(seed, scenario)
    assert events == simulate_match(seed, scenario)
    validator = schema_validator("event")
    ids = set()
    score = {"harbor": 0, "vale": 0}
    for index, e in enumerate(events):
        validator.validate(e)
        assert e["sequence"] == index + 1 and e["event_id"] not in ids
        ids.add(e["event_id"])
        if index and events[index - 1]["period"] == e["period"]:
            assert e["match_time_ms"] >= events[index - 1]["match_time_ms"]
            assert e["emitted_at"] >= events[index - 1]["emitted_at"]
        if e["type"] == "shot" and e["is_goal"]:
            score[e["team_id"]] += 1
        if e.get("team_id"):
            # Harbor attacks +x in period 1 and switches at halftime; direction is consistent per period.
            positive = (e["team_id"] == "harbor") == (e["period"] == 1)
            assert e["attacking_direction"] == ("positive_x" if positive else "negative_x")
    assert score == final_score(events)
    assert [e["type"] for e in events if e["type"].startswith("period")] == ["period_start", "period_end"] * 2
    assert simulate_match(seed + 1, scenario) != events


def test_quiet_scenario_has_fewer_shots_and_moments():
    standard = simulate_match(7, "standard")
    quiet = simulate_match(7, "quiet")
    shots = lambda events: sum(e["type"] == "shot" for e in events)
    assert shots(quiet) < shots(standard) / 2
    assert len(detect_moments(quiet, "q", "m", TEAMS)) < len(detect_moments(standard, "s", "m", TEAMS)) / 2


# Metrics with hand-calculated fixtures --------------------------------------------------------

def test_direction_normalization_and_progression():
    assert normalize({"x": 10, "y": 5}, "positive_x") == {"x": 10, "y": 5}
    assert normalize({"x": 10, "y": 5}, "negative_x") == {"x": 95, "y": 63}
    right = event(1, start=(40, 30), end=(73, 22))
    left = event(2, start=(65, 38), end=(32, 46), direction="negative_x")  # Mirror of the same pass.
    assert forward_progress_m(right) == forward_progress_m(left) == 33.0
    backward = event(3, start=(50, 34), end=(40, 34))
    assert forward_progress_m(backward) == -10.0


def test_threat_grid_boundaries_and_delta():
    grid = threat_grid()
    assert grid["grid_version"] == "illustrative-threat-v1" and grid["calibrated"] is False
    assert grid_cell({"x": 0, "y": 0}) == (0, 0)
    assert grid_cell({"x": 105, "y": 68}) == (15, 11)
    assert grid_cell({"x": 6.5625, "y": 5.6667}) == (1, 1)
    with pytest.raises(ValueError):
        grid_cell({"x": 105.1, "y": 0})
    delta = threat_delta(event(1, start=(40, 30), end=(95, 34)))
    values = grid["values"]
    assert delta["delta"] == round(values[6][14] - values[5][6], 3)
    assert threat_delta(event(2, outcome="incomplete")) is None
    assert threat_delta(event(3, kind="tackle", outcome="won")) is None


def test_team_stats_hand_calculation():
    events = [
        event(1, start=(40, 30), end=(60, 30)),                       # +20 m
        event(2, start=(60, 30), end=(75, 30)),                       # +15 m, final third entry
        event(3, outcome="incomplete", start=(75, 30), end=(95, 30)),
        event(4, kind="shot", outcome="saved", start=(90, 34), end=(105, 34), on_target=True, is_goal=False),
        event(5, kind="interception", outcome="won", team="vale", start=(80, 30), direction="negative_x"),
    ]
    stats = team_stats(events, "harbor")
    assert stats["passes_attempted"] == 3 and stats["passes_completed"] == 2
    assert stats["completion_pct"] == 66.7
    assert stats["progression_m"] == 35.0
    assert stats["final_third_entries"] == 1
    assert (stats["shots"], stats["shots_on_target"], stats["goals"]) == (1, 1, 0)
    assert team_stats(events, "vale")["turnovers_won"] == 1


def test_player_mean_location_uses_attacking_frame_across_halves():
    from omnipitch_analytics.metrics import player_stats
    first = event(1, start=(80, 10), end=(90, 10), player="harbor-09")
    second = event(2, period=2, start=(25, 58), end=(15, 58), direction="negative_x", player="harbor-09")
    row = next(r for r in player_stats([first, second]) if r["player_id"] == "harbor-09")
    # Both actions sit at x=80, y=10 in Harbor's attacking frame; raw global coordinates would average to 52.5.
    assert row["mean_action_location"] == {"x": 80.0, "y": 10.0}


def test_ppda_counts_zone_and_gates():
    # Vale defends attacking -x, so its zone (x > 42 in its frame) is global x < 63.
    passes = [event(i, start=(30, 30), end=(40, 30)) for i in range(1, 13)]
    outside = [event(13, start=(80, 30), end=(90, 30))]  # Not in Vale's pressing zone.
    actions = [event(14 + i, kind="tackle", outcome="won", team="vale", start=(35, 30), direction="negative_x") for i in range(4)]
    window = ppda(passes + outside + actions, "vale", 1, 0, 300_000)
    assert (window["opponent_passes"], window["defensive_actions"], window["value"], window["status"]) == (12, 4, 3.0, "ok")
    no_actions = ppda(passes, "vale", 1, 0, 300_000)
    assert no_actions["value"] is None and no_actions["status"] == "no_defensive_actions" and no_actions["reason"]
    sparse = ppda(passes[:4] + actions[:1], "vale", 1, 0, 300_000)
    assert sparse["value"] == 4.0 and sparse["status"] == "insufficient_sample"


def test_ppda_after_halftime_uses_new_direction():
    # Period 2: Vale attacks +x, so its zone is global x > 42.
    passes = [event(i, period=2, team="harbor", direction="negative_x", start=(70, 30), end=(60, 30)) for i in range(1, 11)]
    actions = [event(11 + i, period=2, kind="challenge", outcome="won", team="vale", start=(70, 30)) for i in range(3)]
    window = ppda(passes + actions, "vale", 2, 0, 300_000)
    assert (window["opponent_passes"], window["defensive_actions"], window["status"]) == (10, 3, "ok")
    assert ppda(passes + actions, "vale", 1, 0, 300_000)["opponent_passes"] == 0


def test_detection_is_prefix_stable_and_ids_are_stable():
    events = simulate_match(7, "standard", run_id="stable")
    full = {m["moment_id"]: m for m in detect_moments(events, "stable", "m", TEAMS)}
    for cut in (150, 400, 800):
        for moment in detect_moments(events[:cut], "stable", "m", TEAMS):
            assert full[moment["moment_id"]] == moment
    goals = [m for m in full.values() if m["rule"] == "goal"]
    assert len(goals) == sum(final_score(events).values())
    assert all(m["evidence_ids"] and set(m["evidence_ids"]) <= {e["event_id"] for e in events} for m in full.values())
    possessions = [next(e for e in events if e["event_id"] == m["evidence_ids"][0])["possession_id"]
                   for m in full.values() if m["rule"] == "threat_gain"]
    assert len(possessions) == len(set(possessions))  # One threat-gain moment per possession.


# Ingestion, persistence and recovery -------------------------------------------------------------

@pytest.fixture
def api(monkeypatch):
    now = [0.0]
    store = ReplayStore(clock=lambda: now[0], db=Database(":memory:"))
    monkeypatch.setattr(replay_module, "replay_store", store)
    return store, now, TestClient(main.app)


def test_duplicate_and_out_of_order_ingestion_do_not_change_counts(api):
    store, _, client = api
    events = simulate_match(8, "standard", run_id="ingest-run")[:200]
    lines = [json.dumps(e) for e in events]
    first = client.post("/api/v1/runs/ingest-run/ingest", content="\n".join(reversed(lines))).json()
    assert first["accepted"] == 200 and first["duplicates"] == 0
    before = client.get("/api/v1/runs/ingest-run/metrics").json()
    again = client.post("/api/v1/runs/ingest-run/ingest", content="\n".join(lines[:50])).json()
    assert again["accepted"] == 0 and again["duplicates"] == 50
    after = client.get("/api/v1/runs/ingest-run/metrics").json()
    assert after["teams"] == before["teams"] and after["moment_count"] == before["moment_count"]
    assert after["through_sequence"] == 200
    conflict = dict(events[1], start={"x": 1.0, "y": 1.0})
    bad = client.post("/api/v1/runs/ingest-run/ingest", content=json.dumps(conflict) + "\nnot json").json()
    assert bad["conflicts"] == 1 and len(bad["rejected"]) == 2
    ledger = client.get("/api/v1/runs/ingest-run/ledger").json()
    assert ledger["summary"]["unique_events"] == 200 and ledger["summary"]["duplicates_ignored"] == 50
    assert {d["code"] for d in ledger["diagnostics"]} == {"invalid_event", "conflicting_duplicate"}
    page = client.get("/api/v1/runs/ingest-run/events?after=190&limit=5").json()
    assert [e["sequence"] for e in page["events"]] == [191, 192, 193, 194, 195] and page["next_after"] == 195


def test_gap_stops_windowed_metrics_at_contiguous_prefix(api):
    _, _, client = api
    events = simulate_match(8, "standard", run_id="gap-run")[:60]
    body = "\n".join(json.dumps(e) for e in events if e["sequence"] != 30)
    client.post("/api/v1/runs/gap-run/ingest", content=body)
    metrics = client.get("/api/v1/runs/gap-run/metrics").json()
    assert metrics["through_sequence"] == 29 and metrics["ledger"]["missing_sequences"] == 1


def test_replay_snapshot_contract_incremental_polling_and_moments(api):
    store, _, client = api
    initial = client.get("/api/v1/replay").json()
    schema_validator("replay").validate(initial)
    run = initial["state"]["run_id"]
    assert initial["replay"]["source"] == "simulator" and initial["replay"]["seed"] == 7
    seek = client.post("/api/v1/replay/control", json={"run_id": run, "action": "seek", "elapsed_ms": 2_400_000}).json()
    schema_validator("replay").validate(seek)
    count = seek["state"]["latest_event_sequence"]
    assert count > 100 and len(seek["events"]) == count and seek["moments"]
    validator = schema_validator("moment")
    context_players = {p["player_id"] for p in seek["replay"]["roster"]}
    for moment in seek["moments"]:
        validator.validate(moment)
        assert moment["source_sequence"] <= count and moment["insight"]["generation_mode"] == "fallback"
        assert moment["player_id"] is None or moment["player_id"] in context_players
    later = client.post("/api/v1/replay/control", json={"run_id": run, "action": "seek", "elapsed_ms": 3_000_000}).json()
    delta = client.get(f"/api/v1/replay?run_id={run}&after_sequence={count}").json()
    assert delta["events_offset"] == count
    assert [e["sequence"] for e in delta["events"]] == list(range(count + 1, later["state"]["latest_event_sequence"] + 1))
    assert all(m["source_sequence"] > count for m in delta["moments"])
    assert delta["analysis"] == later["analysis"]
    stale = client.get(f"/api/v1/replay?run_id=other&after_sequence={count}").json()
    assert stale["events_offset"] == 0
    # Seeking backwards hides later moments and recomputes the score from revealed events.
    back = client.post("/api/v1/replay/control", json={"run_id": run, "action": "seek", "elapsed_ms": 60_000}).json()
    assert all(m["source_sequence"] <= back["state"]["latest_event_sequence"] for m in back["moments"])
    goals = sum(e["type"] == "shot" and e["is_goal"] for e in back["events"])
    assert back["state"]["score"]["home"] + back["state"]["score"]["away"] == goals


def test_speed_generate_and_validation(api):
    store, now, client = api
    run = client.get("/api/v1/replay").json()["state"]["run_id"]
    assert client.post("/api/v1/replay/control", json={"run_id": run, "action": "speed", "speed": 3}).status_code == 422
    client.post("/api/v1/replay/control", json={"run_id": run, "action": "speed", "speed": 80})
    client.post("/api/v1/replay/control", json={"run_id": run, "action": "play"})
    now[0] = 2.0  # 2 s at 80x = 160 s of match time.
    snap = client.get("/api/v1/replay").json()
    assert 150_000 <= snap["replay"]["elapsed_ms"] <= 160_000 and snap["replay"]["speed"] == 80
    generated = client.post("/api/v1/replay/generate", json={"run_id": run, "seed": 99, "scenario": "quiet"}).json()
    assert generated["state"]["run_id"] != run and generated["replay"]["scenario"] == "quiet"
    assert generated["state"]["replay_status"] == "paused" and generated["replay"]["speed"] == 80
    assert client.post("/api/v1/replay/generate", json={"run_id": run, "seed": 1, "scenario": "quiet"}).status_code == 409
    assert client.post("/api/v1/replay/generate", json={"run_id": generated["state"]["run_id"], "seed": 1, "scenario": "chaos"}).status_code == 422


def test_restart_restores_replay_position(tmp_path):
    now = [0.0]
    path = tmp_path / "state.sqlite3"
    first = ReplayStore(clock=lambda: now[0], db=Database(path))
    run = first.snapshot().state.run_id
    first.control("speed", run, speed=40)
    first.control("play", run)
    now[0] = 30.0
    before = first.control("pause", run)
    assert before.state.latest_event_sequence > 0
    restarted = ReplayStore(clock=lambda: 0.0, db=Database(path))
    after = restarted.snapshot()
    assert after.state.run_id == run and after.replay.restored
    assert after.state.latest_event_sequence == before.state.latest_event_sequence
    assert after.state.score == before.state.score and after.state.replay_status == "paused"
    assert after.replay.speed == 40
    assert [m.moment_id for m in after.moments] == [m.moment_id for m in before.moments]
    ledger = restarted.db.ledger_summary(run)
    assert ledger["unique_events"] == before.state.latest_event_sequence and ledger["duplicates_ignored"] == 0


def test_health_and_ready(api):
    _, _, client = api
    assert client.get("/ready").json() == {"status": "ready", "mode": "local", "database": "ok",
                                           "analytics": "python-adapter-local", "narration": "fallback-only", "eventhouse": None}


# Grounded output validation ----------------------------------------------------------------------

def test_eval_set_matches_expected_verdicts():
    data = json.loads((ROOT / "services/agents/fixtures/eval_set.json").read_text(encoding="utf-8"))
    assert len(data["cases"]) >= 20
    for case in data["cases"]:
        errors = validate_insight(case["candidate"], case["moment"], case["context"])
        assert (not errors) == case["expected_valid"], (case["case_id"], errors)
        if not case["expected_valid"]:
            assert any(case["expected_error"] in error for error in errors), (case["case_id"], errors)


def test_finalize_falls_back_and_fallback_is_schema_valid():
    case = next(c for c in json.loads((ROOT / "services/agents/fixtures/eval_set.json").read_text())["cases"]
                if c["case_id"] == "probability-claim")
    published, errors = finalize(case["candidate"], case["moment"], case["context"])
    assert errors and published["generation_mode"] == "fallback"
    assert not validate_insight(published, case["moment"], case["context"])
    schema_validator("insight").validate(published)
    timeout, errors = finalize(None, case["moment"], case["context"])
    assert timeout == published and errors == ["no candidate output"]


def test_prompts_carry_only_evidence():
    case = json.loads((ROOT / "services/agents/fixtures/eval_set.json").read_text())["cases"][0]
    packet = evidence_packet(case["moment"], case["context"])
    assert packet["synthetic"] is True and packet["evidence_ids"] == case["moment"]["evidence_ids"]
    assert set(packet["players"]) <= set(case["context"]["evidence_players"]) | {case["moment"]["player_id"]}
    messages = build_messages("broadcaster", case["moment"], case["context"], {"facts": []})
    assert messages[0]["content"] == SHARED_CONTRACT and "probability" in SHARED_CONTRACT
    assert json.loads(messages[1]["content"])["approved_inputs"] == {"facts": []}


@pytest.mark.parametrize("period,ms,label", [(1, 0, "1'"), (1, 44 * 60000, "45'"), (1, 46 * 60000 + 5, "45+2'"),
                                             (2, 0, "46'"), (2, 47 * 60000, "90+3'")])
def test_clock_labels(period, ms, label):
    assert clock_label(period, ms) == label


def test_every_fixture_rule_has_a_valid_template():
    events = simulate_match(21, "standard", run_id="templates")
    by_id = {e["event_id"]: e for e in events}
    from app.analysis import narration_context
    rules = set()
    for moment in detect_moments(events, "templates", "harbor-vale", TEAMS):
        actors = sorted({by_id[i]["player_id"] for i in moment["evidence_ids"] if by_id[i].get("player_id")})
        context = narration_context(actors)
        insight = build_fallback_insight(moment, context)
        assert validate_insight(insight, moment, context) == [], moment["moment_id"]
        rules.add(moment["rule"])
    assert {"goal", "threat_gain", "transition"} <= rules
