import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Crosshair, Eye, FileSearch, Goal, Radar, Repeat2, RotateCcw, ShieldCheck, Sparkles, Star } from 'lucide-react';
import type { Moment, Player, Rule } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, TEAM_META, clockLabel, momentInvolves, teamTone } from '../lib/format';
import { GENERATION_LABEL, GENERATION_SHORT, calculationRows, generation, keyValues, metricRows, whyItMatters } from '../lib/evidence';

// The insight source mode, for honest per-card generation labels without threading a prop through every row.
const AiMode = createContext('off');
import { Crest } from './Crest';
import { UI, localStory, useLanguage, whyEs } from '../lib/i18n';

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
export const MomentFeed = memo(function MomentFeed({ moments, audience, favoriteTeam, favoritePlayer, roster, chosenId, onChoose, onEvidence, onJump, aiMode, onRecap }: {
  moments: Moment[]; audience: Audience; favoriteTeam: string | null; favoritePlayer: string | null; roster: Player[]; aiMode: string;
  chosenId: string | undefined; onChoose: (moment: Moment | undefined) => void;
  onEvidence: (moment: Moment) => void; onJump: (moment: Moment) => void; onRecap: () => void;
}) {
  const fan = audience === 'fan';
  const language = useLanguage();
  const [filter, setFilter] = useState<'all' | Rule>('all');
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
    // A backwards seek removes moments; drop them from the accepted set too.
    if ([...accepted].some(id => !present.has(id))) setAccepted(previous => new Set([...previous].filter(id => present.has(id))));
  }, [moments]); // eslint-disable-line react-hooks/exhaustive-deps
  // A fan-hidden filter must not strand a fan with an empty list.
  useEffect(() => { if (fan && !FILTERS.find(f => f.id === filter)?.fan) setFilter('all'); }, [fan, filter]);

  const shown = useMemo(() => moments.filter(m => accepted.has(m.moment_id)), [moments, accepted]);
  const ordered = useMemo(() => {
    const visible = shown.filter(moment => filter === 'all' || moment.rule === filter);
    // Favourites change priority, never the facts: favourite moments float above others of the same recency band.
    return [...visible].sort((a, b) => {
      const fa = momentInvolves(a, favoriteTeam, favoritePlayer) ? 1 : 0;
      const fb = momentInvolves(b, favoriteTeam, favoritePlayer) ? 1 : 0;
      return Math.floor(b.source_sequence / 120) - Math.floor(a.source_sequence / 120) || fb - fa || b.source_sequence - a.source_sequence || b.priority - a.priority;
    });
  }, [shown, filter, favoriteTeam, favoritePlayer]);
  const counts = useMemo(() => shown.reduce<Record<string, number>>((all, m) => ({ ...all, [m.rule]: (all[m.rule] ?? 0) + 1 }), {}), [shown]);
  const favoriteName = roster.find(player => player.player_id === favoritePlayer)?.name;
  const chosen = chosenId ? moments.find(m => m.moment_id === chosenId) : undefined;
  const featured = chosen ?? ordered[0];
  // Newer than the moment the reader picked: offered, never forced.
  const newer = chosen ? shown.filter(m => m.source_sequence > chosen.source_sequence).length : 0;
  const rest = ordered.filter(m => m !== featured).slice(0, fan ? 40 : 60);
  const Spot = fan ? FanSpotlight : AnalystInspector;
  const Row = fan ? FanRow : AnalystRow;

  return <AiMode.Provider value={aiMode}><RosterCtx.Provider value={roster}><aside className="desk-spot" data-audience={audience} aria-labelledby="moments-title">
    {/* Remounted per audience so only this supporting panel animates on a mode change; its state lives above. */}
    <div key={audience} className="mode-swap">
    <div className="spot-head">
      <h2 id="moments-title">{fan ? UI[language].keyMoments : 'Moment inspector'}</h2>
      <p>{shown.length ? `${shown.length} detected so far` : 'Detected from the events'}{favoriteName ? `, ${favoriteName} first` : ''}
        {shown.length > 0 && <> · <button type="button" className="text-button inline" onClick={onRecap}>Match recap</button></>}</p>
    </div>
    {featured
      ? <Spot key={featured.moment_id} moment={featured} fresh={fresh.has(featured.moment_id)} pinned={!!chosen}
          favorite={!!momentInvolves(featured, favoriteTeam, favoritePlayer)} onEvidence={onEvidence} onJump={onJump}
          onInspect={() => onChoose(chosen ? undefined : featured)} />
      : <div className="spotlight" style={{ ['--tone' as string]: 'var(--line-2)' }}>
          <div className="empty"><Sparkles size={22} aria-hidden="true" /><strong>No moments yet</strong>
            <span>Press play. Moments appear when the events support them; a quiet spell stays quiet.</span></div>
        </div>}
    {newer > 0 && <div className="newer" style={{ background: 'none', paddingTop: 10 }}>
      <button type="button" onClick={() => onChoose(undefined)}>Show latest ({newer} newer moment{newer === 1 ? '' : 's'})</button>
    </div>}
    <div className="history">
      <div className="history-head"><h3>{fan ? 'Earlier in the match' : 'Timeline'}</h3>{!fan && <span className="hint">min · rule · team · key value · author</span>}</div>
      <div className="filter-row" role="group" aria-label="Filter moments">
        {FILTERS.filter(item => !fan || item.fan).map(item => <button key={item.id} type="button" className="chip" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
          {item.label}{item.id !== 'all' && counts[item.id] ? <span className="count num">{counts[item.id]}</span> : null}
        </button>)}
      </div>
      <div className="history-body" ref={body}
        onScroll={event => { reading.current.scrolled = event.currentTarget.scrollTop > 6; if (!reading.current.scrolled && !reading.current.pointer && !reading.current.focus && pending.length) acceptAll(false); }}
        onPointerEnter={() => { reading.current.pointer = true; }}
        onPointerLeave={() => { reading.current.pointer = false; if (pending.length && !isReading()) acceptAll(false); }}
        onFocus={() => { reading.current.focus = true; }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) reading.current.focus = false; }}>
        {pending.length > 0 && <div className="newer">
          <button type="button" onClick={() => acceptAll(true)}>{pending.length} new moment{pending.length === 1 ? '' : 's'}: show</button>
        </div>}
        {rest.length === 0
          ? <p className="quiet-note">{shown.length && filter !== 'all' && !ordered.length ? 'Nothing of this type yet. Try another filter.' : 'Earlier moments collect here.'}</p>
          : <ol className={fan ? 'moment-list' : 'moment-list dense'} aria-label="Earlier moments">
            {rest.map(moment => <li key={moment.moment_id} className={fresh.has(moment.moment_id) ? 'moment-enter' : undefined}>
              <Row moment={moment} favorite={!!momentInvolves(moment, favoriteTeam, favoritePlayer)}
                chosen={moment.moment_id === chosenId} onChoose={() => onChoose(moment.moment_id === chosenId ? undefined : moment)} />
            </li>)}
          </ol>}
      </div>
    </div>
    </div>
  </aside></RosterCtx.Provider></AiMode.Provider>;
});

