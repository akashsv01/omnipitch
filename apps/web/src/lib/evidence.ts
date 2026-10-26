import type { Audience } from './prefs';
import type { Moment } from '../types/contracts';
import { METRIC_LABEL, fmt, metricText } from './format';

/** Shared moment facts for both audiences. Presentation differs; the numbers and rules never do. */

// Mirrors the detector's transition trigger (services/analytics detect.py); used only to choose wording.
export const TRANSITION_MIN_PROGRESS_M = 35;

const TEAM_NAME: Record<string, string> = { harbor: 'Harbor Comets', vale: 'Vale Owls' };
const metricValue = (moment: Moment, name: string) => moment.metrics.find(m => m.name === name)?.value;

/** Which transition trigger fired: a long advance, a quick shot after the regain, or both. Same rule as the
 * backend template (narrate.py transition_branch), so the story and the "why" never disagree. */
export function transitionBranch(moment: Moment): 'both' | 'progress' | 'shot' {
  const long = (metricValue(moment, 'forward_progress') ?? 0) >= TRANSITION_MIN_PROGRESS_M;
  const shot = !!(moment.facts as Record<string, unknown>).ended_in_shot;
  return long && shot ? 'both' : long ? 'progress' : 'shot';
}

/** What a goal did to the score, from the frozen score after it (narrate.py goal_context). */
export function goalContext(moment: Moment) {
  const score = (moment.facts as { score?: Record<string, number> }).score;
  const team = moment.team_id;
  if (!score || !team || !(team in score)) return null;
  const mine = score[team];
  const opponent = Object.keys(score).find(other => other !== team);
  const theirs = opponent ? score[opponent] : 0;
  const before = mine - 1;
  const kind: 'opening' | 'equaliser' | 'lead' | 'extend' | 'reduce' = before === 0 && theirs === 0 ? 'opening' : mine === theirs ? 'equaliser'
    : before === theirs ? 'lead' : before > theirs ? 'extend' : 'reduce';
  return { kind, mine, theirs, team: TEAM_NAME[team] ?? team, opponent: opponent ? TEAM_NAME[opponent] ?? opponent : 'the opponents' };
}

const goals = (n: number) => `${n} goal${n === 1 ? '' : 's'}`;
// Share of the simulated pitch's 105 m length, in words (context the story does not state).
const share = (metres: number) => { const f = metres / 105; return f < .3 ? 'about a quarter' : f < .4 ? 'about a third' : f < .55 ? 'almost half' : 'more than half'; };

/** "Why it matters", built from this moment's own evidence. It adds context the story does not already state
 * (the trigger that fired, what changed in the score, before/after values) and never claims defenders beaten,
 * overloads or tactical success. Fans get plain words; analysts get the trigger and thresholds. */
