import { useCallback, useEffect, useState } from 'react';

export type Audience = 'fan' | 'analyst';
export type MotionPref = 'system' | 'reduced' | 'full';
export interface Prefs {
  audience: Audience;
  favoriteTeam: string | null;
  favoritePlayer: string | null;
  motion: MotionPref;
  layers: { trail: boolean; threat: boolean; density: boolean; network: boolean };
}

const KEY = 'omnipitch.prefs.v1';
export const DEFAULT_PREFS: Prefs = {
  audience: 'fan', favoriteTeam: null, favoritePlayer: null, motion: 'system',
  layers: { trail: true, threat: false, density: false, network: false },
};

function read(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (stored && typeof stored === 'object') return { ...DEFAULT_PREFS, ...stored, layers: { ...DEFAULT_PREFS.layers, ...stored.layers } };
  } catch { /* Storage can be unavailable; defaults keep the app usable. */ }
  return DEFAULT_PREFS;
}

/** Viewer preferences live in browser storage; they never change underlying facts. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(read);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* Ignore unavailable storage. */ }
  }, [prefs]);
  const update = useCallback((patch: Partial<Prefs>) => setPrefs(previous => ({ ...previous, ...patch })), []);
  return [prefs, update] as const;
}
