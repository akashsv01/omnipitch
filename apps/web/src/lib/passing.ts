import type { Event } from '../types/contracts';

/** Pass difficulty and speed of attack, computed in the browser from recorded event locations and times.
 * Both are transparent formulas over events-only data (no tracking, no model), labelled as such in the UI. */

export const PASSING_VERSION = 'passing-v1';
const PITCH_X = 105;

/** Attacking-frame x: 0 at the passer's own goal line, 105 at the goal they attack. */
const frameX = (x: number, event: Event) => event.attacking_direction === 'negative_x' ? PITCH_X - x : x;

export interface PassRating { event: Event; difficulty: number; length: number; forward: number; endX: number; completed: boolean }

/** 0–100: up to 45 for length (50 m and over), 30 for how deep the pass lands (beyond 70 m in the attacking
 * frame), 25 for forward distance (30 m and over). It describes the pass, not the passer, and ignores the outcome. */
export function passDifficulty(event: Event): PassRating | null {
  if (event.type !== 'pass' || !event.start || !event.end || !event.attacking_direction) return null;
  const length = Math.hypot(event.end.x - event.start.x, event.end.y - event.start.y);
  const endX = frameX(event.end.x, event);
  const forward = endX - frameX(event.start.x, event);
  const score = Math.min(length, 50) / 50 * 45 + Math.max(0, Math.min(endX - 70, 35)) / 35 * 30 + Math.max(0, Math.min(forward, 30)) / 30 * 25;
  return { event, difficulty: Math.round(score), length, forward, endX, completed: event.outcome === 'completed' };
}

export type Band = 'easy' | 'medium' | 'hard';
export const band = (difficulty: number): Band => difficulty >= 55 ? 'hard' : difficulty >= 30 ? 'medium' : 'easy';

export interface BandStats { attempted: number; completed: number; pct: number | null }
export interface TeamPassing {
  team_id: string;
  attempted: number;
  meanDifficulty: number | null;
  bands: Record<Band, BandStats>;
  attacks: number;
  medianAttackSpeed: number | null;
  fastest: Attack | null;
}
export interface Attack { team_id: string; possession_id: string; events: Event[]; gain: number; seconds: number; speed: number }
export interface PlayerPassing { player_id: string; attempted: number; completed: number; meanDifficulty: number; hardCompleted: number }

const pct = (completed: number, attempted: number) => attempted ? Math.round(100 * completed / attempted) : null;

/** Possessions that moved the ball forward at least 15 m over at least 2 s, from the first action's start to the
 * furthest point reached, divided by the time between those two events. */
export function attacks(events: Event[]): Attack[] {
  const groups = new Map<string, Event[]>();
  for (const event of events) {
    if (!event.possession_id || !event.team_id || !event.start || !event.attacking_direction) continue;
    const list = groups.get(event.possession_id);
    if (list) list.push(event); else groups.set(event.possession_id, [event]);
  }
  const out: Attack[] = [];
  for (const [possession_id, list] of groups) {
    const own = list.filter(event => event.team_id === list[0].team_id && event.period === list[0].period);
    if (own.length < 2) continue;
    const startX = frameX(own[0].start!.x, own[0]);
    let best = { x: startX, at: own[0] };
    for (const event of own) {
      const x = frameX((event.end ?? event.start)!.x, event);
      if (x > best.x) best = { x, at: event };
    }
    const gain = best.x - startX;
    const seconds = (best.at.match_time_ms - own[0].match_time_ms) / 1000;
    if (gain >= 15 && seconds >= 2) out.push({ team_id: own[0].team_id!, possession_id, events: own, gain, seconds, speed: gain / seconds });
  }
  return out;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface PassingSummary { ratings: PassRating[]; teams: Record<string, TeamPassing>; players: PlayerPassing[]; hardest: PassRating[] }

export function passingSummary(events: Event[], teamIds: string[]): PassingSummary {
  const ratings = events.map(passDifficulty).filter((rating): rating is PassRating => rating !== null);
  const runs = attacks(events);
  const teams: Record<string, TeamPassing> = {};
  for (const team_id of teamIds) {
    const mine = ratings.filter(rating => rating.event.team_id === team_id);
    const bands = { easy: { attempted: 0, completed: 0, pct: null }, medium: { attempted: 0, completed: 0, pct: null }, hard: { attempted: 0, completed: 0, pct: null } } as Record<Band, BandStats>;
    for (const rating of mine) {
      const b = bands[band(rating.difficulty)];
      b.attempted += 1;
      if (rating.completed) b.completed += 1;
    }
    for (const b of Object.values(bands)) b.pct = pct(b.completed, b.attempted);
    const teamRuns = runs.filter(run => run.team_id === team_id);
    teams[team_id] = {
      team_id, attempted: mine.length, bands,
      meanDifficulty: mine.length ? Math.round(mine.reduce((sum, r) => sum + r.difficulty, 0) / mine.length) : null,
      attacks: teamRuns.length,
      medianAttackSpeed: median(teamRuns.map(run => run.speed)),
      fastest: teamRuns.reduce<Attack | null>((top, run) => !top || run.speed > top.speed ? run : top, null),
    };
  }
  const byPlayer = new Map<string, PassRating[]>();
  for (const rating of ratings) {
    const id = rating.event.player_id;
    if (!id) continue;
    const list = byPlayer.get(id);
    if (list) list.push(rating); else byPlayer.set(id, [rating]);
  }
  const players = [...byPlayer].map(([player_id, list]) => ({
    player_id, attempted: list.length, completed: list.filter(r => r.completed).length,
    meanDifficulty: Math.round(list.reduce((sum, r) => sum + r.difficulty, 0) / list.length),
    hardCompleted: list.filter(r => r.completed && band(r.difficulty) === 'hard').length,
  }));
  const hardest = ratings.filter(r => r.completed).sort((a, b) => b.difficulty - a.difficulty || b.event.sequence - a.event.sequence).slice(0, 5);
  return { ratings, teams, players, hardest };
}
