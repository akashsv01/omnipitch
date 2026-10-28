import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Crosshair, Eye, FileSearch, Goal, Radar, Repeat2, RotateCcw, ShieldCheck, Sparkles, Star } from 'lucide-react';
import type { Analysis, Event, MatchState, Moment, Player, Rule } from '../types/contracts';
import type { Audience, FocusMetric } from '../lib/prefs';
import { CatchUpCard, type CatchUpData } from './CatchUp';
import { FocusPanel } from './FocusPanel';
import { FocusPicker } from './FocusPicker';
import type { Prefs } from '../lib/prefs';
import { RULE_LABEL, TEAM_META, clockLabel, momentInvolves, teamTone } from '../lib/format';
import { GENERATION_LABEL, GENERATION_SHORT, generation, keyValues, metricRows, whyItMatters } from '../lib/evidence';

// The insight source mode, for honest per-card generation labels without threading a prop through every row.
const AiMode = createContext('off');
import { Crest } from './Crest';
import { UI, localStory, num, useLanguage, useTr, whyEs } from '../lib/i18n';

// The roster, for player names in the Spanish stories, without threading it through every row.
const RosterCtx = createContext<Player[]>([]);

export const RULE_ICON: Record<Rule, typeof Goal> = {
  goal: Goal, chance: Crosshair, threat_gain: ArrowUpRight, transition: Repeat2, pressing_change: Radar,
};
const FILTERS: { id: 'all' | Rule; label: string; fan?: boolean }[] = [
  { id: 'all', label: 'All', fan: true }, { id: 'goal', label: 'Goals', fan: true }, { id: 'chance', label: 'Chances', fan: true },
  { id: 'transition', label: 'Transitions' }, { id: 'pressing_change', label: 'Pressing' }, { id: 'threat_gain', label: 'Threat' },
];

/** Moment spotlight above a compact history. The reader decides what is in the spotlight: a newly detected
 * moment never replaces one they picked; it waits behind an indicator. Fans get a story-led spotlight;
 * analysts get an inspector with aligned values, the trigger and the source events. Same moments either way. */
const countLabel = (count: number, language: string) => language === 'es'
  ? `${count} ${count === 1 ? 'momento' : 'momentos'}` : `${count} ${count === 1 ? 'moment' : 'moments'}`;

const WEIGHT: Record<Rule, number> = { goal: 5, chance: 4, transition: 3, threat_gain: 2, pressing_change: 1 };
/** Groups detections from one attacking move (same team and half, within a few seconds and actions) into one
 * episode, led by its most important moment, so the list reads as moves rather than repeated alerts. Pressing
 * windows are never grouped: they describe a spell, not a move. */
export function episodes(list: Moment[]): { lead: Moment; related: Moment[] }[] {
  const out: { lead: Moment; related: Moment[]; members: Moment[] }[] = [];
  for (const moment of list) {
    const group = moment.rule === 'pressing_change' ? undefined : out.find(g => g.members.some(m => m.rule !== 'pressing_change'
      && m.team_id === moment.team_id && m.period === moment.period && Math.abs(m.source_sequence - moment.source_sequence) <= 12
      && Math.abs(m.match_time_ms - moment.match_time_ms) <= 20000));
    if (group) group.members.push(moment); else out.push({ lead: moment, related: [], members: [moment] });
  }
  return out.map(g => {
    const lead = [...g.members].sort((a, b) => WEIGHT[b.rule] - WEIGHT[a.rule] || b.source_sequence - a.source_sequence)[0];
    return { lead, related: g.members.filter(m => m !== lead) };
  });
}

/** "No goals yet. 12 other moments are under All." in the viewer's language; null kind = the viewer's focus. */
function emptyFilterNote(language: string, kind: string | null, others: number) {
  if (language === 'es') {
    const what = kind === null ? 'momentos de tu foco' : kind ? kind.toLowerCase() : 'momentos de origen';
    return `Aún no hay ${what}. ${others} ${others === 1 ? 'momento más está' : 'momentos más están'} en Todos.`;
  }
  const what = kind === null ? 'moments for your focus' : kind ? kind.toLowerCase() : 'source moments';
  return `No ${what} yet. ${others} other ${others === 1 ? 'moment is' : 'moments are'} under All.`;
}

