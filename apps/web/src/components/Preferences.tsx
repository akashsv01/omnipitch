import { motion } from 'motion/react';
import type { Player } from '../types/contracts';
import type { MotionPref, Prefs } from '../lib/prefs';

export function Preferences({ prefs, update, roster, onClose }: {
  prefs: Prefs; update: (patch: Partial<Prefs>) => void; roster: Player[]; onClose: () => void;
}) {
  const players = roster.filter(player => !prefs.favoriteTeam || player.team_id === prefs.favoriteTeam);
  return <motion.div className="popover" role="dialog" aria-label="Viewing preferences"
    initial={{ opacity: 0, y: -8, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: .97 }}
    transition={{ type: 'spring', stiffness: 500, damping: 34 }}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <h3>Your view</h3>
    <label className="field">Favourite team
      <select value={prefs.favoriteTeam ?? ''} onChange={event => update({ favoriteTeam: event.target.value || null, favoritePlayer: null })}>
        <option value="">No preference</option>
        <option value="harbor">Harbor Comets</option>
        <option value="vale">Vale Owls</option>
      </select>
    </label>
    <label className="field">Favourite player
      <select value={prefs.favoritePlayer ?? ''} onChange={event => update({ favoritePlayer: event.target.value || null })}>
        <option value="">No preference</option>
        {players.map(player => <option key={player.player_id} value={player.player_id}>{player.shirt} {player.name} ({player.position})</option>)}
      </select>
    </label>
    <label className="field">Motion
      <select value={prefs.motion} onChange={event => update({ motion: event.target.value as MotionPref })}>
        <option value="system">Follow system setting</option>
        <option value="full">Full motion</option>
        <option value="reduced">Reduced motion</option>
      </select>
    </label>
    <p className="hint">Favourites move related moments up the list. They never change the facts or numbers. Saved in this browser only.</p>
  </motion.div>;
}
