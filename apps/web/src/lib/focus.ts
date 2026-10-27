import type { Event, Moment, ReplaySnapshot, Rule } from '../types/contracts';
import { attacks, passDifficulty, passingSummary } from './passing';

/** One metric the viewer chose to follow: its definition, both teams' current values, a value per five-minute slot,
 * the players who lead it and the moments it produced. Every value comes from the snapshot or the events in it. */
export type FocusMetric = 'ppda' | 'threat' | 'progression' | 'difficulty' | 'attack_speed';

export interface FocusDef { id: FocusMetric; label: string; unit: string; digits: number; lowerBetter?: boolean; fan: string; analyst: string; rules: Rule[] }

export const FOCUS: FocusDef[] = [
  { id: 'ppda', label: 'Pressing (PPDA)', unit: '', digits: 2, lowerBetter: true, rules: ['pressing_change'],
    fan: 'How many passes a team lets the opponent make before it wins the ball back or challenges. Lower means a harder press.',
    analyst: 'Opponent passes per defensive action beyond 42 m in the defending team\'s frame, per five-minute window; windows below 10 passes or 3 actions are not plotted. Lower means more intense pressure; it does not show the press worked.' },
  { id: 'threat', label: 'Threat', unit: '', digits: 2, rules: ['threat_gain', 'chance', 'goal'],
    fan: 'How much each team moved the ball into dangerous areas with completed passes.',
    analyst: 'Sum of illustrative threat-grid gain from completed passes per five-minute slot (threat-grid v1, uncalibrated; not a goal probability).' },
  { id: 'progression', label: 'Forward progression', unit: 'm', digits: 0, rules: ['transition', 'threat_gain'],
    fan: 'Metres each team moved the ball towards goal with completed passes.',
    analyst: 'Forward metres of completed passes in each team\'s attacking frame, per five-minute slot.' },
  { id: 'difficulty', label: 'Pass difficulty', unit: '/100', digits: 0, rules: [],
    fan: 'How ambitious each team\'s passing is: long, forward passes that land deep score higher.',
    analyst: 'Mean passing-v1 difficulty of attempted passes per five-minute slot (length, landing depth, forward distance; outcome not used).' },
  { id: 'attack_speed', label: 'Speed of attack', unit: 'm/s', digits: 1, rules: ['transition'],
    fan: 'How quickly each team moves the ball upfield once it has it.',
    analyst: 'Median forward metres per second of possessions gaining ≥ 15 m over ≥ 2 s, by the slot in which the possession started.' },
];
export const focusDef = (id: FocusMetric) => FOCUS.find(f => f.id === id)!;

const slotOf = (period: 1 | 2, ms: number) => (period - 1) * 10 + Math.min(9, Math.floor(ms / 300000));
const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface FocusLeader { player_id: string; team_id: string; value: number }
export interface FocusView {
  current: Record<string, number | null>;
  slots: Record<string, (number | null)[]>;
  leaders: FocusLeader[];
  leaderLabel: string;
  moments: Moment[];
}

export function focusView(metric: FocusMetric, replay: ReplaySnapshot): FocusView {
  const teams = [replay.state.home_team.id, replay.state.away_team.id];
  const blank = () => Array<number | null>(20).fill(null);
  const slots: Record<string, (number | null)[]> = Object.fromEntries(teams.map(t => [t, blank()]));
  const current: Record<string, number | null> = {};
  const { analysis, events } = replay;
  let leaders: FocusLeader[] = [];
  let leaderLabel = '';

  if (metric === 'ppda') {
    for (const w of analysis.ppda_series) if (w.closed && w.status === 'ok' && slots[w.team_id]) slots[w.team_id][slotOf(w.period, w.start_ms)] = w.value;
    for (const t of teams) { const w = analysis.ppda_current[t]; current[t] = w && w.status === 'ok' ? w.value : null; }
    leaders = analysis.players.map(p => ({ player_id: p.player_id, team_id: p.team_id, value: p.defensive_actions }));
    leaderLabel = 'defensive actions';
  } else if (metric === 'threat') {
    for (const b of analysis.momentum) for (const t of teams) {
      const i = slotOf(b.period, b.start_ms);
      slots[t][i] = (slots[t][i] ?? 0) + (b.threat[t] ?? 0);
    }
    for (const t of teams) current[t] = analysis.teams[t]?.threat_gained ?? null;
    leaders = analysis.players.map(p => ({ player_id: p.player_id, team_id: p.team_id, value: p.threat_gained }));
    leaderLabel = 'threat added';
  } else if (metric === 'progression' || metric === 'difficulty') {
    const sums: Record<string, number[][]> = Object.fromEntries(teams.map(t => [t, Array.from({ length: 20 }, () => [] as number[])]));
    for (const e of events) {
      const r = passDifficulty(e);
      if (!r || !e.team_id || !sums[e.team_id]) continue;
      if (metric === 'progression') { if (r.completed) sums[e.team_id][slotOf(e.period, e.match_time_ms)].push(Math.max(0, r.forward)); }
      else sums[e.team_id][slotOf(e.period, e.match_time_ms)].push(r.difficulty);
    }
    const seen = new Set(events.filter(e => e.match_time_ms >= 0).map(e => slotOf(e.period, e.match_time_ms)));
    for (const t of teams) slots[t] = sums[t].map((list, i) => !seen.has(i) ? null
      : metric === 'progression' ? list.reduce((a, b) => a + b, 0) : list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
    const passing = passingSummary(events, teams);
    if (metric === 'progression') {
      for (const t of teams) current[t] = analysis.teams[t]?.progression_m ?? null;
      leaders = analysis.players.map(p => ({ player_id: p.player_id, team_id: p.team_id, value: p.progression_m }));
      leaderLabel = 'metres forward';
    } else {
      for (const t of teams) current[t] = passing.teams[t].meanDifficulty;
      const team = new Map(analysis.players.map(p => [p.player_id, p.team_id]));
      leaders = passing.players.filter(p => p.attempted >= 10).map(p => ({ player_id: p.player_id, team_id: team.get(p.player_id) ?? '', value: p.meanDifficulty }));
      leaderLabel = 'average difficulty (10+ passes)';
    }
  } else {
    const runs = attacks(events);
    for (const t of teams) {
      const mine = runs.filter(r => r.team_id === t);
      current[t] = median(mine.map(r => r.speed));
      slots[t] = Array.from({ length: 20 }, (_, i) => median(mine.filter(r => slotOf(r.events[0].period, r.events[0].match_time_ms) === i).map(r => r.speed)));
    }
    const byPlayer = new Map<string, { team_id: string; best: number }>();
    for (const r of runs) {
      const last: Event = r.events[r.events.length - 1];
      if (!last.player_id) continue;
      const prev = byPlayer.get(last.player_id);
      if (!prev || r.speed > prev.best) byPlayer.set(last.player_id, { team_id: r.team_id, best: r.speed });
    }
    leaders = [...byPlayer].map(([player_id, v]) => ({ player_id, team_id: v.team_id, value: v.best }));
    leaderLabel = 'fastest attack finished (m/s)';
  }
  const def = focusDef(metric);
  leaders = leaders.filter(l => l.value > 0).sort((a, b) => b.value - a.value).slice(0, 3);
  const moments = def.rules.length ? replay.moments.filter(m => def.rules.includes(m.rule)).sort((a, b) => b.source_sequence - a.source_sequence).slice(0, 4) : [];
  return { current, slots, leaders, leaderLabel, moments };
}
