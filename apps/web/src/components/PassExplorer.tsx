import { useState } from 'react';
import type { Event } from '../types/contracts';
import { LatestEvent } from './LatestEvent';
import { Pitch } from './Pitch';

export function PassExplorer({ events }: { events: Event[] }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = events.find(event => `${event.run_id}:${event.event_id}` === selectedId) ?? events.at(-1);

  return <>
    <section aria-labelledby="pitch-heading">
      <div className="pitch-heading"><h2 id="pitch-heading">Pass explorer</h2><span className="sample-badge">Synthetic sample</span></div>
      <p className="muted">Select a revealed pass to inspect its path. The newest pass is selected automatically until you choose one.</p>
      <Pitch event={selected} />
      {events.length > 0 ? <ol className="event-list" aria-label="Completed passes">
        {events.map(event => <li key={`${event.run_id}:${event.event_id}`}>
          <button type="button" aria-pressed={event === selected} onClick={() => setSelectedId(`${event.run_id}:${event.event_id}`)}>
            <strong>Pass {event.sequence}</strong>
            <span>Period {event.period} · {(event.match_time_ms / 1000).toFixed(0)} s</span>
            <span>{event.player_id}</span>
          </button>
        </li>)}
      </ol> : <p>No completed passes available.</p>}
    </section>
    <LatestEvent event={selected} title="Selected event" />
  </>;
}