export function whyItMatters(moment: Moment, audience: Audience): string {
  const fan = audience === 'fan';
  const m = (name: string) => metricValue(moment, name);
  const facts = moment.facts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (moment.rule) {
    case 'goal': {
      const g = goalContext(moment);
      if (!g) return fan ? 'A goal, confirmed by the event record.' : 'Validated shot with is_goal = true; score facts were not available.';
      const line = `${g.mine}–${g.theirs}`;
      const text = {
        opening: `It breaks the deadlock: the first goal of the match puts ${g.team} ${line} up.`,
        equaliser: `It wipes out ${g.opponent}'s lead and brings the match level at ${line}.`,
        lead: `It turns a level match into a ${g.team} lead, ${line}.`,
        extend: `It stretches ${g.team}'s margin to ${goals(g.mine - g.theirs)} (${line}).`,
        reduce: `It cuts ${g.opponent}'s margin to ${goals(g.theirs - g.mine)} (${line}).`,
      }[g.kind];
      return fan ? text : `${text} Score before this goal: ${g.mine - 1}–${g.theirs}.`;
    }
    case 'transition': {
      const progress = metricText('forward_progress', m('forward_progress') ?? 0), time = metricText('elapsed', m('elapsed') ?? 0);
      const branch = transitionBranch(moment);
      if (fan) return {
        shot: `Speed rather than distance: the shot came ${time} s after winning the ball, with only ${progress} m gained.`,
        progress: `That is ${share(m('forward_progress') ?? 0)} of the pitch's length, turning a defensive action straight into an attack. No shot followed.`,
        both: `That is ${share(m('forward_progress') ?? 0)} of the pitch's length, and the attack still ended in a shot: both things this rule looks for.`,
      }[branch];
      return {
        shot: `Trigger: shot within 12 s of the regain (${time} s). Forward progression, ${progress} m, is below the 35 m progression trigger.`,
        progress: `Trigger: at least 35 m of forward progress within 12 s (${progress} m in ${time} s). The recorded sequence ends without a shot.`,
        both: `Both triggers met: forward progress of at least 35 m (${progress} m) and a shot within 12 s (${time} s).`,
      }[branch];
    }
    case 'chance': {
      const d = metricText('shot_distance', m('shot_distance') ?? 0);
      return fan ? 'The goalkeeper had to deal with it: an on-target shot from close range is the clearest kind of chance this data can identify. How good the chance was is not modelled.'
        : `Trigger: on-target shot from 18 m or closer (${d} m; outcome ${String(facts.outcome ?? '').replace('_', ' ')}). No expected-goals model is applied.`;
    }
    case 'threat_gain': {
      const entry = facts.box_entry ? ' into the penalty area' : facts.final_third_entry ? ' into the final third' : '';
      const ratio = facts.start_value > 0 ? facts.end_value / facts.start_value : null;
      return fan ? `OmniPitch's illustrative threat grid rates the new position ${ratio && ratio >= 1.5 ? `about ${Math.round(ratio)} times` : 'clearly'} more dangerous than where the pass started. It is a step towards a chance, not a chance itself.`
        : `Illustrative threat ${facts.start_value} → ${facts.end_value} (Δ ${m('threat_delta')}, trigger ≥ 0.1); first qualifying pass in this possession${entry ? `, entry${entry}` : ''}.`;
    }
    case 'pressing_change': {
      const before = m('previous_ppda'), now = m('ppda');
      return fan ? `${TEAM_NAME[moment.team_id ?? ''] ?? 'The team'} allowed fewer passes before each defensive action than in their previous spell (${before} → ${now}). That is consistent with pressing higher; it does not show the press worked.`
        : `PPDA ${before} → ${now} (trigger: at most 60% of the previous valid window). Lower PPDA describes intensity, not success.`;
    }
  }
}

/** The trigger each rule applies, as a short threshold. */
export const TRIGGER: Record<Moment['rule'], string> = {
  goal: 'Validated shot with is_goal = true',
  chance: 'On-target shot from ≤ 18 m (no xG model)',
  transition: '≥ 35 m forward progress, or a shot, within 12 s of a ball win',
  threat_gain: 'Threat Δ ≥ 0.1, first qualifying pass per possession',
  pressing_change: 'PPDA ≤ 60% of the previous valid window; ≥ 10 passes, ≥ 3 actions; 10-min cooldown',
};

export const AUTHOR = {
  ai: 'The AI model (three roles) from this evidence only. Code then checked every number, name, event ID and claim (score, box, passes, defenders), and the API re-checks it before showing it.',
  fallback: 'A deterministic template from the metrics above. No model was involved.',
  fixture: 'A hand-authored test fixture.',
};
export type Generation = 'ai' | 'rule' | 'pending' | 'fallback' | 'fixture';

/** How this moment's explanation was produced, from its own insight record and the insight source:
 * - ai: AI-written and accepted by the code validator (and re-checked by the API);
 * - fallback: an AI attempt failed or was rejected, so the rule-based template is shown;
 * - pending: AI narration is switched on but has not produced this moment's insight yet;
 * - rule: rule-based template, AI narration off. */
export function generation(moment: Moment, aiMode: 'off' | 'cosmos' | string): Generation {
  const mode = moment.insight.generation_mode;
  if (mode === 'ai') return 'ai';
  if (mode === 'fixture') return 'fixture';
  if (moment.insight.limitations.some(item => item.startsWith('AI narration unavailable'))) return 'fallback';
  return aiMode !== 'off' ? 'pending' : 'rule';
}
export const GENERATION_LABEL: Record<Generation, string> = {
  ai: 'AI explanation · validation passed', rule: 'Rule-based explanation', pending: 'Rule-based · AI pending',
  fallback: 'Rule-based fallback after AI failure', fixture: 'Hand-authored fixture',
};
export const GENERATION_SHORT: Record<Generation, string> = { ai: 'AI · validated', rule: 'Rule-based', pending: 'AI pending', fallback: 'Fallback', fixture: 'Fixture' };