export function AuthorTag({ moment }: { moment: Moment }) {
  const gen = generation(moment, useContext(AiMode));
  return <span className="author-tag" data-mode={gen} title={GENERATION_LABEL[gen]}>
    {gen === 'ai' && <Sparkles size={11} aria-hidden="true" />}{GENERATION_SHORT[gen]}
  </span>;
}

interface SpotProps {
  moment: Moment; favorite: boolean; fresh: boolean; pinned: boolean;
  onEvidence: (m: Moment) => void; onJump: (m: Moment) => void; onInspect: () => void;
}

function SpotMeta({ moment, favorite }: { moment: Moment; favorite: boolean }) {
  const Icon = RULE_ICON[moment.rule];
  const team = moment.team_id ? TEAM_META[moment.team_id] : undefined;
  return <div className="spot-meta">
    <span className="spot-minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    {team && moment.team_id && <span className="spot-team" style={{ color: team.tone }}><Crest team={moment.team_id} />{team.name}</span>}
    <span className="spot-kind"><Icon size={14} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
    {favorite && <Star size={13} fill="var(--amber)" color="var(--amber)" aria-label="Involves your favourite" />}
  </div>;
}

function StatusLine({ moment }: { moment: Moment }) {
  const gen = generation(moment, useContext(AiMode));
  return <p className="status-line" data-mode={gen}>
    {gen === 'ai' ? <ShieldCheck size={13} aria-hidden="true" /> : null}{GENERATION_LABEL[gen]}
  </p>;
}

/** Fan: one takeaway. What happened, why it matters, at most two plain values, two clear actions. */
function FanSpotlight({ moment, favorite, fresh, pinned, onEvidence, onJump, onInspect }: SpotProps) {
  const values = keyValues(moment, 'fan');
  const language = useLanguage(), t = UI[language], lang = language;
  const story = localStory(moment, useContext(RosterCtx), language);
  return <article className={`spotlight fan${fresh ? ' moment-enter' : ''}`} data-rule={moment.rule} style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    aria-labelledby={`spot-${moment.moment_id}`}>
    <SpotMeta moment={moment} favorite={favorite} />
    <h3 id={`spot-${moment.moment_id}`} lang={lang}>{story.headline}</h3>
    <div className="qa" lang={lang}>
      <p><span>{t.whatHappened}</span><span className="said" lang={story.englishOnly ? 'en' : lang}>{story.casual}</span>{story.englishOnly && <small className="en-only">{t.aiEnglish}</small>}</p>
      <p><span>{t.whyMatters}</span>{language === 'es' ? whyEs(moment, 'fan') : whyItMatters(moment, 'fan')}</p>
    </div>
    {values.length > 0 && <dl className="key-values">
      {values.map(item => <div key={item.label}><dt>{t[item.label] ?? item.label}</dt><dd>{language === 'es' ? item.value.replace('.', ',') : item.value}{item.unit && <small>{item.unit}</small>}</dd></div>)}
    </dl>}
    <div className="spot-actions">
      <button type="button" className="button primary" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />{t.whyBtn}</button>
      <button type="button" className="button ghost" onClick={() => onJump(moment)}><RotateCcw size={14} aria-hidden="true" />{t.replay}</button>
      <button type="button" className="text-button quiet" aria-pressed={pinned} onClick={onInspect}><Eye size={14} aria-hidden="true" />{pinned ? 'Return to replay' : 'Show sequence on pitch'}</button>
    </div>
    <StatusLine moment={moment} />
  </article>;
}

