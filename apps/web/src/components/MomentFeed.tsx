import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Crosshair, FileSearch, Goal, Radar, Repeat2, RotateCcw, Sparkles, Star } from 'lucide-react';
import type { Moment, Player, Rule } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { RULE_LABEL, TEAM_META, clockLabel, fmt, momentInvolves, teamTone } from '../lib/format';

export const RULE_ICON: Record<Rule, typeof Goal> = {
  goal: Goal, chance: Crosshair, threat_gain: ArrowUpRight, transition: Repeat2, pressing_change: Radar,
};
const FILTERS: { id: 'all' | Rule; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'goal', label: 'Goals' }, { id: 'chance', label: 'Chances' },
  { id: 'transition', label: 'Transitions' }, { id: 'pressing_change', label: 'Pressing' }, { id: 'threat_gain', label: 'Threat' },
];

/** Compact key values, only from the moment's own metrics and facts (never invented). */
export function keyValues(moment: Moment): { label: string; value: string; unit?: string }[] {
  const metric = (name: string) => moment.metrics.find(m => m.name === name);
  const show = (name: string, label: string, digits = 1) => {
    const m = metric(name);
    return m ? [{ label, value: fmt(m.value, digits), unit: m.unit.startsWith('illustrative') ? undefined : m.unit }] : [];
  };
  const facts = moment.facts as Record<string, unknown>;
  switch (moment.rule) {
    case 'transition': return [...show('forward_progress', 'Forward'), ...show('elapsed', 'Time'),
      ...(typeof facts.ended_in_shot === 'boolean' ? [{ label: 'Ends in', value: facts.ended_in_shot ? 'Shot' : 'No shot' }] : [])];
    case 'goal': return [...show('shot_distance', 'Shot from'), ...show('possession_actions', 'Build-up', 0)];
    case 'chance': return [...show('shot_distance', 'Shot from'), ...(typeof facts.outcome === 'string' ? [{ label: 'Outcome', value: String(facts.outcome).replace('_', ' ') }] : [])];
    case 'threat_gain': return [...show('threat_delta', 'Threat +', 2), ...show('pass_distance', 'Pass'), ...show('forward_progress', 'Forward')];
    case 'pressing_change': return [...show('ppda', 'PPDA', 2), ...show('previous_ppda', 'Before', 2)];
  }
}

export const MomentFeed = memo(function MomentFeed({ moments, audience, favoriteTeam, favoritePlayer, roster, onEvidence, onJump }: {
  moments: Moment[]; audience: Audience; favoriteTeam: string | null; favoritePlayer: string | null; roster: Player[];
  onEvidence: (moment: Moment) => void; onJump: (moment: Moment) => void;
}) {
  const [filter, setFilter] = useState<'all' | Rule>('all');
  const [chosenId, setChosenId] = useState<string>();
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
      setChosenId(undefined);
      return;
    }
    if (pending.length && !isReading()) acceptAll(false);
    // A backwards seek removes moments; drop them from the accepted set too.
    if ([...accepted].some(id => !present.has(id))) setAccepted(previous => new Set([...previous].filter(id => present.has(id))));
  }, [moments]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const featured = ordered.find(m => m.moment_id === chosenId) ?? ordered[0];
  const rest = ordered.filter(m => m !== featured).slice(0, 60);

  return <aside className="rail" aria-labelledby="moments-title">
    <div className="rail-head">
      <h2 id="moments-title">Key moments</h2>
      <p>{shown.length ? `${shown.length} detected so far` : 'Detected from the events'}{favoriteName ? `, ${favoriteName} first` : ''}</p>
    </div>
    <div className="filter-row" role="group" aria-label="Filter moments">
      {FILTERS.map(item => <button key={item.id} type="button" className="chip" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
        {item.label}{item.id !== 'all' && counts[item.id] ? <span className="num" style={{ color: 'var(--text-3)' }}>{counts[item.id]}</span> : null}
      </button>)}
    </div>
    <div className="rail-body" ref={body}
      onScroll={event => { reading.current.scrolled = event.currentTarget.scrollTop > 6; if (!reading.current.scrolled && !reading.current.pointer && !reading.current.focus && pending.length) acceptAll(false); }}
      onPointerEnter={() => { reading.current.pointer = true; }}
      onPointerLeave={() => { reading.current.pointer = false; if (pending.length && !isReading()) acceptAll(false); }}
      onFocus={() => { reading.current.focus = true; }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) reading.current.focus = false; }}>
      {pending.length > 0 && <div className="new-moments">
        <button type="button" onClick={() => acceptAll(true)}>{pending.length} new moment{pending.length === 1 ? '' : 's'}: show</button>
      </div>}
      {ordered.length === 0
        ? <div className="empty"><Sparkles size={22} /><strong>{shown.length ? 'Nothing of this type yet' : 'No moments yet'}</strong>
            <span>{shown.length ? 'Try another filter.' : 'Press play. Moments appear when the events support them; a quiet spell stays quiet.'}</span></div>
        : <>
          {featured && <Featured key={featured.moment_id} moment={featured} audience={audience} fresh={fresh.has(featured.moment_id)}
            favorite={!!momentInvolves(featured, favoriteTeam, favoritePlayer)} onEvidence={onEvidence} onJump={onJump} />}
          {rest.length > 0 && <ol className="moment-list" aria-label="Earlier moments">
            {rest.map(moment => <li key={moment.moment_id} className={fresh.has(moment.moment_id) ? 'moment-enter' : undefined}>
              <MomentRow moment={moment} favorite={!!momentInvolves(moment, favoriteTeam, favoritePlayer)}
                chosen={moment.moment_id === chosenId} onChoose={() => setChosenId(moment.moment_id)} />
            </li>)}
          </ol>}
        </>}
    </div>
  </aside>;
});

