import { memo, useMemo } from 'react';
import { t } from '../lib/i18n';
import { useTr } from '../lib/i18n';
import { Activity, Crosshair, Radar, Shield, UserRound } from 'lucide-react';
import type { Analysis, Event, Moment, Player, PpdaWindow, Rule } from '../types/contracts';
import type { Audience, FocusMetric } from '../lib/prefs';
import { TEAM_META, clockLabel, fmt, metricText, momentInvolves, playerIndex, teamTone } from '../lib/format';

/** The viewer's focus, kept visible beside the moments: a player's recorded involvement, a club's context, or
 * one followed metric with its definition and valid trend. Everything comes from the same analysis snapshot as
 * the rest of the room; focus changes emphasis, never the facts or the chronological history. */
export const FocusPanel = memo(function FocusPanel({ analysis, events, moments, roster, audience, team, player, metric, onFilter, onJump }: {
  analysis: Analysis; events: Event[]; moments: Moment[]; roster: Player[]; audience: Audience;
  team: string | null; player: string | null; metric: FocusMetric | null;
  onFilter: (rules: Rule[] | 'focus') => void; onJump: (moment: Moment) => void;
}) {
  if (!team && !player && !metric) return null;
  return <section className="focus" aria-label="Your focus">
    {player && <PlayerFocus analysis={analysis} events={events} moments={moments} roster={roster} audience={audience} player={player} onFilter={onFilter} onJump={onJump} />}
    {!player && team && <TeamFocus analysis={analysis} moments={moments} team={team} onFilter={onFilter} onJump={onJump} />}
    {metric && <MetricFocus analysis={analysis} moments={moments} audience={audience} metric={metric} onFilter={onFilter} />}
  </section>;
});

function PlayerFocus({ analysis, events, moments, roster, audience, player, onFilter, onJump }: {
  analysis: Analysis; events: Event[]; moments: Moment[]; roster: Player[]; audience: Audience; player: string;
  onFilter: (rules: Rule[] | 'focus') => void; onJump: (moment: Moment) => void;
}) {
  const tr = useTr();
  const person = useMemo(() => playerIndex(roster).get(player), [roster, player]);
  const row = analysis.players.find(item => item.player_id === player);
  const own = useMemo(() => events.filter(event => event.player_id === player), [events, player]);
  const last = own[own.length - 1];
  const latest = events.length ? events[events.length - 1] : undefined;
  const linked = moments.filter(moment => momentInvolves(moment, null, player));
  // Minutes since the last recorded on-ball action, in the same period only (a half-time break is not inactivity).
  const quiet = last && latest && latest.period === last.period ? Math.floor((latest.match_time_ms - last.match_time_ms) / 60000) : null;
  const tone = teamTone(person?.team_id ?? row?.team_id ?? '');
  return <div className="focus-card" style={{ ['--tone' as string]: tone }}>
    <h3><UserRound size={14} aria-hidden="true" />{person ? <><span className="shirt" style={{ background: tone }}>{person.shirt}</span>{person.name}</> : player}
      <small>{person ? `${person.position} · ${TEAM_META[person.team_id]?.name ?? person.team_id}` : ''}</small></h3>
    {!row
      ? <p className="hint">{t('No recorded on-ball action yet. Only on-ball events are recorded, so off-ball work is not shown.')}</p>
      : <>
        <dl className="focus-stats">
          <div><dt>{tr('Actions')}</dt><dd>{row.action_count}</dd></div>
          <div><dt>{tr('Passes')}</dt><dd>{row.passes_completed}<small>/{row.passes}</small></dd></div>
          {audience === 'analyst' && <div><dt>{tr('Forward progression')}</dt><dd>{fmt(row.progression_m, 0)}<small> m</small></dd></div>}
          <div><dt>{tr('Shots')}</dt><dd>{row.shots}{row.goals ? <small> · {row.goals} goal{row.goals === 1 ? '' : 's'}</small> : null}</dd></div>
          <div><dt>{tr('Ball wins and duels')}</dt><dd>{row.defensive_actions}</dd></div>
        </dl>
        <p className="hint">
          {t('Last recorded action')} {last ? clockLabel(last.period, last.match_time_ms) : '–'}
          {quiet !== null && quiet >= 5 ? `; ${t('nothing recorded for')} ${quiet} ${t('minutes.')} ${t('Events record on-ball actions only, so this says nothing about off-ball work.')}` : '.'}
        </p>
      </>}
    <FocusMoments moments={linked} label={t('moments involve this player')} onFilter={() => onFilter('focus')} onJump={onJump} />
  </div>;
}

function TeamFocus({ analysis, moments, team, onFilter, onJump }: {
  analysis: Analysis; moments: Moment[]; team: string; onFilter: (rules: Rule[] | 'focus') => void; onJump: (moment: Moment) => void;
}) {
  const tr = useTr();
  const stats = analysis.teams[team];
  const other = Object.keys(analysis.teams).find(id => id !== team);
  const rival = other ? analysis.teams[other] : undefined;
  const linked = moments.filter(moment => moment.team_id === team);
  // Major developments for either side stay in view: the latest goal or chance against this club.
  const against = moments.filter(moment => moment.team_id !== team && (moment.rule === 'goal' || moment.rule === 'chance'))
    .reduce<Moment | undefined>((a, b) => !a || b.source_sequence > a.source_sequence ? b : a, undefined);
  return <div className="focus-card" style={{ ['--tone' as string]: teamTone(team) }}>
    <h3><Shield size={14} aria-hidden="true" />{TEAM_META[team]?.name ?? team}<small>{tr('your club')}</small></h3>
    {stats && rival && <dl className="focus-stats">
      <div><dt>{tr('Goals')}</dt><dd>{stats.goals}<small> – {rival.goals}</small></dd></div>
      <div><dt>{tr('Shots')}</dt><dd>{stats.shots}<small> {t('vs')} {rival.shots}</small></dd></div>
      <div><dt>{tr('Box entries')}</dt><dd>{stats.box_entries}<small> {t('vs')} {rival.box_entries}</small></dd></div>
      <div><dt>{tr('Ball wins')}</dt><dd>{stats.turnovers_won}<small> {t('vs')} {rival.turnovers_won}</small></dd></div>
    </dl>}
    {against && <p className="hint">{tr('Latest against: ')}<button type="button" className="text-button inline" onClick={() => onJump(against)}>
      {clockLabel(against.period, against.match_time_ms)} {against.insight.headline}</button></p>}
    <FocusMoments moments={linked} label={t('moments for your club')} onFilter={() => onFilter('focus')} onJump={onJump} />
  </div>;
}