export const MomentFeed = memo(function MomentFeed({ moments, audience, favoriteTeam, favoritePlayer, focusMetric, analysis, events, roster, chosenId, onChoose, onEvidence, onJump, aiMode, onRecap, nowClock, catchUp, state, onDismissCatchUp, onFocus }: {
  moments: Moment[]; audience: Audience; favoriteTeam: string | null; favoritePlayer: string | null; roster: Player[]; aiMode: string;
  focusMetric: FocusMetric | null; analysis: Analysis; events: Event[];
  chosenId: string | undefined; onChoose: (moment: Moment | undefined) => void;
  onEvidence: (moment: Moment) => void; onJump: (moment: Moment) => void; onRecap: () => void;
  /** The replay's current minute (the action the pitch follows), to set the spotlight in time. */
  nowClock: string | null;
  catchUp: CatchUpData | null; state: MatchState; onDismissCatchUp: () => void;
  /** Changes who or what the viewer follows (the same preferences as the settings panel). */
  onFocus: (patch: Partial<Prefs>) => void;
}) {
  const tr = useTr();
  const fan = audience === 'fan';
  const language = useLanguage();
  // 'focus' = moments involving the favourite player or club; a rule list comes from a followed metric's sources.
  const [filter, setFilter] = useState<'all' | 'focus' | Rule | Rule[]>('all');
  const hasFocus = !!(favoriteTeam || favoritePlayer);
  const runId = moments[0]?.run_id;

  // Moments the reader has been shown. While they are reading (scrolled, hovering or focused in the list),
  // new ones wait behind a button so nothing moves under them.
  const [accepted, setAccepted] = useState<Set<string>>(() => new Set(moments.map(m => m.moment_id)));
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const reading = useRef({ scrolled: false, pointer: false, focus: false });
  const body = useRef<HTMLDivElement>(null);
  const lastRun = useRef(runId);
  const isReading = () => reading.current.scrolled || reading.current.pointer || reading.current.focus;
  const present = useMemo(() => new Set(moments.map(m => m.moment_id)), [moments]);
  const pending = moments.filter(m => !accepted.has(m.moment_id));
  const acceptAll = (scroll: boolean) => {
    setFresh(new Set(pending.map(m => m.moment_id)));
    setAccepted(new Set(present));
    if (scroll) body.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (lastRun.current !== runId) {   // A new run: show everything at once, no entry animation.
      lastRun.current = runId;
      setAccepted(new Set(present));
      setFresh(new Set());
      return;
    }
    if (pending.length && !isReading()) acceptAll(false);
    // A backwards seek removes moments (and may remove the one being inspected); drop them from the accepted set too.
    if ([...accepted].some(id => !present.has(id))) setAccepted(previous => new Set([...previous].filter(id => present.has(id))));
  }, [moments]); // eslint-disable-line react-hooks/exhaustive-deps
  // Returning to the current match (the inspected moment is let go) is an explicit "catch me up": everything that
  // arrived meanwhile joins the list at once, so the list, counts and spotlight agree with the rest of the room.
  const wasChosen = useRef(chosenId);
  useEffect(() => {
    if (wasChosen.current && !chosenId) {
      reading.current = { scrolled: false, pointer: false, focus: false };
      if (pending.length) acceptAll(true);
    }
    wasChosen.current = chosenId;
  }, [chosenId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A fan-hidden filter must not strand a fan with an empty list.
  useEffect(() => { if (fan && typeof filter === 'string' && filter !== 'focus' && !FILTERS.find(f => f.id === filter)?.fan) setFilter('all'); }, [fan, filter]);
  useEffect(() => { if (filter === 'focus' && !hasFocus) setFilter('all'); }, [filter, hasFocus]);

  const shown = useMemo(() => moments.filter(m => accepted.has(m.moment_id)), [moments, accepted]);
  const matches = (moment: Moment) => filter === 'all' ? true : filter === 'focus' ? !!(favoritePlayer ? momentInvolves(moment, null, favoritePlayer) : momentInvolves(moment, favoriteTeam, null))
    : Array.isArray(filter) ? filter.includes(moment.rule) : moment.rule === filter;
  // Always match order, newest first, by the match time the moment describes (a pressing window is stamped
  // with its start, though it is detected when the window closes). Focus is a filter and a star, never a reordering.
  const newestFirst = (a: Moment, b: Moment) => b.period - a.period || b.match_time_ms - a.match_time_ms
    || b.source_sequence - a.source_sequence || b.priority - a.priority;
  const ordered = useMemo(() => shown.filter(matches).sort(newestFirst), [shown, filter, favoriteTeam, favoritePlayer]); // eslint-disable-line react-hooks/exhaustive-deps
  // Counts describe every revealed moment, whether or not its row has been inserted yet.
  const matching = useMemo(() => moments.filter(matches).length, [moments, filter, favoriteTeam, favoritePlayer]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => moments.reduce<Record<string, number>>((all, m) => ({ ...all, [m.rule]: (all[m.rule] ?? 0) + 1 }), {}), [moments]);
  const favoriteName = roster.find(player => player.player_id === favoritePlayer)?.name;
  const chosen = chosenId ? moments.find(m => m.moment_id === chosenId) : undefined;
  // Following the match, the spotlight is always the newest moment, even while its row waits to be inserted.
  const featured = chosen ?? [...moments].filter(matches).sort(newestFirst)[0];
  // Newer than the moment the reader picked: offered, never forced.
  const newer = chosen ? shown.filter(m => m.source_sequence > chosen.source_sequence).length : 0;
  const rest = ordered.filter(m => m !== featured).slice(0, fan ? 40 : 60);
  const grouped = useMemo(() => episodes(rest), [rest]);
  const Spot = fan ? FanSpotlight : AnalystInspector;
  const Row = fan ? FanRow : AnalystRow;

  return <AiMode.Provider value={aiMode}><RosterCtx.Provider value={roster}><aside className="desk-spot" data-audience={audience} aria-labelledby="moments-title">
    {/* Remounted per audience so only this supporting panel animates on a mode change; its state lives above. */}
    <div key={audience} className="mode-swap">
    <div className="spot-head">
      <h2 id="moments-title">{UI[language].keyMoments}</h2>
      {/* Counts only revealed moments of this run; not live-announced, so updates never interrupt a screen reader. */}
      <span className="count-badge">{filter === 'all' || !moments.length ? countLabel(moments.length, language)
        : `${matching} ${language === 'es' ? 'de' : 'of'} ${countLabel(moments.length, language)}`}</span>
      {moments.length > 0 && <button type="button" className="button ghost small" onClick={onRecap}>{UI[language].recap}</button>}
    </div>
    {catchUp && <CatchUpCard data={catchUp} state={state} roster={roster} onChoose={onChoose} onDismiss={onDismissCatchUp} />}
    {featured
      ? <Spot key={featured.moment_id} moment={featured} fresh={fresh.has(featured.moment_id)} pinned={!!chosen} nowClock={nowClock}
          favorite={!!momentInvolves(featured, favoriteTeam, favoritePlayer)} onEvidence={onEvidence} onJump={onJump}
          onInspect={() => onChoose(chosen ? undefined : featured)} />
      : <div className="spotlight" style={{ ['--tone' as string]: 'var(--line-2)' }}>
          <div className="empty"><Sparkles size={22} aria-hidden="true" /><strong>{tr('No moments yet')}</strong>
            <span>{tr('Press play. Moments appear when the events support them; a quiet spell stays quiet.')}</span></div>
        </div>}
    {newer > 0 && <div className="newer" style={{ background: 'none', paddingTop: 10 }}>
      <button type="button" onClick={() => onChoose(undefined)}>Show latest ({newer} newer moment{newer === 1 ? '' : 's'})</button>
    </div>}
    <FocusPicker prefs={{ favoriteTeam, favoritePlayer, focusMetric }} update={onFocus} roster={roster} />
    <FocusPanel analysis={analysis} events={events} moments={moments} roster={roster} audience={audience}
      team={favoriteTeam} player={favoritePlayer} metric={focusMetric} onJump={onJump}
      onFilter={next => { setFilter(next); body.current?.scrollTo({ top: 0 }); }} />
    <div className="history">
      <div className="history-head"><h3>{fan ? tr('Earlier in the match') : tr('Timeline')}</h3>{!fan && <span className="hint">{tr('min · rule · team · key value · author')}</span>}</div>
      <div className="filter-row" role="group" aria-label={tr('Filter moments')}>
        {FILTERS.filter(item => !fan || item.fan).map(item => <button key={item.id} type="button" className="chip" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
          {tr(item.label)}{item.id !== 'all' && counts[item.id] ? <span className="count num">{counts[item.id]}</span> : null}
        </button>)}
        {hasFocus && <button type="button" className="chip" aria-pressed={filter === 'focus'} onClick={() => setFilter('focus')}>
          <Star size={12} aria-hidden="true" />{favoriteName ? favoriteName.split(' ').slice(-1)[0] : TEAM_META[favoriteTeam ?? '']?.short ?? 'Focus'}
        </button>}
        {Array.isArray(filter) && <button type="button" className="chip" aria-pressed="true" onClick={() => setFilter('all')}>
          {filter.map(rule => tr(RULE_LABEL[rule])).join(' + ')} ×</button>}
      </div>
      <div className="history-body" ref={body}
        onScroll={event => { reading.current.scrolled = event.currentTarget.scrollTop > 6; if (!reading.current.scrolled && !reading.current.pointer && !reading.current.focus && pending.length) acceptAll(false); }}
        onPointerEnter={() => { reading.current.pointer = true; }}
        onPointerLeave={() => { reading.current.pointer = false; if (pending.length && !isReading()) acceptAll(false); }}
        onFocus={() => { reading.current.focus = true; }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) reading.current.focus = false; }}>
        {pending.length > 0 && <div className="newer">
          <button type="button" onClick={() => acceptAll(true)}>{language === 'es'
            ? `${pending.length} ${pending.length === 1 ? 'momento nuevo' : 'momentos nuevos'}: mostrar`
            : `${pending.length} new ${pending.length === 1 ? 'moment' : 'moments'}: show`}</button>
        </div>}
        {rest.length === 0
          ? <p className="quiet-note">{filter !== 'all' && moments.length > 0
              ? emptyFilterNote(language, typeof filter === 'string' ? filter === 'focus' ? null : tr(FILTERS.find(f => f.id === filter)?.label ?? '') : '', moments.length)
              : tr(moments.length > 1 ? 'Earlier moments collect here.' : 'Earlier moments will collect here as the replay runs.')}</p>
          : <ol className={fan ? 'moment-list' : 'moment-list dense'} aria-label={tr('Earlier moments')}>
            {grouped.map(({ lead: moment, related }) => <li key={moment.moment_id} className={fresh.has(moment.moment_id) ? 'moment-enter' : undefined}>
              <Row moment={moment} related={related} favorite={[moment, ...related].some(m => momentInvolves(m, favoriteTeam, favoritePlayer))}
                chosen={moment.moment_id === chosenId || related.some(m => m.moment_id === chosenId)}
                onChoose={() => onChoose(moment.moment_id === chosenId ? undefined : moment)} />
            </li>)}
          </ol>}
      </div>
    </div>
    </div>
  </aside></RosterCtx.Provider></AiMode.Provider>;
});

