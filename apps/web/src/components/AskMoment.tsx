import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { num, useLanguage, useTr, whyEs } from '../lib/i18n';
import type { Event, Moment, Player } from '../types/contracts';
import { TRIGGER, calculationRows, metricRows, whyItMatters } from '../lib/evidence';
import { clockLabel, eventLabel, playerIndex, surname } from '../lib/format';

/** "Ask about this moment": fixed questions answered deterministically from the moment's frozen evidence, its
 * calculation and the events before it. No model is involved, so nothing can be invented; when the data cannot
 * answer, the answer says so. Sources are the recorded events; selecting one shows it in the sequence above. */
type QuestionId = 'why' | 'how' | 'before' | 'supports' | 'unknown';
const QUESTIONS: { id: QuestionId; label: string }[] = [
  { id: 'why', label: 'Why was this flagged?' }, { id: 'how', label: 'How was this calculated?' },
  { id: 'before', label: 'What happened before it?' }, { id: 'supports', label: 'What does the evidence support?' },
  { id: 'unknown', label: 'What remains unknown?' },
];

export interface Answer { lines: string[]; sources: string[]; unsupported?: string }

export function answer(question: QuestionId, moment: Moment, events: Event[], roster: Player[], language: 'en' | 'es' = 'en', tr: (s: string) => string = s => s): Answer {
  const es = language === 'es';
  const people = playerIndex(roster);
  const who = (event: Event) => event.player_id ? surname(people.get(event.player_id)) : (es ? 'sin jugador' : 'no player');
  const cited = events.filter(event => moment.evidence_ids.includes(event.event_id));
  switch (question) {
    case 'why':
      return { lines: [(es ? 'Seleccionado porque se cumplió la regla: ' : 'Selected because its rule was met: ') + tr(TRIGGER[moment.rule]) + '.',
        ...metricRows(moment).map(row => `${tr(row.label)}: ${num(row.shown)}${row.unit ? ` ${tr(row.unit)}` : ''}.`)], sources: moment.evidence_ids };
    case 'how':
      return { lines: [...calculationRows(moment).map(([term, value]) => `${term}: ${value}.`),
        es ? 'Distancias en metros sobre un campo de 105 × 68 m, en la dirección de ataque del equipo.' : 'Distances are metres on a 105 × 68 m pitch, in the attacking team\'s direction.'],
        sources: moment.evidence_ids };
    case 'before': {
      const first = cited[0];
      if (!first) return { lines: [], sources: [], unsupported: es ? 'Las acciones citadas aún no se han mostrado en la repetición.' : 'The cited actions are not shown at this point of the replay.' };
      const index = events.findIndex(event => event.event_id === first.event_id);
      const before = events.slice(Math.max(0, index - 4), index).filter(event => event.team_id);
      if (!before.length) return { lines: [], sources: [], unsupported: es ? 'No hay acciones registradas antes de esta secuencia en esta parte.' : 'Nothing was recorded before this sequence in this half.' };
      return { lines: before.map(event => `${clockLabel(event.period, event.match_time_ms)} ${eventLabel(event)} · ${who(event)}${event.possession_id === first.possession_id ? '' : es ? ' (otra posesión)' : ' (another possession)'}.`),
        sources: before.map(event => event.event_id) };
    }
    case 'supports':
      return { lines: [es ? whyEs(moment, 'analyst') : whyItMatters(moment, 'analyst'),
        `${es ? 'Acciones citadas' : 'Cited'}: ${cited.map(event => `${eventLabel(event)} · ${who(event)}`).join(', ') || (es ? 'aún no mostradas' : 'not shown yet')}.`],
        sources: moment.evidence_ids };
    case 'unknown':
      return { lines: [...moment.limitations.map(tr),
        es ? 'No registrado en estos datos: posiciones sin balón, defensores, velocidad y distancia recorrida, y por qué cada jugador eligió su acción.'
          : 'Not recorded in this data: positions off the ball, defenders, speed and distance covered, and why players chose an action.'],
        sources: [], unsupported: undefined };
  }
}

export function AskMoment({ moment, events, roster, onSource }: { moment: Moment; events: Event[]; roster: Player[]; onSource: (eventId: string) => void }) {
  const tr = useTr();
  const [asked, setAsked] = useState<QuestionId | null>(null);
  const language = useLanguage();
  const result = asked ? answer(asked, moment, events, roster, language, tr) : null;
  const people = playerIndex(roster);
  // Sources read as football: action, player and minute; the click shows that action in the sequence above.
  const label = (id: string) => { const e = events.find(x => x.event_id === id); return e ? `${eventLabel(e)} · ${surname(people.get(e.player_id ?? ''))} · ${clockLabel(e.period, e.match_time_ms)}` : null; };
  return <section className="drawer-section ask" aria-labelledby="ev-ask">
    <h3 id="ev-ask"><MessageCircleQuestion size={15} aria-hidden="true" />{tr('Ask about this moment')}</h3>
    <div className="ask-questions" role="group" aria-label="Questions">
      {QUESTIONS.map(q => <button key={q.id} type="button" className="chip" aria-pressed={asked === q.id} onClick={() => setAsked(q.id)}>{tr(q.label)}</button>)}
    </div>
    {result && <div className="ask-answer" aria-live="polite">
      {result.unsupported ? <p className="hint">{result.unsupported}</p> : <ul>{result.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      {result.sources.length > 0 && <p className="hint">{tr('Sources: ')}{result.sources.filter(id => label(id)).map(id => <button key={id} type="button" className="text-button inline" onClick={() => onSource(id)}>{label(id)}</button>)
        .reduce<React.ReactNode[]>((all, item, i) => i ? [...all, ', ', item] : [item], [])}</p>}
      <p className="hint">{tr("Answered from this moment's recorded evidence and calculations only; no AI model is used.")}</p>
    </div>}
  </section>;
}
