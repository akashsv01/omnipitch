import { createContext, useContext } from 'react';
import type { Audience } from './prefs';
import type { Moment, Player } from '../types/contracts';
import { clockLabel, metricText } from './format';
import { goalContext, transitionBranch, TRANSITION_MIN_PROGRESS_M } from './evidence';
import { ES_UI } from './uiText';

/** Explanation language. The server sends Spanish with every insight (insight.translations.es): a validated AI
 * translation or its rule-based Spanish story (services/agents/agents/narrate_es.py). storyEs below is the same
 * story built in the browser, used only when a snapshot carries no translation. */
export type Language = 'en' | 'es';
export const LanguageContext = createContext<Language>('en');
export const useLanguage = () => useContext(LanguageContext);

const TEAM = { harbor: 'Harbor Comets', vale: 'Vale Owls' } as Record<string, string>;
// Spanish decimals use a comma; the value itself is the same shared display rule (metricText).
const n = (name: string, value: number) => metricText(name, value).replace('.', ',');
const raw = (value: unknown) => String(value).replace('.', ',');

export interface Story { headline: string; casual: string; analyst: string }

/** The rule-based story in Spanish, from the moment's own metrics and facts. */
export function storyEs(moment: Moment, roster: Player[]): Story {
  const team = TEAM[moment.team_id ?? ''] ?? 'El equipo';
  const player = roster.find(p => p.player_id === moment.player_id)?.name ?? 'Un jugador';
  const metric = (name: string) => moment.metrics.find(m => m.name === name)?.value ?? 0;
  const facts = moment.facts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const clock = clockLabel(moment.period, moment.match_time_ms);
  switch (moment.rule) {
    case 'goal': {
      const g = goalContext(moment);
      const score = (facts.score ?? {}) as Record<string, number>;
      const headline = g ? { opening: `${team} abren el marcador`, equaliser: `${team} empatan`, lead: `${team} se ponen por delante`,
        extend: `${team} amplían la ventaja`, reduce: `${team} recortan distancias` }[g.kind] : `Gol de ${team}`;
      return {
        headline,
        casual: `${player} marca desde ${n('shot_distance', metric('shot_distance'))} m. Ahora: Harbor Comets ${score.harbor ?? 0}, Vale Owls ${score.vale ?? 0}.`,
        analyst: `Gol en el ${clock}: disparo desde ${n('shot_distance', metric('shot_distance'))} m, al final de una posesión con ${Math.round(metric('possession_actions'))} acciones registradas. Marcador ${score.harbor ?? 0}-${score.vale ?? 0}.`,
      };
    }
    case 'chance': {
      const outcome = { saved: 'parado', blocked: 'bloqueado', off_target: 'fuera', goal: 'gol' }[String(facts.outcome)] ?? String(facts.outcome);
      return {
        headline: facts.outcome === 'saved' ? `${team} obligan a parar al portero` : `${team} ponen a prueba al portero`,
        casual: `${player} dispara a puerta desde ${n('shot_distance', metric('shot_distance'))} m.`,
        analyst: `Disparo a puerta en el ${clock} desde ${n('shot_distance', metric('shot_distance'))} m, resultado: ${outcome}. No se aplica un modelo de calidad de disparo.`,
      };
    }
    case 'threat_gain': {
      const where = facts.box_entry ? ' hasta el área' : facts.final_third_entry ? ' hasta el último tercio' : '';
      return {
        headline: facts.box_entry ? `${team} pasan al área` : facts.final_third_entry ? `${team} llegan al último tercio` : `${team} avanzan a una zona más peligrosa`,
        casual: metric('forward_progress') >= 1 ? `${player} lleva el balón ${n('forward_progress', metric('forward_progress'))} m hacia delante${where}.`
          : `${player} mueve el balón en horizontal${where}.`,
        analyst: `Pase completado en el ${clock}: ${n('pass_distance', metric('pass_distance'))} m de largo, ${n('forward_progress', metric('forward_progress'))} m hacia delante. Amenaza ilustrativa de ${raw(facts.start_value)} a ${raw(facts.end_value)} (+${raw(metric('threat_delta'))}).`,
      };
    }
    case 'transition': {
      const won = facts.turnover_type === 'interception' ? 'una intercepción' : 'una entrada';
      const turnover = facts.turnover_type === 'interception' ? 'intercepción ganada' : 'entrada ganada';
      const fp = n('forward_progress', metric('forward_progress')), t = n('elapsed', metric('elapsed')), actions = Math.round(metric('actions'));
      const branch = transitionBranch(moment);
      const headline = { both: `${team} salen rápido y disparan`, progress: `${team} salen rápido tras recuperar el balón`, shot: `${team} disparan poco después de recuperar el balón` }[transitionBranch(moment)];
      if (branch === 'both') return { headline,
        casual: `${player} recupera el balón con ${won}; ${team} avanzan ${fp} m y disparan en menos de ${t} segundos.`,
        analyst: `Transición en el ${clock}: ${turnover}, luego ${actions} acciones, ${fp} m de progresión y un disparo en ${t} s.` };
      if (branch === 'progress') return { headline,
        casual: `${player} recupera el balón con ${won} y ${team} avanzan ${fp} m en ${t} segundos. La jugada no termina en disparo.`,
        analyst: `Transición en el ${clock}: ${turnover}, luego ${actions} acciones y ${fp} m de progresión en ${t} s; la secuencia registrada termina sin disparo.` };
      const moved = metric('forward_progress') >= 1 ? `${fp} m de progresión` : 'sin progresión con pases';
      return { headline,
        casual: `${player} recupera el balón con ${won} y ${team} disparan ${t} segundos después.`,
        analyst: `Transición en el ${clock}: ${turnover}, luego un disparo ${t} s después, tras ${actions} acciones y ${moved}.` };
    }
    case 'pressing_change': {
      const w = facts.window ?? {};
      return {
        headline: `${team} permiten menos pases por acción defensiva`,
        casual: `${team} hicieron una acción defensiva tras menos pases del rival que en su tramo anterior.`,
        analyst: `El PPDA bajó de ${raw(metric('previous_ppda'))} a ${raw(metric('ppda'))} (${Math.round(metric('opponent_passes'))} pases rivales, ${Math.round(metric('defensive_actions'))} acciones defensivas, minutos ${Math.floor((w.start_ms ?? 0) / 60000)}-${Math.floor((w.end_ms ?? 0) / 60000)} del periodo ${moment.period}). El PPDA describe intensidad, no dónde fue la presión ni si funcionó.`,
      };
    }
  }
}

