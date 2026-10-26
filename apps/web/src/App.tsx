import { Suspense, lazy, useCallback, useEffect } from 'react';
import { MotionConfig, useReducedMotion } from 'motion/react';
import { usePrefs, type Audience } from './lib/prefs';
import { useRoute } from './lib/route';
import './style.css';

// Each route is its own chunk: the landing page does not download the match room until it is needed
// (it is prefetched when the browser is idle), and the match room never downloads the landing hero.
const loadMatchRoom = () => import('./MatchRoom');
// Warm both the match-room code and its first snapshot (read-only; never starts or resets a run).
const warmMatchRoom = () => loadMatchRoom().then(module => { module.prefetchReplay(); return module; });
const loadLanding = () => import('./Landing');
const MatchRoom = lazy(loadMatchRoom);
const Landing = lazy(loadLanding);

export default function App() {
  const [prefs, updatePrefs] = usePrefs();
  const systemReduced = useReducedMotion();
  const reduced = prefs.motion === 'reduced' || (prefs.motion === 'system' && !!systemReduced);
  const [route, navigate] = useRoute(reduced);

  useEffect(() => {
    document.documentElement.dataset.route = route;
    document.title = route === 'match' ? 'OmniPitch · Match room' : 'OmniPitch · Football, seen differently';
  }, [route]);

  const enter = useCallback((audience?: Audience) => {
    if (audience) updatePrefs({ audience });
    try { localStorage.setItem('omnipitch.entered', '1'); } catch { /* storage may be unavailable */ }
    return navigate('match', { prepare: warmMatchRoom });
  }, [navigate, updatePrefs]);
  const home = useCallback(() => { void navigate('landing', { prepare: loadLanding }); }, [navigate]);

  return <MotionConfig reducedMotion={prefs.motion === 'reduced' ? 'always' : prefs.motion === 'full' ? 'never' : 'user'}>
    <div data-motion={reduced ? 'reduced' : 'full'}>
      <Suspense fallback={<RouteFallback route={route} />}>
        {route === 'match'
          ? <MatchRoom prefs={prefs} updatePrefs={updatePrefs} reduced={reduced} onHome={home} />
          : <Landing audience={prefs.audience} reduced={reduced} onEnter={enter} prefetch={warmMatchRoom} />}
      </Suspense>
    </div>
  </MotionConfig>;
}

/** Shown only while a route chunk downloads: the destination's colour field, so nothing flashes. */
function RouteFallback({ route }: { route: string }) {
  return <div className={route === 'match' ? 'route-wait dark' : 'route-wait light'} aria-busy="true" aria-label="Loading" />;
}
