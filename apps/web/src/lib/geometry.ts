/** Pitch geometry shared by the pitch, the inspector, evidence, the hero illustration and checks.
 * Mirrors services/analytics/omnipitch_analytics/metrics.py (metrics-v1). One global frame in metres:
 * x along the length (0–105), y across (0–68), no rotation at half-time. Each event carries the attacking
 * direction of its team in that period, so both teams and both halves use the same formulas.
 *
 * The measures below are deliberately different things and are never interchanged:
 * - pass length: planar distance between the recorded start and end;
 * - forward gain: signed displacement along the attacking axis (negative = backwards);
 * - goal-distance reduction: how much closer to the centre of the attacked goal the ball ended;
 * - sequence progression: net forward gain summed over the actions of one sequence (detector's transition rule).
 * Carry displacement and player running distance are not available: events record on-ball actions only. */
export type Direction = 'positive_x' | 'negative_x';
export interface Point { x: number; y: number }
export interface PitchSize { length: number; width: number }

export const PITCH: PitchSize = { length: 105, width: 68 };

/** Provider coordinates given as 0–100 percentages of the pitch, converted to metres before any distance. */
export function fromPercent(point: Point, pitch: PitchSize = PITCH): Point {
  return { x: point.x / 100 * pitch.length, y: point.y / 100 * pitch.width };
}

/** The team-relative frame: the team attacks towards x = length. */
export function attackingFrame(point: Point, direction: Direction, pitch: PitchSize = PITCH): Point {
  return direction === 'positive_x' ? point : { x: pitch.length - point.x, y: pitch.width - point.y };
}

export const passLength = (start: Point, end: Point) => Math.hypot(end.x - start.x, end.y - start.y);

export const forwardGain = (start: Point, end: Point, direction: Direction) =>
  (end.x - start.x) * (direction === 'positive_x' ? 1 : -1);

/** Distance to the centre of the goal being attacked. */
export function goalDistance(point: Point, direction: Direction, pitch: PitchSize = PITCH) {
  const p = attackingFrame(point, direction, pitch);
  return Math.hypot(pitch.length - p.x, pitch.width / 2 - p.y);
}

/** Explainable pass difficulty indicator (0–100), mirroring metrics.py pass_difficulty: a heuristic from recorded
 * inputs only (length, forward gain, destination, width). It is not a completion probability: there are no defender
 * positions or pressure in this data. Bands: under 35 routine, 35–59 moderate, 60+ difficult. */
export function passDifficulty(start: Point, end: Point, direction: Direction, pitch: PitchSize = PITCH) {
  const a = attackingFrame(start, direction, pitch), b = attackingFrame(end, direction, pitch);
  const inBox = b.x >= 88.5 && b.y >= 13.84 && b.y <= 54.16;
  const parts = {
    length: Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / 40) * 40,
    forward: Math.min(1, Math.max(0, b.x - a.x) / 30) * 25,
    destination: inBox ? 20 : b.x >= 70 ? 10 : 0,
    width: Math.min(1, Math.abs(b.y - a.y) / 25) * 15,
  };
  const score = Math.round(parts.length + parts.forward + parts.destination + parts.width);
  return { score, band: score >= 60 ? 'difficult' : score >= 35 ? 'moderate' : 'routine' as 'difficult' | 'moderate' | 'routine', parts };
}

export const goalDistanceReduction = (start: Point, end: Point, direction: Direction, pitch: PitchSize = PITCH) =>
  goalDistance(start, direction, pitch) - goalDistance(end, direction, pitch);
