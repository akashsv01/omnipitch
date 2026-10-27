import { motion } from 'motion/react';
import { useTr } from '../lib/i18n';
import type { Player } from '../types/contracts';
import type { FocusMetric, MotionPref, Prefs } from '../lib/prefs';

export function Preferences({ prefs, update, roster, onClose }: {
  prefs: Prefs; update: (patch: Partial<Prefs>) => void; roster: Player[]; onClose: () => void;
}) {
  const tr = useTr();
  const players = roster.filter(player => !prefs.favoriteTeam || player.team_id === prefs.favoriteTeam);
  return <motion.div className="popover" role="dialog" aria-label={tr('Viewing preferences')}
    initial={{ opacity: 0, y: -8, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: .97 }}
    transition={{ type: 'spring', stiffness: 500, damping: 34 }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <h3>{tr('Your view')}</h3>
    <label className="field">{tr('Favourite team')}
      <select value={prefs.favoriteTeam ?? ''} onChange={event => update({ favoriteTeam: event.target.value || null, favoritePlayer: null })}>
        <option value="">{tr('No preference')}</option>
        <option value="harbor">Harbor Comets</option>
        <option value="vale">Vale Owls</option>
      </select>
    </label>
    <label className="field">{tr('Favourite player')}
      <select value={prefs.favoritePlayer ?? ''} onChange={event => update({ favoritePlayer: event.target.value || null })}>
        <option value="">{tr('No preference')}</option>
        {players.map(player => <option key={player.player_id} value={player.player_id}>{player.shirt} {player.name} ({player.position})</option>)}
      </select>
    </label>
    <label className="field">{tr('Follow a metric')}
      <select value={prefs.focusMetric ?? ''} onChange={event => update({ focusMetric: (event.target.value || null) as FocusMetric | null })}>
        <option value="">{tr('None')}</option>
        <option value="pressing">{tr('Pressing (PPDA)')}</option>
        <option value="passing">{tr('Passing')}</option>
        <option value="shots">{tr('Shots')}</option>
      </select>
    </label>
    <label className="field">{tr('Explanation language')}
      <select value={prefs.language} onChange={event => update({ language: event.target.value as Prefs['language'] })}>
        <option value="en">English</option>
        <option value="es" lang="es">Español (rule-based explanations)</option>
      </select>
    </label>
    <label className="field">{tr('Motion')}
      <select value={prefs.motion} onChange={event => update({ motion: event.target.value as MotionPref })}>
        <option value="system">{tr('Follow system setting')}</option>
        <option value="full">{tr('Full motion')}</option>
        <option value="reduced">{tr('Reduced motion')}</option>
      </select>
    </label>
    <p className="hint">{tr('Your focus appears beside the moments and adds a Focus filter. The match history stays in time order, and the facts and numbers never change. Saved in this browser only.')}</p>
  </motion.div>;
}