const RULE_ES: Record<Rule, string> = { goal: 'Gol', chance: 'Ocasión', threat_gain: 'Amenaza', transition: 'Transición', pressing_change: 'Presión' };
const ruleName = (rule: Rule, language: string) => language === 'es' ? RULE_ES[rule] : RULE_LABEL[rule];

export function AuthorTag({ moment }: { moment: Moment }) {
  const tr = useTr();
  const gen = generation(moment, useContext(AiMode));
  return <span className="author-tag" data-mode={gen} title={tr(GENERATION_LABEL[gen])}>
    {gen === 'ai' && <Sparkles size={11} aria-hidden="true" />}{tr(GENERATION_SHORT[gen])}
  </span>;
}

interface SpotProps {
  moment: Moment; favorite: boolean; fresh: boolean; pinned: boolean; nowClock: string | null;
  onEvidence: (m: Moment) => void; onJump: (m: Moment) => void; onInspect: () => void;
}

/** Says which moment this is relative to the replay: the latest detected one, or one the reader picked. */
function SpotContext({ moment, pinned, nowClock }: { moment: Moment; pinned: boolean; nowClock: string | null }) {
  const tr = useTr();
  const at = clockLabel(moment.period, moment.match_time_ms);
  return <span className="spot-context" data-pinned={pinned || undefined}>
    {pinned ? tr('Selected moment') : tr('Latest moment')}{nowClock && nowClock !== at ? <> · {tr('replay is at')} <b>{nowClock}</b></> : null}
  </span>;
}

