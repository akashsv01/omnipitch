"""Simulated physical data for a synthetic match: SIMULATED, not measured. No tracking exists in this project.

Generated deterministically from the match's own events (and a seed derived from the run), so it is reproducible
and consistent with what happened on the ball:
- running distance and top speed per player per 5-minute window: a position-based base rate, plus extra distance
  and higher peaks when the player is involved in actions, counter-attacks and ball wins in that window;
- ball speed for every pass and shot: a flight time drawn for the recorded length (longer passes travel faster;
  shots fastest), so ball speed = recorded distance / simulated flight time.
Values stay inside realistic ranges (about 450-750 m per 5 minutes; top speeds 6-9.8 m/s; passes 8-26 m/s; shots
18-33 m/s). Event-only datasets remain usable without it; every consumer labels it as simulated.
"""
from __future__ import annotations

import hashlib
import math
import random

WINDOW_MS = 5 * 60_000
BASE_M_PER_WINDOW = {"GK": 230, "CB": 480, "RB": 560, "LB": 560, "DM": 590, "CM": 640, "RW": 600, "LW": 600, "ST": 560}
PHYSICAL_VERSION = "simulated-physical-v1"


def _rng(run_id: str, salt: str) -> random.Random:
    return random.Random(int(hashlib.sha256(f"{run_id}|{salt}".encode()).hexdigest()[:12], 16))


def ball_speed_mps(event: dict) -> float | None:
    """Simulated ball speed for a pass or shot, from its recorded length and a seeded flight time."""
    if event["type"] not in ("pass", "shot") or not event.get("start"):
        return None
    if event["type"] == "pass":
        if not event.get("end"):
            return None
        length = math.hypot(event["end"]["x"] - event["start"]["x"], event["end"]["y"] - event["start"]["y"])
        rng = _rng(event["run_id"], event["event_id"])
        speed = min(26.0, max(8.0, 7.5 + 0.32 * length + rng.gauss(0, 1.6)))
    else:
        rng = _rng(event["run_id"], event["event_id"])
        speed = min(33.0, max(18.0, rng.gauss(26.5, 3.0)))
    return round(speed, 1)


def physical_windows(events: list[dict], roster: list[dict]) -> list[dict]:
    """Per player and 5-minute window (period-local, never crossing half-time): distance and top speed."""
    if not events:
        return []
    run_id = events[0]["run_id"]
    positions = {p["player_id"]: p for p in roster}
    involvement: dict[tuple[str, int, int], dict] = {}
    for event in events:
        player = event.get("player_id")
        if not player:
            continue
        key = (player, event["period"], event["match_time_ms"] // WINDOW_MS)
        row = involvement.setdefault(key, {"actions": 0, "wins": 0})
        row["actions"] += 1
        row["wins"] += event["type"] in ("tackle", "interception") and event.get("outcome") == "won"
    out = []
    for period in (1, 2):
        period_events = [e for e in events if e["period"] == period]
        if not period_events:
            continue
        last_window = period_events[-1]["match_time_ms"] // WINDOW_MS
        closed_through = last_window if any(e["type"] == "period_end" for e in period_events) else last_window - 1
        for window in range(0, closed_through + 1):
            for player, info in positions.items():
                rng = _rng(run_id, f"{player}|{period}|{window}")
                activity = involvement.get((player, period, window), {"actions": 0, "wins": 0})
                base = BASE_M_PER_WINDOW.get(info["position"], 550)
                distance = base * rng.uniform(0.9, 1.1) + 9 * activity["actions"] + 25 * activity["wins"]
                top = (5.6 if info["position"] == "GK" else 7.0) + rng.uniform(0, 1.2) + 0.12 * activity["actions"] + 0.45 * activity["wins"]
                out.append({"player_id": player, "team_id": info["team_id"], "period": period, "start_ms": window * WINDOW_MS,
                            "end_ms": (window + 1) * WINDOW_MS, "distance_m": round(min(780, distance)),
                            "top_speed_mps": round(min(9.8, top), 1)})
    return out


def physical_summary(events: list[dict], roster: list[dict], sprint_alert_mps: float = 9.0) -> dict:
    """Per-player totals over closed windows, ball speeds for revealed passes and shots, and threshold alerts."""
    windows = physical_windows(events, roster)
    players: dict[str, dict] = {}
    alerts = []
    for w in windows:
        row = players.setdefault(w["player_id"], {"player_id": w["player_id"], "team_id": w["team_id"], "distance_m": 0, "top_speed_mps": 0.0})
        row["distance_m"] += w["distance_m"]
        row["top_speed_mps"] = max(row["top_speed_mps"], w["top_speed_mps"])
        if w["top_speed_mps"] >= sprint_alert_mps:
            alerts.append({"player_id": w["player_id"], "period": w["period"], "start_ms": w["start_ms"], "top_speed_mps": w["top_speed_mps"]})
    balls = [{"event_id": e["event_id"], "type": e["type"], "speed_mps": s} for e in events if (s := ball_speed_mps(e)) is not None]
    return {"version": PHYSICAL_VERSION, "simulated": True, "players": sorted(players.values(), key=lambda r: -r["distance_m"]),
            "ball_speeds": balls, "alerts": alerts, "sprint_alert_mps": sprint_alert_mps,
            "through_ms": windows[-1]["end_ms"] if windows else 0}
