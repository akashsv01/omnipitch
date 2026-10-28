import { useState } from 'react';
import { Crosshair, X } from 'lucide-react';
import { useTr } from '../lib/i18n';
import type { Player } from '../types/contracts';
import type { FocusMetric, Prefs } from '../lib/prefs';

type FocusPrefs = Pick<Prefs, 'favoriteTeam' | 'favoritePlayer' | 'focusMetric'>;

/** "Follow a club, player or metric", in plain view at the top of the moments column (not only behind the settings
 * icon). The same preferences as the settings panel; changing them never moves the replay or the selected evidence. */
export function FocusPicker({ prefs, update, roster }: { prefs: FocusPrefs; update: (patch: Partial<Prefs>) => void; roster: Player[] }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const following = !!(prefs.favoriteTeam || prefs.favoritePlayer || prefs.focusMetric);
  const players = roster.filter(player => !prefs.favoriteTeam || player.team_id === prefs.favoriteTeam);
  const summary = [
    prefs.favoritePlayer ? roster.find(p => p.player_id === prefs.favoritePlayer)?.name : null,
    !prefs.favoritePlayer && prefs.favoriteTeam ? (prefs.favoriteTeam === 'harbor' ? 'Harbor Comets' : 'Vale Owls') : null,
    prefs.focusMetric ? tr(prefs.focusMetric === 'pressing' ? 'Pressing (PPDA)' : prefs.focusMetric === 'passing' ? 'Passing' : 'Shots') : null,
  ].filter(Boolean).join(' · ');
  return <div className="focus-picker">
    <div className="focus-picker-row">
      <button type="button" className="chip" aria-expanded={open} aria-controls="focus-picker-fields" onClick={() => setOpen(value => !value)}>
        <Crosshair size={14} aria-hidden="true" />{following ? `${tr('Following')}: ${summary}` : tr('Follow a club, player or metric')}
      </button>
      {following && <button type="button" className="icon-button small" aria-label={tr('Stop following')} title={tr('Stop following')}
        onClick={() => update({ favoriteTeam: null, favoritePlayer: null, focusMetric: null })}><X size={14} /></button>}
    </div>
    {open && <div className="focus-picker-fields" id="focus-picker-fields">
      <label className="field">{tr('Club')}
        <select value={prefs.favoriteTeam ?? ''} onChange={event => update({ favoriteTeam: event.target.value || null, favoritePlayer: null })}>
          <option value="">{tr('No preference')}</option>
          <option value="harbor">Harbor Comets</option>
          <option value="vale">Vale Owls</option>
        </select>
      </label>
      <label className="field">{tr('Player')}
        <select value={prefs.favoritePlayer ?? ''} onChange={event => update({ favoritePlayer: event.target.value || null })}>
          <option value="">{tr('No preference')}</option>
          {players.map(player => <option key={player.player_id} value={player.player_id}>{player.shirt} {player.name} ({player.position})</option>)}
        </select>
      </label>
      <label className="field">{tr('Metric')}
        <select value={prefs.focusMetric ?? ''} onChange={event => update({ focusMetric: (event.target.value || null) as FocusMetric | null })}>
          <option value="">{tr('None')}</option>
          <option value="pressing">{tr('Pressing (PPDA)')}</option>
          <option value="passing">{tr('Passing')}</option>
          <option value="shots">{tr('Shots')}</option>
        </select>
      </label>
    </div>}
  </div>;
}