function SpotMeta({ moment, favorite, context }: { moment: Moment; favorite: boolean; context?: React.ReactNode }) {
  const tr = useTr();
  const Icon = RULE_ICON[moment.rule];
  const team = moment.team_id ? TEAM_META[moment.team_id] : undefined;
  return <div className="spot-meta">
    <span className="spot-minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    {team && moment.team_id && <span className="spot-team" style={{ color: team.tone }}><Crest team={moment.team_id} />{team.name}</span>}
    <span className="spot-kind"><Icon size={14} aria-hidden="true" />{tr(RULE_LABEL[moment.rule])}</span>
    {favorite && <Star size={13} fill="var(--amber)" color="var(--amber)" aria-label="Involves your favourite" />}
    {context}
  </div>;
}

function StatusLine({ moment }: { moment: Moment }) {
  const tr = useTr();
  const gen = generation(moment, useContext(AiMode));
  return <p className="status-line" data-mode={gen}>
    {gen === 'ai' ? <ShieldCheck size={13} aria-hidden="true" /> : null}{tr(GENERATION_LABEL[gen])}
  </p>;
}

/** Fan: one takeaway. What happened, why it matters and one main action; the numbers live in the evidence. */
function FanSpotlight({ moment, favorite, fresh, pinned, nowClock, onEvidence, onJump, onInspect }: SpotProps) {
  const tr = useTr();
  const language = useLanguage(), t = UI[language], lang = language;
  const story = localStory(moment, useContext(RosterCtx), language);
  return <article className={`spotlight fan${fresh ? ' moment-enter' : ''}`} data-rule={moment.rule} style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    aria-labelledby={`spot-${moment.moment_id}`}>
    <SpotMeta moment={moment} favorite={favorite} context={<SpotContext moment={moment} pinned={pinned} nowClock={nowClock} />} />
    <h3 id={`spot-${moment.moment_id}`} lang={lang}>{story.headline}</h3>
    <div className="qa" lang={lang}>
      <p><span>{t.whatHappened}</span><span className="said" lang={story.englishOnly ? 'en' : lang}>{story.casual}</span>{story.englishOnly && <small className="en-only">{t.aiEnglish}</small>}</p>
      <p><span>{t.whyMatters}</span>{language === 'es' ? whyEs(moment, 'fan') : whyItMatters(moment, 'fan')}</p>
    </div>
    <div className="spot-actions">
      <button type="button" className="button primary" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />{t.whyBtn}</button>
      <button type="button" className="button ghost" onClick={() => onJump(moment)}><RotateCcw size={14} aria-hidden="true" />{t.jump}</button>
      <button type="button" className="text-button quiet" aria-pressed={pinned} onClick={onInspect}><Eye size={14} aria-hidden="true" />{pinned ? tr('Return to replay') : tr('Show on pitch')}</button>
    </div>
    <StatusLine moment={moment} />
  </article>;
}

