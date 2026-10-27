import { useMemo, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import type { ReplaySnapshot } from '../types/contracts';
import type { Language } from '../lib/prefs';
import { clockLabel } from '../lib/format';
import { momentumSlots } from './Scoreboard';

const INTRO_KEY = 'omnipitch.introSeen';

/** "The story so far": one grounded sentence under the score, so a visitor reads score → story → moments → analysis.
 * Built only from the detected goals and the momentum band (the same numbers the timeline draws), never estimated.
 * On a first visit it also says how the room works, once. */
export function StoryLine({ replay, language, onRecap }: { replay: ReplaySnapshot; language: Language; onRecap: () => void }) {
  const es = language === 'es';
  const [intro, setIntro] = useState(() => { try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch { return false; } });
  const closeIntro = () => { setIntro(false); try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* private mode: show again next time */ } };
  const { state } = replay;
  const story = useMemo(() => {
    const short = (id?: string | null) => (id === state.home_team.id ? state.home_team.name : state.away_team.name).split(' ')[0];
    if (!state.latest_event_sequence) {
      return es ? 'El partido aún no ha empezado. Pulsa reproducir y cada momento clave se explicará al ocurrir.'
        : 'The match has not started. Press play and each key moment is explained as it happens.';
    }
    const goals = replay.moments.filter(m => m.rule === 'goal').map(m => `${short(m.team_id)} ${clockLabel(m.period, m.match_time_ms)}`);
    const score = `${state.score.home}–${state.score.away}`;
    const lead = goals.length
      ? (es ? `${score} con goles de ${goals.join(', ')}.` : `${score}, with goals from ${goals.join(', ')}.`)
      : (es ? `${score}, todavía sin goles.` : `${score}, no goals yet.`);
    // The last three 5-minute slots of the momentum band played so far.
    const recent = momentumSlots(replay.analysis.momentum).values.filter(v => v.seen).slice(-3);
    const harbor = recent.reduce((sum, v) => sum + v.harbor, 0), vale = recent.reduce((sum, v) => sum + v.vale, 0);
    const home = short('harbor'), away = short('vale');  // the band's two series
    const trend = harbor + vale < .3
      ? (es ? 'Ninguno ha generado mucho peligro en los últimos 15 minutos.' : 'Neither side has created much danger in the last 15 minutes.')
      : harbor > vale * 1.3 ? (es ? `${home} ha llevado más balones a zonas de peligro en los últimos 15 minutos.` : `${home} have moved the ball into danger more often in the last 15 minutes.`)
      : vale > harbor * 1.3 ? (es ? `${away} ha llevado más balones a zonas de peligro en los últimos 15 minutos.` : `${away} have moved the ball into danger more often in the last 15 minutes.`)
      : (es ? 'Los últimos 15 minutos han estado igualados.' : 'The last 15 minutes have been even.');
    return `${lead} ${trend}`;
  }, [replay.moments, replay.analysis.momentum, state, es]);
  return <div className="story-line">
    <p><BookOpen size={15} aria-hidden="true" /><b>{es ? 'La historia hasta ahora' : 'The story so far'}</b><span>{story}</span></p>
    {state.latest_event_sequence > 0 && <button type="button" className="text-button" onClick={onRecap}>{es ? 'Leer el resumen' : 'Read the match story'}</button>}
    {intro && <p className="story-intro">
      <span>{es ? '¿Primera vez? Pulsa reproducir. Cada momento clave se explica en Momentos clave; una marca de la línea de tiempo abre el suyo.'
        : 'New here? Press play to follow the match. Each key moment is explained under Key moments; a marker on the timeline opens its moment.'}</span>
      <button type="button" className="icon-button" aria-label={es ? 'Entendido' : 'Got it'} onClick={closeIntro}><X size={14} /></button>
    </p>}
  </div>;
}
