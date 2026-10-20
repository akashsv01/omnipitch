import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Crosshair, FileSearch, Goal, Radar, Repeat2, Sparkles, Star } from 'lucide-react';
import type { Moment, Player, Rule } from '../types/contracts';
import type { Audience } from '../lib/prefs';
import { METRIC_LABEL, RULE_LABEL, clockLabel, fmt, momentInvolves, teamTone } from '../lib/format';

export const RULE_ICON: Record<Rule, typeof Goal> = {
  goal: Goal, chance: Crosshair, threat_gain: ArrowUpRight, transition: Repeat2, pressing_change: Radar,
};
const FILTERS: { id: 'all' | Rule; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'goal', label: 'Goals' }, { id: 'chance', label: 'Chances' },
  { id: 'transition', label: 'Transitions' }, { id: 'pressing_change', label: 'Pressing' }, { id: 'threat_gain', label: 'Threat' },
];

export function MomentFeed({ moments, audience, favoriteTeam, favoritePlayer, roster, onEvidence, onJump }: {
  moments: Moment[]; audience: Audience; favoriteTeam: string | null; favoritePlayer: string | null; roster: Player[];
  onEvidence: (moment: Moment) => void; onJump: (moment: Moment) => void;
}) {
  const [filter, setFilter] = useState<'all' | Rule>('all');
  const ordered = useMemo(() => {
    const visible = moments.filter(moment => filter === 'all' || moment.rule === filter);
    // Favourites change priority, never the facts: favourite moments float above others of the same recency band.
    return [...visible].sort((a, b) => {
      const fa = momentInvolves(a, favoriteTeam, favoritePlayer) ? 1 : 0;
      const fb = momentInvolves(b, favoriteTeam, favoritePlayer) ? 1 : 0;
      const bandA = Math.floor(a.source_sequence / 120);
      const bandB = Math.floor(b.source_sequence / 120);
      return bandB - bandA || fb - fa || b.source_sequence - a.source_sequence || b.priority - a.priority;
    });
  }, [moments, filter, favoriteTeam, favoritePlayer]);
  const counts = useMemo(() => moments.reduce<Record<string, number>>((all, m) => ({ ...all, [m.rule]: (all[m.rule] ?? 0) + 1 }), {}), [moments]);
  const favoriteName = roster.find(player => player.player_id === favoritePlayer)?.name;

  return <section className="panel moments" aria-labelledby="moments-title">
    <div className="panel-head">
      <div>
        <h2 className="panel-title" id="moments-title">Key moments</h2>
        <p className="panel-sub">{moments.length ? `${moments.length} detected from the events so far` : 'Detected from incoming events'}{favoriteName ? `, ${favoriteName} first` : ''}</p>
      </div>
    </div>
    <div className="filter-row" role="toolbar" aria-label="Filter moments">
      {FILTERS.map(item => <button key={item.id} type="button" className="chip" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
        {item.label}{item.id !== 'all' && counts[item.id] ? ` ${counts[item.id]}` : ''}
      </button>)}
    </div>
    {ordered.length === 0
      ? <div className="empty"><Sparkles size={22} /><strong>{moments.length ? 'Nothing of this type yet' : 'No moments yet'}</strong>
          <span>{moments.length ? 'Try another filter.' : 'Press play. Moments appear when the events support them, and a quiet spell stays quiet.'}</span></div>
      : <ol className="moment-list" aria-live="polite">
        <AnimatePresence initial={false}>
          {ordered.slice(0, 60).map(moment => <MomentCard key={moment.moment_id} moment={moment} audience={audience}
            favorite={!!momentInvolves(moment, favoriteTeam, favoritePlayer)} onEvidence={onEvidence} onJump={onJump} />)}
        </AnimatePresence>
      </ol>}
  </section>;
}

function MomentCard({ moment, audience, favorite, onEvidence, onJump }: {
  moment: Moment; audience: Audience; favorite: boolean; onEvidence: (m: Moment) => void; onJump: (m: Moment) => void;
}) {
  const Icon = RULE_ICON[moment.rule];
  const insight = moment.insight;
  return <motion.li layout="position" className="moment-card" data-rule={moment.rule} data-favorite={favorite}
    style={{ ['--tone' as string]: teamTone(moment.team_id) }}
    initial={{ opacity: 0, y: -14, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .98 }}
    transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
    <div className="moment-meta">
      <span className="minute">{clockLabel(moment.period, moment.match_time_ms)}</span>
      <span className="rule-tag"><Icon size={13} aria-hidden="true" />{RULE_LABEL[moment.rule]}</span>
      {favorite && <Star size={13} fill="var(--flood)" color="var(--flood)" aria-label="Involves your favourite" />}
      <span className="author-tag" data-mode={insight.generation_mode}
        title={insight.generation_mode === 'ai' ? 'Written by the AI model from verified evidence; numbers, names and claims checked in code'
          : 'Deterministic template from verified metrics'}>
        {insight.generation_mode === 'ai' ? <><Sparkles size={11} aria-hidden="true" />AI</> : 'Template'}
      </span>
    </div>
    <h3>{insight.headline}</h3>
    <p>{audience === 'fan' ? insight.casual_text : insight.analyst_text}</p>
    {audience === 'analyst' && <div className="metric-chips">
      {moment.metrics.slice(0, 4).map(metric => <span key={metric.name} className="metric-chip">
        {METRIC_LABEL[metric.name] ?? metric.name}<b>{fmt(metric.value, metric.value < 1 && metric.value > -1 ? 3 : 1)}</b>{metric.unit.startsWith('illustrative') ? '' : metric.unit}
      </span>)}
    </div>}
    <div className="moment-actions">
      <button type="button" className="text-button" onClick={() => onEvidence(moment)}><FileSearch size={15} aria-hidden="true" />Show evidence</button>
      <button type="button" className="text-button quiet" onClick={() => onJump(moment)}>Replay from here</button>
    </div>
  </motion.li>;
}