const METRICS: Record<FocusMetric, { label: string; icon: typeof Radar; rules: Rule[]; definition: string }> = {
  pressing: { label: 'Pressing (PPDA)', icon: Radar, rules: ['pressing_change'],
    definition: 'Opponent passes per defensive action beyond 42 m, in 5-minute windows. Lower means fewer passes allowed per action. Windows need at least 10 passes and 3 actions.' },
  passing: { label: 'Passing', icon: Activity, rules: ['threat_gain'],
    definition: 'Completed ÷ attempted passes, and each team\'s share of all pass attempts (not time in possession).' },
  shots: { label: 'Shots', icon: Crosshair, rules: ['goal', 'chance'],
    definition: 'Recorded attempts and outcomes. On target includes goals and saves. No shot-quality (xG) model is applied.' },
};

function MetricFocus({ analysis, moments, audience, metric, onFilter }: {
  analysis: Analysis; moments: Moment[]; audience: Audience; metric: FocusMetric; onFilter: (rules: Rule[] | 'focus') => void;
}) {
  const tr = useTr();
  const spec = METRICS[metric];
  const Icon = spec.icon;
  const teams = Object.keys(analysis.teams);
  const sources = moments.filter(moment => spec.rules.includes(moment.rule));
  return <div className="focus-card metric">
    <h3><Icon size={14} aria-hidden="true" />{tr(spec.label)}<small>{tr('followed metric')}</small></h3>
    <dl className="focus-stats">
      {teams.map(team => <div key={team} style={{ ['--tone' as string]: teamTone(team) }}>
        <dt>{TEAM_META[team]?.short ?? team}</dt>
        <dd>{metric === 'pressing' ? <PpdaValue window={analysis.ppda_current[team]} trend={ppdaTrend(analysis.ppda_series, team)} />
          : metric === 'passing' ? <>{analysis.teams[team].completion_pct === null ? t('no passes yet') : `${fmt(analysis.teams[team].completion_pct, 1)}%`}<small> {t('completed')} · {fmt(analysis.teams[team].pass_share_pct, 0)}% share</small></>
          : <>{analysis.teams[team].shots}<small> · {analysis.teams[team].shots_on_target} {t('on target')} · {analysis.teams[team].goals} {t('goals')}</small></>}</dd>
      </div>)}
    </dl>
    {audience === 'analyst' || metric === 'pressing' ? <p className="hint">{t(spec.definition)}</p> : null}
    <p className="hint"><button type="button" className="text-button inline" onClick={() => onFilter(spec.rules)} disabled={!sources.length}>
      {sources.length ? `${t('Show')} ${sources.length} ${t(sources.length === 1 ? 'source moment' : 'source moments')}` : tr('No source moments yet')}</button></p>
  </div>;
}

/** Direction between the last two valid (sample-gated) windows of the same half; null when there are fewer. */
function ppdaTrend(series: PpdaWindow[], team: string): 'down' | 'up' | 'flat' | null {
  const valid = series.filter(w => w.team_id === team && w.closed && w.status === 'ok' && w.value !== null);
  const [a, b] = valid.slice(-2);
  if (!a || !b || a.period !== b.period) return null;
  return b.value! < a.value! ? 'down' : b.value! > a.value! ? 'up' : 'flat';
}

function PpdaValue({ window, trend }: { window: PpdaWindow | undefined; trend: ReturnType<typeof ppdaTrend> }) {
  if (!window) return <>{t('no events yet')}</>;
  if (window.status !== 'ok') return <>{t(window.status === 'no_defensive_actions' ? 'no defensive actions' : 'sample too small')}<small> {t('(current window)')}</small></>;
  return <>{metricText('ppda', window.value!)}<small> · {t(trend === null ? 'not enough windows for a trend'
    : trend === 'flat' ? 'unchanged' : trend === 'down' ? 'fewer passes allowed than the previous window' : 'more passes allowed than the previous window')}</small></>;
}

function FocusMoments({ moments, label, onFilter, onJump }: { moments: Moment[]; label: string; onFilter: () => void; onJump: (moment: Moment) => void }) {
  const tr = useTr();
  if (!moments.length) return <p className="hint">{tr('No detected moments yet for this focus.')}</p>;
  const latest = moments.reduce((a, b) => b.source_sequence > a.source_sequence ? b : a);
  return <p className="hint">
    <button type="button" className="text-button inline" onClick={onFilter}>{moments.length} {label}</button>
    {` · ${t('latest')} `}<button type="button" className="text-button inline" onClick={() => onJump(latest)}>{clockLabel(latest.period, latest.match_time_ms)}</button>
  </p>;
}