export interface KeyValue { label: string; value: string; unit?: string }

/** Key values for the spotlight, using the shared display rule (metricText) so they match the story text.
 * Fans get at most two plain values and never the threat index; analysts get up to three. */
export function keyValues(moment: Moment, audience: Audience): KeyValue[] {
  const metric = (name: string) => moment.metrics.find(m => m.name === name);
  const show = (name: string, label: string): KeyValue[] => {
    const m = metric(name);
    return m ? [{ label, value: metricText(name, m.value), unit: m.unit.startsWith('illustrative') ? undefined : m.unit }] : [];
  };
  const facts = moment.facts as Record<string, unknown>;
  const fan = audience === 'fan';
  switch (moment.rule) {
    case 'transition': return fan ? [...show('forward_progress', 'Forward progression'), ...show('elapsed', 'Sequence time')]
      : [...show('forward_progress', 'Forward progression'), ...show('elapsed', 'Sequence time'),
        ...(typeof facts.ended_in_shot === 'boolean' ? [{ label: 'Ends in', value: facts.ended_in_shot ? 'Shot' : 'No shot' }] : [])];
    case 'goal': return fan ? show('shot_distance', 'Shot distance') : [...show('shot_distance', 'Shot distance'), ...show('possession_actions', 'Possession actions')];
    case 'chance': return [...show('shot_distance', 'Shot distance'), ...(!fan && typeof facts.outcome === 'string' ? [{ label: 'Outcome', value: String(facts.outcome).replace('_', ' ') }] : [])];
    case 'threat_gain': return fan ? [...show('forward_progress', 'Forward progression'), ...show('pass_distance', 'Pass length')]
      : [...show('threat_delta', 'Threat Δ'), ...show('pass_distance', 'Pass length'), ...show('forward_progress', 'Forward progression')];
    case 'pressing_change': return fan ? [] : [...show('ppda', 'PPDA'), ...show('previous_ppda', 'Before')];
  }
}

/** Every metric as an aligned row: label, displayed value, stored value, unit. */
export function metricRows(moment: Moment) {
  return moment.metrics.map(m => ({ name: m.name, label: METRIC_LABEL[m.name] ?? m.name, shown: metricText(m.name, m.value), stored: String(m.value), unit: m.unit }));
}

/** How the rule's inputs combine, from the moment's own facts. */
export function calculationRows(moment: Moment): [string, string][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const facts = moment.facts as Record<string, any>;
  let rows: [string, string][] = [];
  if (moment.rule === 'threat_gain') {
    rows = [
      ['Start → end cell', `(${facts.start_cell?.join(', ')}) → (${facts.end_cell?.join(', ')}) on a 16 × 12 grid`],
      ['Threat before → after', `${facts.start_value} → ${facts.end_value} (Δ ${fmt(facts.end_value - facts.start_value, 3)})`],
      ['Grid', `${facts.grid_version}; hand-designed, uncalibrated`],
      ['Entries', [facts.final_third_entry && 'final third', facts.box_entry && 'penalty box'].filter(Boolean).join(', ') || 'none'],
    ];
  } else if (moment.rule === 'pressing_change') {
    const w = facts.window, p = facts.previous_window;
    rows = [
      ['Formula', 'opponent passes in zone ÷ defensive actions in zone'],
      ['This window', `${w.opponent_passes} ÷ ${w.defensive_actions} = ${w.value} (min ${w.start_ms / 60000}–${w.end_ms / 60000})`],
      ['Previous valid window', `${p.opponent_passes} ÷ ${p.defensive_actions} = ${p.value} (min ${p.start_ms / 60000}–${p.end_ms / 60000})`],
      ['Zone', facts.zone],
    ];
  } else if (moment.rule === 'transition') {
    rows = [['Turnover', facts.turnover_type], ['Ended in a shot', facts.ended_in_shot ? 'yes' : 'no']];
  } else if (moment.rule === 'goal') {
    rows = [['Score after goal', Object.entries(facts.score ?? {}).map(([team, goals]) => `${TEAM_NAME[team] ?? team} ${goals}`).join(', ')]];
  } else if (moment.rule === 'chance') {
    rows = [['Outcome', facts.outcome]];
  }
  return [...rows, ['Trigger', TRIGGER[moment.rule]], ['Rule version', `${moment.rule} ${moment.rule_version} · ${moment.metric_version}`]];
}
