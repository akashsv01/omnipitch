import { History, X } from 'lucide-react';
import type { Event, MatchState, Moment, Player } from '../types/contracts';
import { RULE_LABEL, clockLabel, teamTone } from '../lib/format';
import { localStory, useLanguage, useTr, type Language } from '../lib/i18n';

/** Where this viewer joined a shared replay: the latest event sequence they first saw, per run. */
export interface JoinPoint { run: string; sequence: number }

export interface CatchUpData {
  joinedAt: string;
  score: { home: number; away: number };
  missed: Moment[];
  picks: Moment[];
}

const KEY = (run: string) => `omnipitch.joined.${run}`;

/** The join point for this run, kept for the browser tab so a refresh does not move it. */
export function readJoin(run: string, sequence: number): JoinPoint & { dismissed: boolean } {
  try {
    const stored = JSON.parse(sessionStorage.getItem(KEY(run)) ?? 'null');
    if (stored && typeof stored.sequence === 'number') return { run, sequence: stored.sequence, dismissed: !!stored.dismissed };
    sessionStorage.setItem(KEY(run), JSON.stringify({ sequence }));
  } catch { /* Storage can be unavailable; the join point then lasts for this page only. */ }
  return { run, sequence, dismissed: false };
}

export function storeDismissed(join: JoinPoint) {
  try { sessionStorage.setItem(KEY(join.run), JSON.stringify({ sequence: join.sequence, dismissed: true })); } catch { /* Ignore. */ }
}

/** What happened before the viewer joined, from the same verified moments and goal events the rest of the room shows.
 * Null when they joined at kick-off or nothing had been detected yet. */
export function catchUp(join: JoinPoint | null, state: MatchState, events: Event[], moments: Moment[]): CatchUpData | null {
  if (!join || join.run !== state.run_id || join.sequence <= 0) return null;
  const last = events[Math.min(join.sequence, events.length) - 1];
  if (!last) return null;
  const score = { home: 0, away: 0 };
  for (const event of events) {
    if (event.sequence > join.sequence) break;
    if (event.type === 'shot' && event.is_goal) score[event.team_id === state.home_team.id ? 'home' : 'away'] += 1;
  }
  const missed = moments.filter(moment => moment.source_sequence <= join.sequence);
  if (!missed.length && !score.home && !score.away) return null;
  // Goals first, then chances, then the strongest of the rest; shown in match order.
  const rank = (moment: Moment) => (moment.rule === 'goal' ? 2 : moment.rule === 'chance' ? 1 : 0);
  const picks = [...missed].sort((a, b) => rank(b) - rank(a) || b.priority - a.priority || b.source_sequence - a.source_sequence)
    .slice(0, 3).sort((a, b) => a.source_sequence - b.source_sequence);
  return { joinedAt: clockLabel(last.period, last.match_time_ms), score, missed, picks };
}

const TEXT: Record<Language, { eyebrow: string; joined: string; before: string; dismiss: string; none: string }> = {
  en: { eyebrow: 'Catch up', joined: 'You joined at', before: 'Before you arrived', dismiss: 'Dismiss catch-up', none: 'No moments were detected before you arrived.' },
  es: { eyebrow: 'Ponte al día', joined: 'Llegaste en el', before: 'Antes de que llegaras', dismiss: 'Cerrar resumen', none: 'No se detectaron momentos antes de que llegaras.' },
};

function counts(language: Language, missed: Moment[]) {
  const goals = missed.filter(m => m.rule === 'goal').length;
  const chances = missed.filter(m => m.rule === 'chance').length;
  const other = missed.length - goals - chances;
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = language === 'es'
    ? [part(goals, 'gol', 'goles'), part(chances, 'ocasión', 'ocasiones'), part(other, 'otro momento', 'otros momentos')]
    : [part(goals, 'goal', 'goals'), part(chances, 'chance', 'chances'), part(other, 'other moment', 'other moments')];
  return parts.filter(Boolean).join(' · ');
}

/** "You joined at 63'": the score then, how much was detected, and up to three moments to open first. */
export function CatchUpCard({ data, state, roster, onChoose, onDismiss }: {
  data: CatchUpData; state: MatchState; roster: Player[]; onChoose: (moment: Moment) => void; onDismiss: () => void;
}) {
  const language = useLanguage(), t = TEXT[language], tr = useTr();
  return <section className="catch-up" aria-labelledby="catch-up-title" lang={language}>
    <div className="catch-up-head">
      <span className="catch-up-eyebrow"><History size={13} aria-hidden="true" />{t.eyebrow}</span>
      <button type="button" className="icon-button" aria-label={t.dismiss} onClick={onDismiss}><X size={15} /></button>
    </div>
    <h3 id="catch-up-title">{t.joined} {data.joinedAt}</h3>
    <p className="catch-up-score">
      {t.before}: <b>{state.home_team.name} {data.score.home}–{data.score.away} {state.away_team.name}</b>
      {data.missed.length > 0 && <span className="num">{counts(language, data.missed)}</span>}
    </p>
    {data.picks.length
      ? <ol className="catch-up-list">
          {data.picks.map(moment => <li key={moment.moment_id}>
            <button type="button" className="moment-row" style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}
              onClick={() => onChoose(moment)}>
              <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
              <span className="title">{localStory(moment, roster, language).headline}</span>
              <span className="sub">{tr(RULE_LABEL[moment.rule])}</span>
            </button>
          </li>)}
        </ol>
      : <p className="quiet-note">{t.none}</p>}
  </section>;
}
