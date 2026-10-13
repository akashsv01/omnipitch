import { useId } from 'react';
import type { Event } from '../types/contracts';

export function Pitch({ event }: { event: Event | undefined }) {
  const id = useId();
  const description = event
    ? `Completed pass ${event.sequence}: from (${event.start.x}, ${event.start.y}) to (${event.end.x}, ${event.end.y}) metres. ${event.attacking_direction === 'positive_x' ? 'Attacking right' : 'Attacking left'}.`
    : 'No pass available.';

  return <figure className="pitch">
    <svg viewBox="-5 -5 115 78" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>Synthetic football pass on a 105 by 68 metre pitch</title>
      <desc id={`${id}-description`}>{description}</desc>
      <defs>
        <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffe18a" />
        </marker>
      </defs>
      <rect className="pitch-grass" x="0" y="0" width="105" height="68" rx=".4" />
      <g className="pitch-lines">
        <rect x="0" y="0" width="105" height="68" />
        <path d="M 52.5 0 V 68" />
        <circle cx="52.5" cy="34" r="9.15" />
        <rect x="0" y="13.84" width="16.5" height="40.32" />
        <rect x="88.5" y="13.84" width="16.5" height="40.32" />
        <rect x="0" y="24.84" width="5.5" height="18.32" />
        <rect x="99.5" y="24.84" width="5.5" height="18.32" />
        <path d="M -2 30.34 H 0 M -2 30.34 V 37.66 H 0 M 105 30.34 H 107 V 37.66 H 105" />
      </g>
      <g fill="#e4f1e9">
        <circle cx="52.5" cy="34" r=".5" />
        <circle cx="11" cy="34" r=".5" />
        <circle cx="94" cy="34" r=".5" />
      </g>
      {event && <g className="pass-path">
        <line x1={event.start.x} y1={event.start.y} x2={event.end.x} y2={event.end.y} markerEnd={`url(#${id}-arrow)`} />
        <circle className="pass-start" cx={event.start.x} cy={event.start.y} r="1.2" />
        <circle className="pass-end" cx={event.end.x} cy={event.end.y} r="1.2" />
      </g>}
    </svg>
    <figcaption>
      <span>105 × 68 m · Fixed coordinates: x →, y ↓</span>
      <span>{event ? `Attack ${event.attacking_direction === 'positive_x' ? '→ right (+x)' : '← left (−x)'}` : 'No event selected'}</span>
    </figcaption>
    <p className="muted">Outlined marker: pass start. Filled marker: pass end. Arrow: pass path, not player tracking.</p>
  </figure>;
}
