import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

/** Two routes, History API only (no router dependency): "/" is the landing page, "/match" the match room.
 * Production nginx already serves index.html for unknown paths, so both survive a refresh. */
export type Route = 'landing' | 'match';

export const PATHS: Record<Route, string> = { landing: '/', match: '/match' };

export function routeOf(pathname: string): Route {
  return /^\/match\/?$/.test(pathname) ? 'match' : 'landing';
}

type ViewTransition = { finished: Promise<void> };
type StartViewTransition = (update: () => Promise<void> | void) => ViewTransition;

/** Runs `update` inside a view transition when the browser supports it and motion is allowed; otherwise
 * applies it at once. A transition that cannot capture in time is skipped by the browser, never awaited. */
export function withViewTransition(update: () => Promise<void> | void, reduced: boolean): Promise<void> {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (reduced || !start) return Promise.resolve(update());
  try {
    return start.call(document, update).finished.catch(() => undefined);
  } catch {
    return Promise.resolve(update());
  }
}

export function useRoute(reduced: boolean) {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  useEffect(() => {
    // Back/Forward: no view transition; the browser restores its own scroll position.
    const onPop = () => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Route, options: { prepare?: () => Promise<unknown> } = {}) => {
    if (routeOf(window.location.pathname) === next) return Promise.resolve();
    const apply = () => {
      window.history.pushState({ route: next }, '', PATHS[next] + window.location.search);
      flushSync(() => setRoute(next));
      window.scrollTo(0, 0);
    };
    // Load the destination chunk before the transition captures (rendering pauses during capture), but never
    // wait on it for long: past 700 ms the destination's own loading state takes over.
    const ready = options.prepare ? Promise.race([options.prepare().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 700))]) : Promise.resolve();
    return ready.then(() => withViewTransition(apply, reduced));
  }, [reduced]);
  return [route, navigate] as const;
}
