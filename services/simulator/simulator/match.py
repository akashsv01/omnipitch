"""Seeded state-machine match simulator.

The simulator keeps teams, period, score, ball location, possession and last action, then
chooses the next action from that state. Scenarios bias probabilities; they never script
narratives. Detection and narration must consume the resulting events.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import random

PITCH_LENGTH = 105.0
PITCH_WIDTH = 68.0
SCHEMA_VERSION = "1.1"
BASELINE = "2026-01-01T12:00:00Z"
SCENARIOS = ("standard", "quiet", "high_press", "late_surge")
PERIOD_MS = 45 * 60 * 1000

HOME = {"id": "harbor", "name": "Harbor Comets", "short": "HAR"}
AWAY = {"id": "vale", "name": "Vale Owls", "short": "VAL"}

# Fictional rosters. Base positions use the team's own attacking frame (x towards goal).
_SHAPE = [
    ("GK", 6, 34), ("RB", 30, 58), ("CB", 22, 42), ("CB", 22, 26), ("LB", 30, 10),
    ("DM", 40, 34), ("CM", 52, 46), ("CM", 52, 22), ("RW", 72, 58), ("ST", 82, 34), ("LW", 72, 10),
]
_NAMES = {
    "harbor": ["Ines Marlow", "Theo Brannock", "Kofi Adeyemi", "Rafael Quill", "Sami Ostberg",
               "Luca Fennimore", "Jonah Pike", "Arlo Venn", "Mateo Castell", "Niko Strand", "Elias Rook"],
    "vale": ["Bram Holloway", "Felix Dunmore", "Oren Vasko", "Caius Thorne", "Malik Reyes",
             "Ivo Sandoval", "Pell Okafor", "Remy Lachance", "Dario Wren", "Tobias Kell", "Yannick Moor"],
}
_NUMBERS = [1, 2, 4, 5, 3, 6, 8, 10, 7, 9, 11]


def roster() -> list[dict]:
    players = []
    for team in (HOME["id"], AWAY["id"]):
        for index, (position, x, y) in enumerate(_SHAPE):
            players.append({
                "player_id": f"{team}-{index + 1:02d}", "team_id": team, "name": _NAMES[team][index],
                "shirt": _NUMBERS[index], "position": position, "base": {"x": x, "y": y},
            })
    return players


@dataclass
class Bias:
    progression: float = 1.0
    shot: float = 1.0
    press_home: float = 1.0
    press_away: float = 1.0
    counter: float = 1.0
    # Per-team multipliers for the away side (Vale); 1.0 keeps the random draws of every other scenario identical.
    away_shot: float = 1.0
    away_progression: float = 1.0


def _bias(scenario: str, period: int, minute: float) -> Bias:
    if scenario == "quiet":
        return Bias(progression=0.55, shot=0.3, press_home=0.7, press_away=0.7, counter=0.4)
    if scenario == "high_press":
        return Bias(progression=1.0, shot=1.0, press_home=1.0, press_away=2.4, counter=1.4)
    if scenario == "late_surge":
        # Vale push hard in the last half hour: more forward passing and more shots, Harbor sit deeper.
        # Goals stay random, so a comeback is likely for some seeds, never guaranteed.
        if period == 2 and minute >= 15:
            return Bias(progression=0.8, shot=0.7, press_home=1.0, press_away=1.6, counter=1.2, away_shot=3.4, away_progression=1.9)
        return Bias()
    # Standard match: phases that create build-up, a pressing spell and transitions.
    bias = Bias()
    if period == 1 and 22 <= minute < 34:
        bias.press_away = 2.6  # Vale press high for a spell.
    if period == 2 and 10 <= minute < 22:
        bias.press_home = 2.2
        bias.counter = 1.6
    if period == 2 and minute >= 35:
        bias.progression = 1.25
        bias.shot = 1.4
    return bias


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


class _Match:
    def __init__(self, seed: int, scenario: str, run_id: str, match_id: str, baseline: str):
        if scenario not in SCENARIOS:
            raise ValueError(f"scenario must be one of {', '.join(SCENARIOS)}")
        if not run_id.strip():
            raise ValueError("run_id must be nonempty")
        clock = datetime.fromisoformat(baseline.replace("Z", "+00:00"))
        if clock.tzinfo is None or clock.utcoffset() != timedelta(0):
            raise ValueError("baseline must have an explicit UTC timezone")
        self.rng = random.Random(seed)
        self.scenario = scenario
        self.run_id = run_id
        self.match_id = match_id
        self.wall = clock
        self.wall_offset_ms = 0
        self.events: list[dict] = []
        self.players = {team: [p for p in roster() if p["team_id"] == team] for team in (HOME["id"], AWAY["id"])}
        self.score = {HOME["id"]: 0, AWAY["id"]: 0}
        self.possession_count = 0

    # Direction: Harbor attack +x in period 1 and swap at halftime.
    def direction(self, team: str, period: int) -> str:
        home_positive = period == 1
        positive = home_positive if team == HOME["id"] else not home_positive
        return "positive_x" if positive else "negative_x"

    def to_global(self, team: str, period: int, x: float, y: float) -> dict:
        x, y = _clamp(x, 0, PITCH_LENGTH), _clamp(y, 0, PITCH_WIDTH)
        if self.direction(team, period) == "negative_x":
            x, y = PITCH_LENGTH - x, PITCH_WIDTH - y
        return {"x": round(x, 2), "y": round(y, 2)}

    def other(self, team: str) -> str:
        return AWAY["id"] if team == HOME["id"] else HOME["id"]

    def new_possession(self) -> str:
        self.possession_count += 1
        return f"possession-{self.possession_count:03d}"

    def pick_player(self, team: str, x: float, exclude: str | None = None) -> dict:
        candidates = [p for p in self.players[team] if p["player_id"] != exclude]
        weights = [1 / (1 + abs(p["base"]["x"] - x) / 12) * (0.25 if p["position"] == "GK" and x > 25 else 1)
                   for p in candidates]
        return self.rng.choices(candidates, weights)[0]

    def emit(self, period: int, time_ms: int, kind: str, outcome: str, team: str | None = None,
             player: str | None = None, possession: str | None = None, start: dict | None = None,
             end: dict | None = None, shot: tuple[bool, bool] | None = None) -> None:
        sequence = len(self.events) + 1
        emitted = self.wall + timedelta(milliseconds=self.wall_offset_ms + time_ms)
        self.events.append({
            "schema_version": SCHEMA_VERSION, "run_id": self.run_id, "match_id": self.match_id,
            "event_id": f"evt-{sequence:04d}", "sequence": sequence, "period": period,
            "match_time_ms": time_ms, "emitted_at": emitted.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "team_id": team, "player_id": player, "possession_id": possession, "type": kind,
            "outcome": outcome, "start": start, "end": end,
            "attacking_direction": self.direction(team, period) if team else None,
            "on_target": shot[0] if shot else None, "is_goal": shot[1] if shot else None,
            "synthetic": True,
        })

    def play_period(self, period: int, kickoff_team: str) -> None:
        rng = self.rng
        stoppage = rng.randint(1, 4) * 60_000 + rng.randint(0, 50) * 1000
        end_ms = PERIOD_MS + stoppage
        t = 0
        self.emit(period, t, "period_start", "none")
        team = kickoff_team
        possession = self.new_possession()
        x, y = 52.5, 34.0  # Team-relative ball location.
        carrier = self.pick_player(team, 52)["player_id"]
        t += 1000
        while t < end_ms:
            minute = t / 60000
            bias = _bias(self.scenario, period, minute)
            opponent = self.other(team)
            press = bias.press_away if opponent == AWAY["id"] else bias.press_home
            zone_press = press if x < 63 else 1.0  # Pressing happens in the opponent's build-up zone.
            # Choose the next action from the current state.
            p_def = _clamp(0.11 * zone_press, 0.04, 0.42)
            p_shot = 0.0
            if x > 78:
                p_shot = _clamp((0.035 + (x - 78) / 260) * bias.shot * (bias.away_shot if team == AWAY["id"] else 1.0), 0, 0.3)
            roll = rng.random()
            if roll < p_shot:
                t = self.shoot(period, t, team, carrier, possession, x, y)
                if self.events[-1]["is_goal"]:
                    self.score[team] += 1
                    team = opponent
                    t += rng.randint(45, 75) * 1000
                    x, y = 52.5, 34.0
                else:
                    team = opponent
                    t += rng.randint(8, 20) * 1000
                    x, y = 6.0, 34.0 + rng.uniform(-6, 6)
                possession = self.new_possession()
                carrier = self.players[team][0]["player_id"] if x < 10 else self.pick_player(team, x)["player_id"]
                continue
            if roll < p_shot + p_def:
                # Defensive action by the opponent at the carrier's location.
                defender = self.pick_player(opponent, PITCH_LENGTH - x)
                location = self.to_global(team, period, x, y)
                kind = rng.choices(["tackle", "interception", "challenge", "foul"], [0.36, 0.3, 0.2, 0.14])[0]
                t += rng.randint(1500, 4000)
                if kind == "interception":
                    # The pass that was cut out is recorded first, then the interception.
                    tx, ty = x + rng.uniform(4, 18), _clamp(y + rng.uniform(-14, 14), 1, 67)
                    target = self.to_global(team, period, tx, ty)
                    self.emit(period, t, "pass", "incomplete", team, carrier, possession, location, target)
                    t += rng.randint(300, 900)
                    self.emit(period, t, "interception", "won", opponent, defender["player_id"], possession,
                              self.to_global(team, period, (x + tx) / 2, (y + ty) / 2))
                    won = True
                    x, y = PITCH_LENGTH - (x + tx) / 2, PITCH_WIDTH - (y + ty) / 2
                elif kind == "foul":
                    self.emit(period, t, "foul", "committed", opponent, defender["player_id"], possession, location)
                    won = False
                    t += rng.randint(15, 35) * 1000
                else:
                    won = rng.random() < (0.62 if kind == "tackle" else 0.5)
                    self.emit(period, t, kind, "won" if won else "lost", opponent, defender["player_id"], possession, location)
                    if won:
                        x, y = PITCH_LENGTH - x, PITCH_WIDTH - y
                if won:
                    team = opponent
                    possession = self.new_possession()
                    carrier = defender["player_id"]
                    # Transitions: a turnover in an advanced area can trigger a direct run forward.
                    if rng.random() < 0.22 * bias.counter and x > 35:
                        t = self.counter(period, t, team, carrier, possession, x, y)
                        last = self.events[-1]
                        x, y, team, possession, carrier, t = self.after_counter(period, t, last, team, possession)
                continue
            # Pass from the carrier.
            t += rng.randint(2200, 6200)
            progression = bias.progression * (bias.away_progression if team == AWAY["id"] else 1.0)
            forward = rng.gauss(7.5 * progression, 9)
            if x < 30:
                forward += 4
            if rng.random() < 0.07 * progression:
                forward += rng.uniform(15, 30)  # Occasional line-breaking ball.
            tx = _clamp(x + forward, 2, 103)
            ty = _clamp(y + rng.gauss(0, 13), 1, 67)
            distance = math.hypot(tx - x, ty - y)
            complete_p = _clamp(0.93 - distance / 120 - max(0, tx - 75) / 90 - (zone_press - 1) * 0.06, 0.35, 0.96)
            receiver = self.pick_player(team, tx, exclude=carrier)
            start, end = self.to_global(team, period, x, y), self.to_global(team, period, tx, ty)
            if rng.random() < complete_p:
                self.emit(period, t, "pass", "completed", team, carrier, possession, start, end)
                x, y, carrier = tx, ty, receiver["player_id"]
            else:
                self.emit(period, t, "pass", "incomplete", team, carrier, possession, start, end)
                team = opponent
                possession = self.new_possession()
                x, y = PITCH_LENGTH - tx, PITCH_WIDTH - ty
                carrier = self.pick_player(team, x)["player_id"]
        self.emit(period, max(t, end_ms), "period_end", "none")
        self.wall_offset_ms += max(t, end_ms) + 15 * 60 * 1000

    def shoot(self, period: int, t: int, team: str, carrier: str, possession: str, x: float, y: float) -> int:
        rng = self.rng
        t += rng.randint(1200, 3500)
        start = self.to_global(team, period, x, y)
        goal_y = _clamp(34 + rng.gauss(0, 4.5), 26, 42)
        distance = math.hypot(105 - x, 34 - y)
        quality = _clamp(0.36 - distance / 70, 0.03, 0.3)
        roll = rng.random()
        if roll < quality * 0.75:
            outcome, shot = "goal", (True, True)
        elif roll < quality * 0.75 + 0.27:
            outcome, shot = "saved", (True, False)
        elif roll < quality * 0.75 + 0.27 + 0.2:
            outcome, shot = "blocked", (False, False)
            goal_y = y + (34 - y) * 0.3
        else:
            outcome, shot = "off_target", (False, False)
            goal_y = rng.choice([rng.uniform(20, 29.5), rng.uniform(38.5, 48)])
        end_x = 105 if outcome != "blocked" else min(104, x + rng.uniform(2, 6))
        self.emit(period, t, "shot", outcome, team, carrier, possession, start,
                  self.to_global(team, period, end_x, goal_y), shot)
        return t

    def counter(self, period: int, t: int, team: str, carrier: str, possession: str, x: float, y: float) -> int:
        rng = self.rng
        for _ in range(rng.randint(1, 3)):
            if x > 80:
                break
            t += rng.randint(1500, 3500)
            tx = _clamp(x + rng.uniform(14, 28), 2, 100)
            ty = _clamp(y + rng.gauss(0, 10), 4, 64)
            receiver = self.pick_player(team, tx, exclude=carrier)
            self.emit(period, t, "pass", "completed", team, carrier, possession,
                      self.to_global(team, period, x, y), self.to_global(team, period, tx, ty))
            x, y, carrier = tx, ty, receiver["player_id"]
        if x > 74 and rng.random() < 0.4:
            t = self.shoot(period, t, team, carrier, possession, x, y)
        self._counter_state = (x, y, carrier)
        return t

    def after_counter(self, period: int, t: int, last: dict, team: str, possession: str):
        if last["type"] == "shot":
            if last["is_goal"]:
                self.score[team] += 1
                t += self.rng.randint(45, 75) * 1000
                team = self.other(team)
                x, y = 52.5, 34.0
            else:
                team = self.other(team)
                t += self.rng.randint(8, 20) * 1000
                x, y = 6.0, 34.0
            possession = self.new_possession()
            carrier = self.pick_player(team, x)["player_id"]
            return x, y, team, possession, carrier, t
        x, y, carrier = self._counter_state
        return x, y, team, possession, carrier, t


def simulate_match(seed: int = 7, scenario: str = "standard", run_id: str = "demo-run-001",
                   match_id: str = "harbor-vale", baseline: str = BASELINE) -> list[dict]:
    """Return a complete two-period synthetic match as ordered event dictionaries."""
    match = _Match(seed, scenario, run_id, match_id, baseline)
    match.play_period(1, HOME["id"])
    match.play_period(2, AWAY["id"])
    return match.events


def final_score(events: list[dict]) -> dict:
    score = {HOME["id"]: 0, AWAY["id"]: 0}
    for event in events:
        if event["type"] == "shot" and event["is_goal"]:
            score[event["team_id"]] += 1
    return score
