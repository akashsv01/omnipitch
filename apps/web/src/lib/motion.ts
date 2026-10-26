/**
 * Motion tokens shared by motion/react components. They mirror the CSS custom properties in style.css
 * (--ease-*, --dur-*), so CSS transitions and JS animations read as one system.
 * Data and pitch positions use ease-out with no overshoot; springs are not used for anything the user reads.
 */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

export const DUR = { press: 0.14, switch: 0.2, enter: 0.24, drawer: 0.3 } as const;

/** Segmented-control and tab indicators: a short, non-bouncing slide. */
export const INDICATOR = { type: 'tween', duration: DUR.switch, ease: EASE_OUT } as const;

/** Popovers anchored to a trigger: scale from 0.96 plus opacity, never from 0. */
export const POPOVER = {
  initial: { opacity: 0, transform: 'scale(0.96)' },
  animate: { opacity: 1, transform: 'scale(1)' },
  exit: { opacity: 0, transform: 'scale(0.96)' },
  transition: { duration: 0.18, ease: EASE_OUT },
} as const;

/**
 * Ball travel between two recorded event locations (illustrative, not tracking). At high replay speeds
 * the rendered state must keep up with the authoritative position, so travel shortens and then stops.
 */
export function travelSeconds(distanceM: number, speed: number): number {
  if (speed >= 20) return 0;
  const base = Math.min(0.8, 0.22 + distanceM / 100);
  return speed >= 10 ? base * 0.4 : speed >= 5 ? base * 0.7 : base;
}
