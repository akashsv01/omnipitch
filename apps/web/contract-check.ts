// Compile-time fixture alignment, including exact top-level keys.
import event from '../../contracts/examples/event.example.json';
import state from '../../contracts/examples/match-state.example.json';
import insight from '../../contracts/examples/insight.example.json';
import type { Event, MatchState, Insight } from './src/types/contracts';

type SameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never] ? true : never;
export const eventKeys: SameKeys<typeof event, Event> = true;
export const stateKeys: SameKeys<typeof state, MatchState> = true;
export const insightKeys: SameKeys<typeof insight, Insight> = true;
// JSON imports widen literals; runtime JSON Schema checks verify those literals.
export const exampleEvent: Event = { ...event, schema_version: '1.1', period: 1, type: 'pass', outcome: 'completed', attacking_direction: 'positive_x', synthetic: true };
export const exampleState: MatchState = { ...state, schema_version: '1.1', period: 1, replay_status: 'paused', synthetic: true };
export const exampleInsight: Insight = { ...insight, schema_version: '1.1', language: 'en', generation_mode: 'fixture', generation_status: 'fixture', translations: null };
