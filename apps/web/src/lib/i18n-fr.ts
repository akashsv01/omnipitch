import type { Audience } from './prefs';
import type { Moment, Player } from '../types/contracts';
import { clockLabel, metricText } from './format';
import { goalContext, transitionBranch, TRANSITION_MIN_PROGRESS_M } from './evidence';
import type { Story } from './i18n';

/** French versions of the rule-based stories, branch for branch with storyEs/whyEs (and narrate.py), from the same
 * moment facts, so every language states the same numbers. */
const TEAM = { harbor: 'Harbor Comets', vale: 'Vale Owls' } as Record<string, string>;
// French decimals use a comma; the value itself is the shared display rule (metricText).
const n = (name: string, value: number) => metricText(name, value).replace('.', ',');
const raw = (value: unknown) => String(value).replace('.', ',');

export function storyFr(moment: Moment, roster: Player[]): Story {
  const team = TEAM[moment.team_id ?? ''] ?? 'L\'équipe';
  const player = roster.find(p => p.player_id === moment.player_id)?.name ?? 'Un joueur';
  const metric = (name: string) => moment.metrics.find(m => m.name === name)?.value ?? 0;
  const facts = moment.facts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const clock = clockLabel(moment.period, moment.match_time_ms);
  switch (moment.rule) {
    case 'goal': {
      const g = goalContext(moment);
      const score = (facts.score ?? {}) as Record<string, number>;
      const headline = g ? { opening: `${team} ouvrent le score`, equaliser: `${team} égalisent`, lead: `${team} prennent l'avantage`,
        extend: `${team} creusent l'écart`, reduce: `${team} réduisent l'écart` }[g.kind] : `But de ${team}`;
      return {
        headline,
        casual: `${player} marque à ${n('shot_distance', metric('shot_distance'))} m. Score : Harbor Comets ${score.harbor ?? 0}, Vale Owls ${score.vale ?? 0}.`,
        analyst: `But à la ${clock} : tir à ${n('shot_distance', metric('shot_distance'))} m, au terme d'une possession de ${Math.round(metric('possession_actions'))} actions enregistrées. Score ${score.harbor ?? 0}-${score.vale ?? 0}.`,
      };
    }
    case 'chance': {
      const outcome = { saved: 'arrêté', blocked: 'contré', off_target: 'à côté', goal: 'but' }[String(facts.outcome)] ?? String(facts.outcome);
      return {
        headline: `${team} mettent le gardien à contribution`,
        casual: `${player} tire cadré à ${n('shot_distance', metric('shot_distance'))} m.`,
        analyst: `Tir cadré à la ${clock} à ${n('shot_distance', metric('shot_distance'))} m, résultat : ${outcome}. Aucun modèle de qualité de tir n'est appliqué.`,
      };
    }
    case 'threat_gain': {
      const where = facts.box_entry ? ' jusque dans la surface' : facts.final_third_entry ? ' jusque dans le dernier tiers' : '';
      return {
        headline: `${team} avancent vers une zone plus dangereuse`,
        casual: `${player} fait progresser le ballon de ${n('forward_progress', metric('forward_progress'))} m${where}.`,
        analyst: `Passe réussie à la ${clock} : ${n('pass_distance', metric('pass_distance'))} m de long, ${n('forward_progress', metric('forward_progress'))} m vers l'avant. Menace illustrative de ${raw(facts.start_value)} à ${raw(facts.end_value)} (+${raw(metric('threat_delta'))}, ${facts.grid_version}).`,
      };
    }
    case 'transition': {
      const won = facts.turnover_type === 'interception' ? 'une interception' : 'un tacle';
      const turnover = facts.turnover_type === 'interception' ? 'interception gagnée' : 'tacle gagné';
      const fp = n('forward_progress', metric('forward_progress')), t = n('elapsed', metric('elapsed')), actions = Math.round(metric('actions'));
      const branch = transitionBranch(moment);
      const headline = `${team} partent vite après la récupération`;
      if (branch === 'both') return { headline,
        casual: `${player} récupère le ballon sur ${won} ; ${team} avancent de ${fp} m et tirent en moins de ${t} secondes.`,
        analyst: `Transition à la ${clock} : ${turnover}, puis ${actions} actions, ${fp} m de progression et un tir en ${t} s.` };
      if (branch === 'progress') return { headline,
        casual: `${player} récupère le ballon sur ${won} et ${team} avancent de ${fp} m en ${t} secondes. L'action ne se termine pas par un tir.`,
        analyst: `Transition à la ${clock} : ${turnover}, puis ${actions} actions et ${fp} m de progression en ${t} s ; la séquence enregistrée se termine sans tir.` };
      const moved = metric('forward_progress') >= 1 ? `${fp} m de progression` : 'sans progression par la passe';
      return { headline,
        casual: `${player} récupère le ballon sur ${won} et ${team} tirent ${t} secondes plus tard.`,
        analyst: `Transition à la ${clock} : ${turnover}, puis un tir ${t} s plus tard, après ${actions} actions et ${moved}.` };
    }
    case 'pressing_change': {
      const w = facts.window ?? {};
      return {
        headline: `${team} pressent plus haut`,
        casual: `${team} coupent plus souvent la relance adverse sur cette période.`,
        analyst: `Le PPDA est passé de ${raw(metric('previous_ppda'))} à ${raw(metric('ppda'))} (${Math.round(metric('opponent_passes'))} passes adverses, ${Math.round(metric('defensive_actions'))} actions défensives, minutes ${Math.floor((w.start_ms ?? 0) / 60000)}-${Math.floor((w.end_ms ?? 0) / 60000)} de la période ${moment.period}). Compatible avec un pressing plus intense.`,
      };
    }
  }
}

