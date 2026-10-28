import { useMemo, useState } from 'react';
import { CornerDownLeft, Play, RotateCcw, X } from 'lucide-react';
import type { Moment, ReplaySnapshot } from '../types/contracts';
import type { Language } from '../lib/prefs';
import { clockLabel } from '../lib/format';
import { momentumSlots, replayState } from './Scoreboard';

const INTRO_KEY = 'omnipitch.introSeen';

/** The "Now" bar under the score: where the match is, the story so far in one grounded sentence, and the one thing to
 * do next as the main button. The story is built only from detected goals and the momentum band (the numbers the
 * timeline draws), never estimated. A first visit also gets one line on how the room works. */
export function NowBar({ replay, clockMs, language, inspect, disabled, onPlay, onRestart, onStopInspect, onRecap }: {
  replay: ReplaySnapshot; clockMs: number; language: Language; inspect: Moment | null; disabled: boolean;
  onPlay: () => void; onRestart: () => void; onStopInspect: () => void; onRecap: () => void;
}) {
  const es = language === 'es';
  const [intro, setIntro] = useState(() => { try { return localStorage.getItem(INTRO_KEY) !== '1'; } catch { return false; } });
  const closeIntro = () => { setIntro(false); try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* private mode: show again next time */ } };
  const { state, replay: info } = replay;
  const status = replayState(state, info, clockMs);
  const now = clockLabel(info.clock_period, clockMs);

  const story = useMemo(() => {
    if (!state.latest_event_sequence) return es ? 'Cada momento clave se explica en cuanto ocurre.' : 'Each key moment is explained as it happens.';
    const short = (id?: string | null) => (id === state.home_team.id ? state.home_team.name : state.away_team.name).split(' ')[0];
    const current = `${state.score.home}–${state.score.away}`;
    if (inspect) {
      // Looking back: the story stops at that moment's evidence; the live score is labelled as the current one.
      const cutoff = inspect.source_sequence;
      const at = { home: 0, away: 0 };
      for (const event of replay.events) {
        if (event.sequence > cutoff) break;
        if (event.type === 'shot' && event.is_goal) at[event.team_id === state.home_team.id ? 'home' : 'away'] += 1;
      }
      const before = replay.moments.filter(m => m.rule === 'goal' && m.source_sequence <= cutoff).map(m => `${short(m.team_id)} ${clockLabel(m.period, m.match_time_ms)}`);
      const then = before.length
        ? (es ? `En ese momento, ${at.home}–${at.away} con goles de ${before.join(', ')}.` : `At that point it was ${at.home}–${at.away}, with goals from ${before.join(', ')}.`)
        : (es ? `En ese momento, ${at.home}–${at.away}, todavía sin goles.` : `At that point it was ${at.home}–${at.away}, with no goals yet.`);
      return `${then} ${es ? `Ahora el partido va ${current}, en el ${now}.` : `The match is now ${current} at ${now}.`}`;
    }
    const goals = replay.moments.filter(m => m.rule === 'goal').map(m => `${short(m.team_id)} ${clockLabel(m.period, m.match_time_ms)}`);
    const score = current;
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
  }, [replay.moments, replay.events, replay.analysis.momentum, state, es, inspect, now]);

  // Where the match is, in words, and the one next step for that state.
  const where = inspect ? (es ? `Revisando el ${clockLabel(inspect.period, inspect.match_time_ms)}.` : `Looking back at ${clockLabel(inspect.period, inspect.match_time_ms)}.`)
    : status === 'pre' ? (es ? 'Listo para empezar.' : 'Ready to start.')
    : status === 'finished' ? (es ? 'Final del partido.' : 'Full-time.')
    : status === 'playing' ? (es ? `Repetición en el ${now} · ${info.speed}×.` : `Replaying, ${now} · ${info.speed}×.`)
    : status === 'half' ? (es ? 'Descanso.' : 'Half-time.')
    : (es ? `En pausa en el ${now}.` : `Paused at ${now}.`);
  const action = inspect ? { label: es ? `Volver al ${now}` : `Back to ${now}`, icon: CornerDownLeft, run: onStopInspect }
    : status === 'pre' ? { label: es ? 'Empezar el partido' : 'Start the match', icon: Play, run: onPlay }
    : status === 'finished' ? { label: es ? 'Ver otra vez' : 'Watch again', icon: RotateCcw, run: onRestart }
    : status === 'playing' ? null
    : { label: es ? 'Continuar' : 'Resume', icon: Play, run: onPlay };

  return <section className="now-bar" aria-label={es ? 'Ahora' : 'Now'}>
    <p className="now-text" aria-live="polite"><b>{where}</b> <span>{story}</span></p>
    <div className="now-actions">
      {state.latest_event_sequence > 0 && <button type="button" className="text-button" onClick={onRecap}>{es ? 'Leer el resumen' : 'Read the match story'}</button>}
      {action && <button type="button" className="button primary" onClick={action.run} disabled={disabled && !inspect}>
        <action.icon size={15} aria-hidden="true" fill={action.icon === Play ? 'currentColor' : 'none'} />{action.label}</button>}
    </div>
    {intro && <p className="now-intro">
      <span>{es ? '¿Primera vez? El campo muestra los últimos pases; cada momento clave se explica en Momentos clave, y una marca de la línea de tiempo abre el suyo.'
        : 'New here? The pitch shows the latest passes, each key moment is explained under Key moments, and a marker on the timeline opens its moment.'}</span>
      <button type="button" className="icon-button" aria-label={es ? 'Entendido' : 'Got it'} onClick={closeIntro}><X size={14} /></button>
    </p>}
  </section>;
}