const share = (metres: number) => { const f = metres / 105; return f < .3 ? 'una cuarta parte' : f < .4 ? 'un tercio' : f < .55 ? 'casi la mitad' : 'más de la mitad'; };
const goles = (k: number) => `${k} gol${k === 1 ? '' : 'es'}`;

/** "Por qué importa", the same evidence-led context as whyItMatters (evidence.ts), in Spanish. */
export function whyEs(moment: Moment, audience: Audience): string {
  const fan = audience === 'fan';
  const metric = (name: string) => moment.metrics.find(m => m.name === name)?.value ?? 0;
  const facts = moment.facts as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (moment.rule) {
    case 'goal': {
      const g = goalContext(moment);
      if (!g) return 'Un gol, confirmado por el registro de eventos.';
      const line = `${g.mine}–${g.theirs}`;
      const text = {
        opening: `Rompe el empate: el primer gol del partido pone a ${g.team} ${line} por delante.`,
        equaliser: `Anula la ventaja de ${g.opponent} y deja el partido igualado ${line}.`,
        lead: `Convierte un empate en ventaja para ${g.team}, ${line}.`,
        extend: `Amplía la ventaja de ${g.team} a ${goles(g.mine - g.theirs)} (${line}).`,
        reduce: `Reduce la ventaja de ${g.opponent} a ${goles(g.theirs - g.mine)} (${line}).`,
      }[g.kind];
      return fan ? text : `${text} Marcador antes de este gol: ${g.mine - 1}–${g.theirs}.`;
    }
    case 'transition': {
      const fp = n('forward_progress', metric('forward_progress')), t = n('elapsed', metric('elapsed'));
      const branch = transitionBranch(moment);
      if (fan) return {
        shot: `Velocidad más que distancia: el disparo llegó ${t} s después de recuperar el balón, con solo ${fp} m ganados.`,
        progress: `Es ${share(metric('forward_progress'))} de la longitud del campo: una acción defensiva convertida en ataque. No hubo disparo.`,
        both: `Es ${share(metric('forward_progress'))} de la longitud del campo, y el ataque aún terminó en disparo: las dos cosas que busca esta regla.`,
      }[branch];
      return {
        shot: `Disparador: disparo en los 12 s tras la recuperación (${t} s). La progresión, ${fp} m, está por debajo del umbral de ${TRANSITION_MIN_PROGRESS_M} m.`,
        progress: `Disparador: al menos ${TRANSITION_MIN_PROGRESS_M} m de progresión en 12 s (${fp} m en ${t} s). La secuencia registrada termina sin disparo.`,
        both: `Se cumplen ambos disparadores: al menos ${TRANSITION_MIN_PROGRESS_M} m de progresión (${fp} m) y un disparo en 12 s (${t} s).`,
      }[branch];
    }
    case 'chance':
      return fan ? 'El portero tuvo que intervenir: un disparo a puerta desde cerca es la ocasión más clara que estos datos pueden identificar. La calidad de la ocasión no se modela.'
        : `Disparador: disparo a puerta desde 18 m o menos (${n('shot_distance', metric('shot_distance'))} m). No se aplica un modelo de goles esperados.`;
    case 'threat_gain': {
      const ratio = facts.start_value > 0 ? facts.end_value / facts.start_value : null;
      return fan ? `La cuadrícula ilustrativa de OmniPitch valora la nueva posición ${ratio && ratio >= 1.5 ? `unas ${Math.round(ratio)} veces` : 'claramente'} más peligrosa que el punto de partida. Es un paso hacia una ocasión, no una ocasión.`
        : `Amenaza ilustrativa ${raw(facts.start_value)} → ${raw(facts.end_value)} (Δ ${raw(metric('threat_delta'))}, umbral ≥ 0,1); primer pase que lo cumple en esta posesión.`;
    }
    case 'pressing_change':
      return fan ? `${TEAM[moment.team_id ?? ''] ?? 'El equipo'} permitió menos pases antes de cada acción defensiva que en su tramo anterior (${raw(metric('previous_ppda'))} → ${raw(metric('ppda'))}). El rival dio menos pases antes de ser presionado. Estos datos no muestran dónde fue la presión ni si funcionó.`
        : `PPDA ${raw(metric('previous_ppda'))} → ${raw(metric('ppda'))} (umbral: como mucho el 60% de la ventana válida anterior). Un PPDA más bajo describe intensidad, no éxito.`;
  }
}

