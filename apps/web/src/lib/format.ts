import type { Event, Moment, Player, Rule } from '../types/contracts';
import { t } from './uiText';

export const TEAM_META: Record<string, { short: string; name: string; tone: string }> = {
  harbor: { short: 'HAR', name: 'Harbor Comets', tone: 'var(--harbor)' },
  vale: { short: 'VAL', name: 'Vale Owls', tone: 'var(--vale)' },
};

export const teamTone = (team: string | null | undefined) => (team && TEAM_META[team]?.tone) || 'var(--chalk-dim)';

/** Broadcast clock: period-local minute with stoppage shown as 45+2'. */
export function clockLabel(period: 1 | 2, ms: number): string {
  const minute = Math.floor(ms / 60000) + 1;
  const base = period === 1 ? 45 : 90;
  return minute > 45 ? `${base}+${minute - 45}'` : `${minute + base - 45}'`;
}

/** Running clock as mm:ss with the period offset (45:00 starts the second half). */
export function runningClock(period: 1 | 2, ms: number): string {
  const total = Math.floor(ms / 1000) + (period === 2 ? 45 * 60 : 0);
  const cap = period === 1 ? 45 * 60 : 90 * 60;
  const shown = Math.min(total, cap);
  const mm = String(Math.floor(shown / 60)).padStart(2, '0');
  const ss = String(shown % 60).padStart(2, '0');
  const extra = total > cap ? total - cap : 0;
  // Stoppage time counts like the broadcast minute: the first added minute is +1 (never +0), matching 45+1'.
  return extra ? `${mm}:${ss} +${Math.floor(extra / 60) + 1}` : `${mm}:${ss}`;
}

export const RULE_LABEL: Record<Rule, string> = {
  goal: 'Goal', chance: 'Chance', threat_gain: 'Threat gain', transition: 'Transition', pressing_change: 'Pressing',
};

export function eventLabel(event: Event): string {
  switch (event.type) {
    case 'pass': return t(event.outcome === 'completed' ? 'Pass' : 'Incomplete pass');
    case 'shot': return t({ goal: 'Goal', saved: 'Shot saved', off_target: 'Shot wide', blocked: 'Shot blocked' }[event.outcome as 'goal'] ?? 'Shot');
    case 'tackle': return t(event.outcome === 'won' ? 'Tackle won' : 'Tackle missed');
    case 'challenge': return t(event.outcome === 'won' ? 'Duel won' : 'Duel lost');
    case 'interception': return t('Interception');
    case 'foul': return t('Foul');
    case 'period_start': return t(event.period === 1 ? 'Kick-off' : 'Second half');
    case 'period_end': return t(event.period === 1 ? 'Half-time' : 'Full-time');
  }
}

export function playerIndex(roster: Player[]): Map<string, Player> {
  return new Map(roster.map(player => [player.player_id, player]));
}

export const surname = (player: Player | undefined) => player ? player.name.split(' ').slice(-1)[0] : 'Unknown';

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

/** Fixed-point text with Python's tie rule: an exact half (7.25 at one decimal) rounds to the even digit, as
 * Python's `f"{v:.1f}"` does. `toFixed` rounds exact ties up instead (7.3); everything else already agrees. */
export function fixedEven(value: number, digits: number): string {
  // toFixed(100) is the exact decimal expansion of the stored double, so only true ties match.
  const exact = Math.abs(value).toFixed(100);
  const dot = exact.indexOf('.');
  if (!/^50*$/.test(exact.slice(dot + 1 + digits))) return value.toFixed(digits);
  const kept = exact.slice(0, dot + 1 + digits).replace(/\.$/, '');
  const last = Number(kept[kept.length - 1]);
  const text = last % 2 === 0 ? kept : (Math.abs(value) + .5 * 10 ** -digits).toFixed(digits);
  return value < 0 && Number(text) !== 0 ? `-${text}` : text;
}

/** The one display rule for a moment metric quoted in its story. It mirrors the backend template formatter
 * (services/agents/agents/narrate.py `_fmt`), so the number in a sentence and the number beside it are always
 * the same text:
 * - metres, seconds and counts: whole numbers as they are, otherwise one decimal (Python's rounding of the
 *   stored double), so 27.05 m reads 27.1 m and 7.25 m reads 7.2 m;
 * - threat values and PPDA: the stored value as is (already rounded by the metric code). */
export function metricText(name: string, value: number): string {
  if (name === 'threat_delta' || name === 'ppda' || name === 'previous_ppda') return String(value);
  if (Number.isInteger(value)) return String(value);
  return fixedEven(value, 1).replace(/\.0$/, '');
}

export function momentInvolves(moment: Moment, favoriteTeam: string | null, favoritePlayer: string | null) {
  return (favoritePlayer && moment.player_id === favoritePlayer) || (favoriteTeam && moment.team_id === favoriteTeam);
}

export const METRIC_LABEL: Record<string, string> = {
  shot_distance: 'Shot distance', possession_actions: 'Possession actions', threat_delta: 'Threat change',
  forward_progress: 'Forward progression', pass_distance: 'Pass length', elapsed: 'Sequence time', actions: 'Actions',
  ppda: 'PPDA', previous_ppda: 'Previous PPDA', opponent_passes: 'Opponent passes', defensive_actions: 'Defensive actions',
};
