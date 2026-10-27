import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpenText, Info, RefreshCw, UserRound } from 'lucide-react';
import type { Recap, RecapScope, ReplaySnapshot } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { fetchRecap, publicMessage, type RecapResult } from '../lib/api';
import { METRIC_LABEL, RULE_LABEL, TEAM_META, fmt, teamTone } from '../lib/format';
import { RULE_ICON } from './MomentFeed';
import { UI, localStory, useLanguage, useTr } from '../lib/i18n';

const SCOPES: { id: RecapScope; label: string }[] = [{ id: 'first_half', label: 'First half' }, { id: 'full_time', label: 'Full time' }];

/** Halftime / full-time recap: verified moments only, clickable to replay, with an honest author label. */
export function RecapPanel({ replay, audience, onJump, request }: {
  replay: ReplaySnapshot; audience: Audience; onJump: (momentId: string, replayMs: number) => void;
  request?: { nonce: number; scope?: RecapScope };
}) {
  const tr = useTr();
  const secondHalf = replay.events.some(event => event.period === 2);
  // period_start of the second half arrives with the first half's period_end; switch only once play resumes.
  const secondHalfPlay = replay.events.some(event => event.period === 2 && !event.type.startsWith('period_'));
  const [scope, setScope] = useState<RecapScope>(secondHalfPlay ? 'full_time' : 'first_half');
  const language = useLanguage();
  const t = UI[language];
  const [result, setResult] = useState<RecapResult | null>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const seq = replay.state.latest_event_sequence;
  const lastFetch = useRef({ seq: -1, run: '', scope: '' as RecapScope | '', language: '' });
  const playing = replay.state.replay_status === 'playing';

  useEffect(() => { if (secondHalfPlay) setScope('full_time'); }, [secondHalfPlay]);
  useEffect(() => { if (request?.scope && request.scope !== scope) { setResult(undefined); setScope(request.scope); } }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on demand, never debounced: snapshots arrive faster than any debounce at high replay speeds.
  const inFlight = useRef(false);
  const wanted = useRef({ run: '', scope, language, seq });
  wanted.current = { run: replay.state.run_id, scope, language, seq };
  useEffect(() => {
    const prev = lastFetch.current;
    const stale = prev.run !== replay.state.run_id || prev.scope !== scope || prev.language !== language || Math.abs(seq - prev.seq) >= 20
      || (!playing && seq !== prev.seq) || nonce > 0 || (result === null && seq !== prev.seq);
    if (!stale || inFlight.current) return;
    if (seq === 0 || (scope === 'full_time' && !secondHalf)) {  // Nothing to recap yet: no request, no 404.
      lastFetch.current = { seq, run: replay.state.run_id, scope, language };
      setNonce(0);
      setResult(null);
      return;
    }
    inFlight.current = true;
    lastFetch.current = { seq, run: replay.state.run_id, scope, language };
    setNonce(0);
    const asked = { run: replay.state.run_id, scope, language, seq };
    // A response is used only if run, scope and language still match and the replay has not moved backwards
    // since the request: after a backward seek, a summary through later events is never shown as current.
    const current = () => wanted.current.run === asked.run && wanted.current.scope === asked.scope
      && wanted.current.language === asked.language && wanted.current.seq >= asked.seq;
    fetchRecap(scope, language).then(next => { if (current()) { setResult(next); setError(undefined); } })
      .catch(err => { if (current()) setError(publicMessage(err, 'recap')); })
      .finally(() => { inFlight.current = false; if (!current()) setNonce(n => n + 1); });
  }, [scope, seq, playing, replay.state.run_id, nonce, secondHalf, language]);

  // While the AI rewrite is running, check back every two seconds.
  useEffect(() => {
    if (result?.ai.status !== 'pending') return;
    const timer = setTimeout(() => setNonce(n => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [result]);

  const recap = result?.recap;
  // Key-moment headlines in the chosen language, from the same verified moments (AI text stays as written).
  const headlineFor = (momentId: string, fallback: string) => {
    const moment = replay.moments.find(m => m.moment_id === momentId);
    return moment ? localStory(moment, replay.replay.roster, language).headline : fallback;
  };
  const ai = result?.ai;
  const es = language === 'es';
  // The heading says what this recap is: never "Final" for a first half, never a later state after a seek back.
  const title = !recap ? null : recap.status !== 'final' ? (es ? `Partido hasta ahora · ${recap.clock}` : `Match so far · ${recap.clock}`)
    : recap.scope === 'first_half' ? (es ? 'Resumen del descanso' : 'Half-time recap') : (es ? 'Resumen final' : 'Full-time recap');
  const origin = !recap ? '' : recap.generation_mode === 'ai'
    ? (es ? 'Redactado por IA a partir de los datos de este resumen y comprobado automáticamente: cada cifra, nombre y marcador coincide.'
      : 'Written by AI from this recap\'s facts, then checked automatically: every number, name and score matches.')
    : ai?.status === 'pending' ? (es ? 'Redactado con reglas fijas; una versión de IA comprobada puede sustituirlo.' : 'Written from fixed rules; a checked AI version may replace it.')
    : (es ? 'Redactado con reglas fijas a partir de las acciones registradas.' : 'Written from fixed rules using the recorded actions.');

  return <div className="recap" aria-live="polite">
    <div className="recap-toolbar">
      <div className="segmented small" role="group" aria-label={es ? 'Periodo del resumen' : 'Recap period'}>
        {SCOPES.map(item => <button key={item.id} type="button" aria-pressed={scope === item.id}
          disabled={item.id === 'full_time' && !secondHalf} onClick={() => { if (item.id !== scope) { setResult(undefined); setScope(item.id); } }}>
          {scope === item.id && <motion.span layoutId="recap-scope" className="thumb" />}{es ? (item.id === 'first_half' ? 'Primera parte' : 'Partido completo') : item.label}
        </button>)}
      </div>
      <button type="button" className="icon-button" style={{ marginLeft: 'auto' }} aria-label={es ? 'Actualizar resumen' : 'Refresh recap'}
        onClick={() => setNonce(n => n + 1)}><RefreshCw size={15} /></button>
    </div>

    {error && <p className="alert" role="alert">{es ? 'No se pudo cargar este resumen. Inténtalo de nuevo.' : error}</p>}
    {result === null && <div className="empty"><BookOpenText size={22} /><strong>{es ? 'Aún no hay resumen' : 'No recap yet'}</strong>
      <span>{scope === 'first_half' ? (es ? 'El resumen aparece cuando empieza el partido.' : 'The first-half recap appears once the match kicks off.')
        : (es ? 'El resumen final aparece cuando empieza la segunda parte.' : 'The full-time recap appears once the second half starts.')}</span></div>}
    {result === undefined && !error && <div className="skeleton" style={{ height: 180 }} aria-busy="true" />}

    <AnimatePresence mode="wait" initial={false}>
      {recap && <motion.div key={`${recap.scope}-${recap.status}-${recap.generation_mode}`} className="recap-body"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: .22 }}>
        <p className="recap-kicker">{title}</p>
        <div className="recap-head">
          <div className="recap-score" aria-label={`${es ? 'Marcador' : 'Score'} ${recap.score.home} – ${recap.score.away}`}>
            <span style={{ color: 'var(--harbor)' }}>HAR</span><b>{recap.score.home}</b><i>–</i><b>{recap.score.away}</b><span style={{ color: 'var(--vale)' }}>VAL</span>
          </div>
          <h3 lang={recap.language ?? 'en'}>{recap.headline}</h3>
        </div>
        <p className="recap-summary" lang={recap.language ?? 'en'}>{recap.summary}</p>

        {recap.stats && <StatRows stats={recap.stats} audience={audience} es={es} />}

        <section className="recap-section" aria-label={t.keyMoments}>
          <h4>{t.keyMoments}</h4>
          {recap.key_moments.length === 0 ? <p className="hint">{es ? 'Aún no hay momentos clave en este periodo.' : 'No key moments in this period yet.'}</p>
            : <ol className="recap-moments">
              {recap.key_moments.map(km => {
                const Icon = RULE_ICON[km.rule];
                return <li key={km.moment_id}>
                  <button type="button" onClick={() => onJump(km.moment_id, km.replay_ms)} style={{ ['--tone' as string]: teamTone(km.team_id) }}
                    title={es ? 'Ir a este momento' : 'Jump to this moment'}>
                    <span className="minute">{km.clock}</span>
                    <span className="rule-tag"><Icon size={12} aria-hidden="true" />{tr(RULE_LABEL[km.rule])}</span>
                    <span className="recap-moment-text" lang={language}>{headlineFor(km.moment_id, km.headline)}</span>
                  </button>
                </li>;
              })}
            </ol>}
        </section>

        <div className="grid-2">
          <section className="card recap-card" data-supported={recap.tactical_trend.supported}>
            <h4>{audience === 'fan' ? (es ? 'Presión' : 'Pressing') : (es ? 'Tendencia táctica (PPDA)' : 'Tactical trend (PPDA)')}</h4>
            <p>{audience === 'fan' ? fanTrend(recap, es) : recap.tactical_trend.text}</p>
            {audience === 'analyst' && <>
              {recap.tactical_trend.values && <TrendValues values={recap.tactical_trend.values as Record<string, unknown>} />}
              <p className="hint">{es ? 'PPDA: pases del rival por acción defensiva más allá de 42 m de la propia portería, en ventanas de 5 minutos con al menos 10 pases y 3 acciones. Menor = menos pases permitidos; no indica dónde ni si la presión funcionó.'
                : 'PPDA: opponent passes per defensive action beyond 42 m from the defending team\'s goal, in 5-minute windows with at least 10 passes and 3 actions. Lower = fewer passes allowed; it does not show where the pressure happened or whether it worked.'}</p>
            </>}
          </section>
          <section className="card recap-card">
            <h4><UserRound size={14} aria-hidden="true" /> {es ? 'Jugador destacado' : 'Player focus'}</h4>
            <p lang={recap.language ?? 'en'}>{recap.player_focus ? recap.player_focus.text : (es ? 'Aún no hay acciones registradas.' : 'No player actions recorded yet.')}</p>
            {audience === 'analyst' && recap.player_focus && <div className="metric-chips">
              {recap.player_focus.metrics.map(m => <span key={m.name} className="metric-chip">{tr(METRIC_LABEL[m.name] ?? m.name.replace('_', ' '))}<b>{fmt(m.value)}</b>{m.unit && tr(m.unit)}</span>)}
            </div>}
          </section>
        </div>

        <details className="disclosure recap-origin">
          <summary><Info size={13} aria-hidden="true" /> {es ? 'Cómo se elaboró este resumen' : 'How this recap was written'}</summary>
          <div>
            <p>{origin}</p>
            <ul className="limitations">{recap.limitations.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
        </details>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

/** Familiar comparisons first; analysts also get the defined measures, never a sentence full of unexplained numbers. */
function StatRows({ stats, audience, es }: { stats: NonNullable<Recap['stats']>; audience: 'fan' | 'analyst'; es: boolean }) {
  const rows: { label: string; home: string; away: string; note?: string; analyst?: boolean }[] = [
    { label: es ? 'Tiros' : 'Shots', home: String(stats.home.shots), away: String(stats.away.shots) },
    { label: es ? 'A puerta' : 'On target', home: String(stats.home.shots_on_target), away: String(stats.away.shots_on_target) },
    { label: es ? 'Entradas al área' : 'Box entries', home: String(stats.home.box_entries), away: String(stats.away.box_entries), note: es ? 'pases completados al área' : 'completed passes into the box' },
    { label: es ? 'Recuperaciones' : 'Ball wins', home: String(stats.home.turnovers_won), away: String(stats.away.turnovers_won), analyst: true, note: es ? 'entradas e intercepciones ganadas' : 'tackles and interceptions won' },
    { label: es ? 'Entradas al último tercio' : 'Final-third entries', home: String(stats.home.final_third_entries), away: String(stats.away.final_third_entries), analyst: true },
    { label: es ? 'Progresión' : 'Forward progression', home: `${fmt(stats.home.progression_m, 0)} m`, away: `${fmt(stats.away.progression_m, 0)} m`, analyst: true,
      note: es ? 'metros ganados hacia la portería rival con pases completados' : 'metres gained towards goal by completed passes' },
    { label: es ? 'Acierto en el pase' : 'Pass completion', home: pct(stats.home.completion_pct), away: pct(stats.away.completion_pct), analyst: true },
    { label: es ? 'Cuota de pases' : 'Pass share', home: pct(stats.home.pass_share_pct), away: pct(stats.away.pass_share_pct), analyst: true,
      note: es ? 'proporción de pases intentados; no es tiempo de posesión' : 'share of pass attempts; not time in possession' },
  ];
  return <table className="stat-rows">
    <caption className="sr-only">{es ? 'Comparación de equipos' : 'Team comparison'}</caption>
    <thead><tr><th scope="col" style={{ color: 'var(--harbor)' }}>HAR</th><th scope="col"><span className="sr-only">{es ? 'Medida' : 'Measure'}</span></th><th scope="col" style={{ color: 'var(--vale)' }}>VAL</th></tr></thead>
    <tbody>{rows.filter(row => audience === 'analyst' || !row.analyst).map(row => <tr key={row.label}>
      <td className="num">{row.home}</td><th scope="row">{row.label}{audience === 'analyst' && row.note && <small>{row.note}</small>}</th><td className="num">{row.away}</td>
    </tr>)}</tbody>
  </table>;
}
const pct = (value: number | null) => value === null ? '–' : `${fmt(value, 0)}%`;

/** Pressing in plain words for fans: who allowed fewer passes before winning the ball back, or that it is too early to say. */
function fanTrend(recap: Recap, es: boolean) {
  const values = recap.tactical_trend.values as { mean_ppda?: Record<string, number> } | null;
  const mean = values?.mean_ppda;
  if (!recap.tactical_trend.supported || !mean) return es ? 'Aún es pronto para decir qué equipo presionó más.' : 'Too early to say which side pressed more.';
  const [low, high] = Object.entries(mean).sort((a, b) => a[1] - b[1]);
  if (!high || high[1] < low[1] * 1.25) return es ? 'Los dos equipos presionaron con una intensidad parecida.' : 'Both sides pressed with similar intensity.';
  const name = TEAM_META[low[0]]?.name ?? low[0];
  return es ? `${name} presionó con más intensidad: dejó dar menos pases al rival antes de intentar recuperar el balón.`
    : `${name} pressed with more intensity, letting the opponent make fewer passes before trying to win the ball back.`;
}

/** The tactical trend's inputs as labelled rows (team values side by side), never raw JSON. */
function TrendValues({ values }: { values: Record<string, unknown> }) {
  const label = (key: string) => key.replace(/_/g, ' ').replace(/\bppda\b/i, 'PPDA').replace(/^./, c => c.toUpperCase());
  const show = (value: unknown): string => typeof value === 'number' ? fmt(value, 1)
    : value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([k, v]) => `${TEAM_META[k]?.name ?? label(k)} ${show(v)}`).join(' · ')
    : String(value);
  return <dl className="facts trend-values">
    {Object.entries(values).map(([key, value]) => <div key={key} style={{ display: 'contents' }}><dt>{label(key)}</dt><dd>{show(value)}</dd></div>)}
  </dl>;
}