/** Interface words used around the explanations. */
export const UI: Record<Language, Record<string, string>> = {
  en: { whatHappened: 'What happened?', whyMatters: 'Why does it matter?', whyBtn: 'Why this matters', jump: 'Jump to moment',
    keyMoments: 'Key moments', aiEnglish: '', 'Forward progression': 'Forward progression', 'Sequence time': 'Sequence time',
    'Shot distance': 'Shot distance', 'Pass length': 'Pass length', whyPrefix: 'Why it matters. ',
    ruleBased: 'Rule-based', aiValidated: 'AI · validated', synthetic: 'Synthetic match data', recap: 'Match recap' },
  es: { whatHappened: '¿Qué pasó?', whyMatters: '¿Por qué importa?', whyBtn: 'Por qué importa', jump: 'Ir a la jugada',
    keyMoments: 'Momentos clave', aiEnglish: 'Texto escrito por IA: disponible solo en inglés.', 'Forward progression': 'Progresión',
    'Sequence time': 'Tiempo de la secuencia', 'Shot distance': 'Distancia del disparo', 'Pass length': 'Longitud del pase', whyPrefix: 'Por qué importa. ',
    ruleBased: 'Basado en reglas', aiValidated: 'IA · validado', synthetic: 'Datos de partido sintéticos', recap: 'Resumen' },
};

/** The story to show: the Spanish rule-based version, or the original when it is AI-written or English is chosen. */
export function localStory(moment: Moment, roster: Player[], language: Language): Story & { englishOnly: boolean } {
  const original = { headline: moment.insight.headline, casual: moment.insight.casual_text, analyst: moment.insight.analyst_text };
  if (language === 'en') return { ...original, englishOnly: false };
  // The server's Spanish: a validated AI translation, or the rule-based Spanish story from the same moment.
  const es = moment.insight.translations?.es;
  if (es) return { headline: es.headline, casual: es.casual_text, analyst: es.analyst_text, englishOnly: false };
  if (moment.insight.generation_mode === 'ai') return { ...original, englishOnly: true };
  return { ...storyEs(moment, roster), englishOnly: false };
}

/** tr('English label') returns the label in the viewer's language. */
export function useTr() {
  const language = useLanguage();
  return (text: string) => language === 'es' ? ES_UI[text] ?? text : text;
}

export { num, setUiLanguage, t } from './uiText';
