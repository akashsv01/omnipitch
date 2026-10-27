/** The landing page's ILLUSTRATIVE sequence (not match data), shared by the 3D hero, its SVG fallback and the
 * Fan/Analyst preview so all three always show the same four actions. Metres in the global 105 x 68 frame,
 * attacking towards increasing x. Every number shown in the preview is computed from these coordinates with the
 * shared geometry (lib/geometry.ts); nothing else (time, speed, probability, tracking) is invented. */
import { forwardGain, passLength, goalDistance } from './geometry';
import { metricText } from './format';

export interface HeroStep {
  key: 'regain' | 'pass' | 'entry' | 'shot';
  x: number; y: number;
  label: string;
  /** Fan: one plain sentence for this step. */
  story: string;
  /** Analyst: the event type as the data model records it. */
  event: string;
}

export const GOAL = { x: 105, y: 35.4 };
const DIRECTION = 'positive_x' as const;
const m = (value: number) => `${metricText('pass_distance', value)} m`;
const signed = (value: number) => `${value >= 0 ? '+' : '−'}${metricText('forward_progress', Math.abs(value))} m`;

const POINTS = [{ x: 36, y: 47 }, { x: 60, y: 28 }, { x: 91, y: 40 }, GOAL];
const gain = (i: number) => forwardGain(POINTS[i - 1], POINTS[i], DIRECTION);

export const HERO_STEPS: HeroStep[] = [
  { key: 'regain', ...POINTS[0], label: 'Ball won', event: 'Interception',
    story: 'The ball is won back in midfield.' },
  { key: 'pass', ...POINTS[1], label: 'Forward pass', event: 'Pass · completed',
    story: `A diagonal pass moves the ball ${metricText('forward_progress', gain(1))} m upfield.` },
  { key: 'entry', ...POINTS[2], label: 'Into the box', event: 'Pass · completed',
    story: 'The next pass reaches the penalty area.' },
  { key: 'shot', ...POINTS[3], label: 'Shot on target', event: 'Shot · on target',
    story: 'A shot on target follows from inside the box.' },
];

export interface StepDetail {
  /** Football meaning first: the measures that matter for this step. */
  rows: { term: string; value: string }[];
  /** Coordinates and how the measures were calculated, for a disclosure. */
  workings: string[];
}

/** Analyst rows for one step, with the coordinates and arithmetic kept for a disclosure. */
export function stepDetail(index: number): StepDetail {
  const step = HERO_STEPS[index];
  const from = POINTS[Math.max(0, index - 1)], to = POINTS[index];
  const at = (p: { x: number; y: number }) => `(${p.x}, ${p.y})`;
  if (step.key === 'regain') return {
    rows: [{ term: 'Event', value: step.event }, { term: 'Starts', value: 'Transition check: ≥ 35 m forward or a shot within 12 s' }],
    workings: [`Location ${at(to)} m, attacking towards x = 105.`],
  };
  if (step.key === 'shot') {
    const progression = POINTS.slice(1, 3).reduce((sum, _, i) => sum + gain(i + 1), 0);
    return {
      rows: [{ term: 'Event', value: step.event }, { term: 'Shot distance', value: m(goalDistance(from, DIRECTION)) },
        { term: 'Sequence progression', value: signed(progression) }],
      workings: [`Shot from ${at(from)} m to the goal centre (105, 34): √(${105 - from.x}² + ${34 - from.y}²).`,
        `Sequence progression sums the forward gain of both passes: ${metricText('forward_progress', gain(1))} + ${metricText('forward_progress', gain(2))} m.`],
    };
  }
  return {
    rows: [{ term: 'Event', value: step.event }, { term: 'Pass length', value: m(passLength(from, to)) },
      { term: 'Forward gain', value: signed(gain(index)) },
      ...(step.key === 'entry' ? [{ term: 'Entry', value: 'Penalty area' }] : [])],
    workings: [`${at(from)} → ${at(to)} m.`, `Pass length √(${to.x - from.x}² + ${to.y - from.y}²); forward gain is the change in x towards the attacked goal.`],
  };
}
