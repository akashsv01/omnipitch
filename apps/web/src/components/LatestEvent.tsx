import type { Event } from '../types/contracts';

export function LatestEvent({ event }: { event: Event | undefined }) {
  if (!event) return <section><h2>Latest event</h2><p>No events available.</p></section>;
  return <section>
    <h2>Latest event</h2>
    <p><strong>Completed pass</strong> · #{event.sequence} · Period {event.period} · {(event.match_time_ms / 1000).toFixed(0)} seconds</p>
    <dl>
      <dt>Player / team</dt><dd>{event.player_id} / {event.team_id}</dd>
      <dt>Pass coordinates</dt><dd>({event.start.x}, {event.start.y}) → ({event.end.x}, {event.end.y}) metres</dd>
      <dt>Attack direction</dt><dd>{event.attacking_direction}</dd>
      <dt>Event / possession</dt><dd>{event.event_id} / {event.possession_id}</dd>
      <dt>Emitted at (UTC)</dt><dd>{event.emitted_at}</dd>
    </dl>
  </section>;
}
