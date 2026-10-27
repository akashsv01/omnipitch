import { useMemo, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { ReplaySnapshot } from '../types/contracts';
import { useLanguage, type Language } from '../lib/i18n';

const TEXT: Record<Language, {
  title: string; moments: string; figures: string; cited: string; ai: string; rejected: string; templates: string; how: string;
  steps: string[];
}> = {
  en: {
    title: 'Checked before it is shown', moments: 'moments, each from recorded events', figures: 'figures computed in code, not by AI',
    cited: 'source events cited', ai: 'AI-written, passed the validator', rejected: 'AI texts rejected, template kept',
    templates: 'rule-based, no AI text yet', how: 'How we check',
    steps: [
      'Every number is computed in code from the recorded events; the AI never calculates.',
      'A moment exists only when a rule\'s threshold is met, and its evidence is frozen when it is detected.',
      'AI text is checked in code before it is shown: every number, player, team, event ID and claim (score, box, direction) must match the moment\'s evidence.',
      'Text that fails any check is rejected and the rule-based template stays on screen, labelled as such.',
      'Recaps are marked Reconciled only after the period is checked against the pipeline\'s own records.',
    ],
  },
  es: {
    title: 'Comprobado antes de mostrarse', moments: 'momentos, cada uno de eventos registrados', figures: 'cifras calculadas en código, no por la IA',
    cited: 'eventos de origen citados', ai: 'escritos por IA, validados', rejected: 'textos de IA rechazados, se mantiene la plantilla',
    templates: 'basados en reglas, aún sin texto de IA', how: 'Cómo comprobamos',
    steps: [
      'Cada número se calcula en código a partir de los eventos registrados; la IA nunca calcula.',
      'Un momento solo existe cuando se cumple el umbral de una regla, y su evidencia se congela al detectarse.',
      'El texto de la IA se comprueba en código antes de mostrarse: cada número, jugador, equipo, ID de evento y afirmación (marcador, área, dirección) debe coincidir con la evidencia.',
      'Si falla alguna comprobación, se rechaza y se mantiene la plantilla basada en reglas, indicada como tal.',
      'Los resúmenes se marcan como conciliados solo después de comprobar el periodo con los registros del propio pipeline.',
    ],
  },
};

/** The checks behind the room, counted from the snapshot itself: moments, the figures they carry, the events they
 * cite, and what happened to AI text. Nothing here is estimated. */
export function TrustBar({ replay }: { replay: ReplaySnapshot }) {
  const t = TEXT[useLanguage()];
  const [open, setOpen] = useState(false);
  const counts = useMemo(() => {
    const cited = new Set<string>();
    let figures = 0;
    for (const moment of replay.moments) {
      figures += moment.metrics.length;
      moment.evidence_ids.forEach(id => cited.add(id));
    }
    const ai = replay.moments.filter(moment => moment.insight.generation_mode === 'ai').length;
    return { moments: replay.moments.length, figures, cited: cited.size, ai };
  }, [replay.moments]);
  const insightsOn = replay.insights.mode !== 'off' && replay.insights.status !== 'off';
  const stats: [number, string, string?][] = [
    [counts.moments, t.moments], [counts.figures, t.figures], [counts.cited, t.cited],
    ...(insightsOn
      ? [[counts.ai, t.ai, 'ai'], [replay.insights.rejected, t.rejected]] as [number, string, string?][]
      : [[counts.moments, t.templates]] as [number, string, string?][]),
  ];
  return <section className="trust-bar" aria-labelledby="trust-title">
    <div className="trust-head">
      <h2 id="trust-title"><ShieldCheck size={15} aria-hidden="true" />{t.title}</h2>
      <button type="button" className="text-button" aria-expanded={open} aria-controls="trust-how" onClick={() => setOpen(value => !value)}>
        {t.how}<ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
    </div>
    <dl className="trust-stats">
      {stats.map(([value, label, mode]) => <div key={label} data-mode={mode}><dt>{label}</dt><dd className="num">{value.toLocaleString()}</dd></div>)}
    </dl>
    {open && <ol className="trust-how" id="trust-how">{t.steps.map(step => <li key={step}>{step}</li>)}</ol>}
  </section>;
}