/** Analyst: an inspector. Aligned metric rows with units, the calculation and trigger, the source events. */
function AnalystInspector({ moment, favorite, fresh, pinned, nowClock, onEvidence, onJump, onInspect }: SpotProps) {
  const tr = useTr();
  const language = useLanguage();
  const story = localStory(moment, useContext(RosterCtx), language);
  const rows = metricRows(moment);
  return <article className={`spotlight analyst${fresh ? ' moment-enter' : ''}`} data-rule={moment.rule} style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    aria-labelledby={`spot-${moment.moment_id}`}>
    <SpotMeta moment={moment} favorite={favorite} context={<SpotContext moment={moment} pinned={pinned} nowClock={nowClock} />} />
    <h3 id={`spot-${moment.moment_id}`} lang={language}>{story.headline}</h3>
    <p className="story" lang={story.englishOnly ? 'en' : language}>{story.analyst}{story.englishOnly && <small className="en-only"> {UI[language].aiEnglish}</small>}</p>
    <table className="inspect-table" aria-label="Metrics">
      <tbody>
        {rows.map(row => <tr key={row.name}><th scope="row">{tr(row.label)}</th><td className="num">{num(row.shown)}</td><td className="unit">{row.unit && tr(row.unit)}</td></tr>)}
        <tr><th scope="row">{tr('Why flagged')}</th><td colSpan={2} lang={language}>{language === 'es' ? whyEs(moment, 'analyst') : whyItMatters(moment, 'analyst')}</td></tr>
        <tr><th scope="row">{tr('Source')}</th><td colSpan={2}>{moment.evidence_ids.length} {tr(moment.evidence_ids.length === 1 ? 'recorded event' : 'recorded events')} · {tr('details in the evidence')}</td></tr>
      </tbody>
    </table>
    <div className="spot-actions">
      <button type="button" className="button primary" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />{tr('Inspect evidence')}</button>
      <button type="button" className="button ghost" onClick={() => onJump(moment)}><RotateCcw size={14} aria-hidden="true" />{tr('Replay from')} {clockLabel(moment.period, moment.match_time_ms)}</button>
      <button type="button" className="text-button quiet" aria-pressed={pinned} onClick={onInspect}><Eye size={14} aria-hidden="true" />{pinned ? tr('Return to replay') : tr('Show sequence on pitch')}</button>
    </div>
    <StatusLine moment={moment} />
  </article>;
}