/** Analyst: an inspector. Aligned metric rows with units, the calculation and trigger, the source events. */
function AnalystInspector({ moment, favorite, fresh, pinned, onEvidence, onJump, onInspect }: SpotProps) {
  const language = useLanguage();
  const story = localStory(moment, useContext(RosterCtx), language);
  const rows = metricRows(moment);
  const calc = calculationRows(moment).filter(([term]) => term !== 'Trigger' && term !== 'Rule version');
  return <article className={`spotlight analyst${fresh ? ' moment-enter' : ''}`} data-rule={moment.rule} style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    aria-labelledby={`spot-${moment.moment_id}`}>
    <SpotMeta moment={moment} favorite={favorite} />
    <h3 id={`spot-${moment.moment_id}`} lang={language}>{story.headline}</h3>
    <p className="story" lang={story.englishOnly ? 'en' : language}>{story.analyst}{story.englishOnly && <small className="en-only"> {UI[language].aiEnglish}</small>}</p>
    <table className="inspect-table" aria-label="Metrics">
      <tbody>
        {rows.map(row => <tr key={row.name}><th scope="row">{row.label}</th><td className="num">{row.shown}</td><td className="unit">{row.unit}</td></tr>)}
        {calc.map(([term, value]) => <tr key={term}><th scope="row">{term}</th><td colSpan={2}>{value}</td></tr>)}
        <tr><th scope="row">Why flagged</th><td colSpan={2} lang={language}>{language === 'es' ? whyEs(moment, 'analyst') : whyItMatters(moment, 'analyst')}</td></tr>
        <tr><th scope="row">Source events</th><td colSpan={2} className="mono">{moment.evidence_ids.length} · {moment.evidence_ids[0]}{moment.evidence_ids.length > 1 ? ` … ${moment.evidence_ids[moment.evidence_ids.length - 1]}` : ''}</td></tr>
        <tr><th scope="row">Versions</th><td colSpan={2}>{moment.rule_version} · {moment.metric_version}</td></tr>
      </tbody>
    </table>
    <div className="spot-actions">
      <button type="button" className="button primary" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />Inspect evidence</button>
      <button type="button" className="button ghost" onClick={() => onJump(moment)}><RotateCcw size={14} aria-hidden="true" />Replay from {clockLabel(moment.period, moment.match_time_ms)}</button>
      <button type="button" className="text-button quiet" aria-pressed={pinned} onClick={onInspect}><Eye size={14} aria-hidden="true" />{pinned ? 'Return to replay' : 'Show sequence on pitch'}</button>
    </div>
    <StatusLine moment={moment} />
  </article>;
}

interface RowProps { moment: Moment; favorite: boolean; chosen: boolean; onChoose: () => void }

function FanRow({ moment, favorite, chosen, onChoose }: RowProps) {
  const language = useLanguage(), roster = useContext(RosterCtx);
  const Icon = RULE_ICON[moment.rule];
  return <button type="button" className="moment-row" aria-pressed={chosen} onClick={onChoose}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}>
    <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    <span className="title" lang={language}>{localStory(moment, roster, language).headline}</span>
    <AuthorTag moment={moment} />
    <span className="sub"><Icon size={12} aria-hidden="true" />{RULE_LABEL[moment.rule]}
      {favorite && <Star size={11} fill="var(--amber)" color="var(--amber)" aria-label="Involves your favourite" />}</span>
  </button>;
}

function AnalystRow({ moment, favorite, chosen, onChoose }: RowProps) {
  const lead = keyValues(moment, 'analyst')[0];
  return <button type="button" className="moment-row dense" aria-pressed={chosen} onClick={onChoose}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}
    aria-label={`${clockLabel(moment.period, moment.match_time_ms)} ${RULE_LABEL[moment.rule]}: ${moment.insight.headline}`}>
    <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    <span className="rule">{RULE_LABEL[moment.rule]}{favorite ? ' ★' : ''}</span>
    <span className="team">{moment.team_id ? TEAM_META[moment.team_id]?.short : '–'}</span>
    <span className="val num">{lead ? `${lead.label} ${lead.value}${lead.unit ? ` ${lead.unit}` : ''}` : '–'}</span>
    <AuthorTag moment={moment} />
  </button>;
}