function AuthorTag({ moment }: { moment: Moment }) {
  const ai = moment.insight.generation_mode === 'ai';
  return <span className="author-tag" data-mode={moment.insight.generation_mode}
    title={ai ? 'Written by the AI model from verified evidence; numbers, names and claims checked in code' : 'Deterministic template from verified metrics'}>
    {ai ? <><Sparkles size={11} aria-hidden="true" />AI, checked</> : 'Template'}
  </span>;
}

function Featured({ moment, audience, favorite, fresh, onEvidence, onJump }: {
  moment: Moment; audience: Audience; favorite: boolean; fresh: boolean; onEvidence: (m: Moment) => void; onJump: (m: Moment) => void;
}) {
  const Icon = RULE_ICON[moment.rule];
  const values = keyValues(moment);
  const team = moment.team_id ? TEAM_META[moment.team_id] : undefined;
  return <article className={`featured${fresh ? ' moment-enter' : ''}`} data-rule={moment.rule} style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    aria-labelledby={`featured-${moment.moment_id}`}>
    <div className="moment-meta">
      <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
      <span className="rule-tag"><Icon size={13} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
      {team && <span style={{ color: team.tone }}>{team.name}</span>}
      {favorite && <Star size={13} fill="var(--flood)" color="var(--flood)" aria-label="Involves your favourite" />}
      <span style={{ marginLeft: 'auto' }}><AuthorTag moment={moment} /></span>
    </div>
    <h3 id={`featured-${moment.moment_id}`}>{moment.insight.headline}</h3>
    <p>{audience === 'fan' ? moment.insight.casual_text : moment.insight.analyst_text}</p>
    {values.length > 0 && <dl className="key-values">
      {values.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}{item.unit && <small>{item.unit}</small>}</dd></div>)}
    </dl>}
    <div className="moment-actions">
      <button type="button" className="text-button" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />Show evidence</button>
      <button type="button" className="text-button quiet" onClick={() => onJump(moment)}><RotateCcw size={14} aria-hidden="true" />Replay from {clockLabel(moment.period, moment.match_time_ms)}</button>
    </div>
  </article>;
}

function MomentRow({ moment, favorite, chosen, onChoose }: { moment: Moment; favorite: boolean; chosen: boolean; onChoose: () => void }) {
  const Icon = RULE_ICON[moment.rule];
  return <button type="button" className="moment-row" aria-pressed={chosen} onClick={onChoose}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }} data-rule={moment.rule}>
    <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
    <span className="title">{moment.insight.headline}</span>
    <AuthorTag moment={moment} />
    <span className="sub"><Icon size={12} aria-hidden="true" />{RULE_LABEL[moment.rule]}
      {favorite && <Star size={11} fill="var(--flood)" color="var(--flood)" aria-label="Involves your favourite" />}</span>
  </button>;
}