const share = (metres: number) => { const f = metres / 105; return f < .3 ? 'un quart' : f < .4 ? 'un tiers' : f < .55 ? 'près de la moitié' : 'plus de la moitié'; };
const buts = (k: number) => `${k} but${k === 1 ? '' : 's'}`;

/** « Pourquoi c'est important », the same evidence-led context as whyItMatters (evidence.ts), in French. */
export function whyFr(moment: Moment, audience: Audience): string {
  const fan = audience === 'fan';
  const metric = (name: string) => moment.metrics.find(m => m.name === name)?.value ?? 0;
  const facts = moment.facts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (moment.rule) {
    case 'goal': {
      const g = goalContext(moment);
      if (!g) return 'Un but, confirmé par le registre des événements.';
      const line = `${g.mine}–${g.theirs}`;
      const text = {
        opening: `Il fait sauter le verrou : le premier but du match donne l'avantage à ${g.team}, ${line}.`,
        equaliser: `Il efface l'avance de ${g.opponent} et remet les équipes à égalité, ${line}.`,
        lead: `Il transforme une égalité en avantage pour ${g.team}, ${line}.`,
        extend: `Il porte l'avance de ${g.team} à ${buts(g.mine - g.theirs)} (${line}).`,
        reduce: `Il réduit l'avance de ${g.opponent} à ${buts(g.theirs - g.mine)} (${line}).`,
      }[g.kind];
      return fan ? text : `${text} Score avant ce but : ${g.mine - 1}–${g.theirs}.`;
    }
    case 'transition': {
      const fp = n('forward_progress', metric('forward_progress')), t = n('elapsed', metric('elapsed'));
      const branch = transitionBranch(moment);
      if (fan) return {
        shot: `La vitesse plus que la distance : le tir est arrivé ${t} s après la récupération, avec seulement ${fp} m gagnés.`,
        progress: `C'est ${share(metric('forward_progress'))} de la longueur du terrain : une action défensive transformée en attaque. Il n'y a pas eu de tir.`,
        both: `C'est ${share(metric('forward_progress'))} de la longueur du terrain, et l'attaque s'est quand même terminée par un tir : les deux choses que cherche cette règle.`,
      }[branch];
      return {
        shot: `Déclencheur : tir dans les 12 s après la récupération (${t} s). La progression, ${fp} m, est sous le seuil de ${TRANSITION_MIN_PROGRESS_M} m.`,
        progress: `Déclencheur : au moins ${TRANSITION_MIN_PROGRESS_M} m de progression en 12 s (${fp} m en ${t} s). La séquence enregistrée se termine sans tir.`,
        both: `Les deux déclencheurs sont remplis : au moins ${TRANSITION_MIN_PROGRESS_M} m de progression (${fp} m) et un tir en 12 s (${t} s).`,
      }[branch];
    }
    case 'chance':
      return fan ? 'Le gardien a dû intervenir : un tir cadré de près est l\'occasion la plus nette que ces données puissent identifier. La qualité de l\'occasion n\'est pas modélisée.'
        : `Déclencheur : tir cadré à 18 m ou moins (${n('shot_distance', metric('shot_distance'))} m). Aucun modèle de buts attendus n'est appliqué.`;
    case 'threat_gain': {
      const ratio = facts.start_value > 0 ? facts.end_value / facts.start_value : null;
      return fan ? `La grille illustrative d'OmniPitch juge la nouvelle position ${ratio && ratio >= 1.5 ? `environ ${Math.round(ratio)} fois` : 'nettement'} plus dangereuse que le point de départ. C'est un pas vers une occasion, pas une occasion.`
        : `Menace illustrative ${raw(facts.start_value)} → ${raw(facts.end_value)} (Δ ${raw(metric('threat_delta'))}, seuil ≥ 0,1) ; première passe de cette possession qui le remplit.`;
    }
    case 'pressing_change':
      return fan ? `${TEAM[moment.team_id ?? ''] ?? 'L\'équipe'} a laissé moins de passes avant chaque action défensive que sur la période précédente (${raw(metric('previous_ppda'))} → ${raw(metric('ppda'))}). C'est compatible avec un pressing plus haut ; cela ne prouve pas qu'il a fonctionné.`
        : `PPDA ${raw(metric('previous_ppda'))} → ${raw(metric('ppda'))} (seuil : au plus 60 % de la fenêtre valide précédente). Un PPDA plus bas décrit l'intensité, pas la réussite.`;
  }
}
