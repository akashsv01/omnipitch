import type { Event, Moment, Player, Rule } from '../types/contracts';

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
  return extra ? `${mm}:${ss} +${Math.floor(extra / 60)}` : `${mm}:${ss}`;
}

export const RULE_LABEL: Record<Rule, string> = {
  goal: 'Goal', chance: 'Chance', threat_gain: 'Threat gain', transition: 'Transition', pressing_change: 'Pressing',
};

export function eventLabel(event: Event): string {
  switch (event.type) {
    case 'pass': return event.outcome === 'completed' ? 'Pass' : 'Pass lost';
    case 'shot': return { goal: 'Goal', saved: 'Shot saved', off_target: 'Shot wide', blocked: 'Shot blocked' }[event.outcome as 'goal'] ?? 'Shot';
    case 'tackle': return event.outcome === 'won' ? 'Tackle won' : 'Tackle missed';
    case 'challenge': return event.outcome === 'won' ? 'Duel won' : 'Duel lost';
    case 'interception': return 'Interception';
    case 'foul': return 'Foul';
    case 'period_start': return event.period === 1 ? 'Kick-off' : 'Second half';
    case 'period_end': return event.period === 1 ? 'Half-time' : 'Full-time';
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

export function momentInvolves(moment: Moment, favoriteTeam: string | null, favoritePlayer: string | null) {
  return (favoritePlayer && moment.player_id === favoritePlayer) || (favoriteTeam && moment.team_id === favoriteTeam);
}

export const METRIC_LABEL: Record<string, string> = {
  shot_distance: 'Shot distance', possession_actions: 'Possession actions', threat_delta: 'Threat change',
  forward_progress: 'Forward progress', pass_distance: 'Pass length', elapsed: 'Elapsed', actions: 'Actions',
  ppda: 'PPDA', previous_ppda: 'Previous PPDA', opponent_passes: 'Opponent passes', defensive_actions: 'Defensive actions',
};