interface RowProps { moment: Moment; related: Moment[]; favorite: boolean; chosen: boolean; onChoose: () => void }

function FanRow({ moment, related, favorite, chosen, onChoose }: RowProps) {
  const language = useLanguage(), roster = useContext(RosterCtx);
  const Icon = RULE_ICON[moment.rule];
  return <button type="button" className="moment-row" aria-pressed={chosen} onClick={onChoose}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}>
    <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    <span className="title" lang={language}>{localStory(moment, roster, language).headline}</span>
    <span className="sub"><Icon size={12} aria-hidden="true" />{ruleName(moment.rule, language)}
      {related.length > 0 && <span className="also">{language === 'es' ? 'también' : 'also'} {related.map(m => ruleName(m.rule, language).toLowerCase()).join(', ')}</span>}
      {favorite && <Star size={11} fill="var(--amber)" color="var(--amber)" aria-label="Involves your favourite" />}</span>
  </button>;
}

function AnalystRow({ moment, related, favorite, chosen, onChoose }: RowProps) {
  const tr = useTr(), language = useLanguage(), roster = useContext(RosterCtx);
  const lead = keyValues(moment, 'analyst')[0];
  return <button type="button" className="moment-row dense" aria-pressed={chosen} onClick={onChoose}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}
    aria-label={`${clockLabel(moment.period, moment.match_time_ms)} ${tr(RULE_LABEL[moment.rule])}: ${localStory(moment, roster, language).headline}`}>
    <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    <span className="rule">{tr(RULE_LABEL[moment.rule])}{related.length ? ` +${related.length}` : ''}{favorite ? ' ★' : ''}</span>
    <span className="team">{moment.team_id ? TEAM_META[moment.team_id]?.short : '–'}</span>
    <span className="val num">{lead ? `${tr(lead.label)} ${num(lead.value)}${lead.unit && lead.unit.length <= 3 ? ` ${tr(lead.unit)}` : ''}` : '–'}</span>
  </button>;
}
