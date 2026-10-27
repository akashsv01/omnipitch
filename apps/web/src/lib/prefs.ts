import { useCallback, useEffect, useState } from 'react';
import type { FocusMetric } from './focus';

export type Audience = 'fan' | 'analyst';
export type MotionPref = 'system' | 'reduced' | 'full';
export type Language = 'en' | 'es';
export interface Prefs {
  audience: Audience;
  /** Language of the moment explanations (rule-based stories); AI text stays in English. */
  language: Language;
  favoriteTeam: string | null;
  favoritePlayer: string | null;
  /** One metric the room centres on, or none. */
  focusMetric: FocusMetric | null;
  motion: MotionPref;
  /** Fan pitch layers (advanced ones live under "Explore tactics"). */
  layers: { trail: boolean; threat: boolean; density: boolean; network: boolean };
  /** Analyst pitch layers, remembered separately so switching audience never rewrites the other mode's view. */
  analystLayers: { trail: boolean; threat: boolean; density: boolean; network: boolean };
}

const KEY = 'omnipitch.prefs.v1';
export const DEFAULT_PREFS: Prefs = {
  audience: 'fan', language: 'en', favoriteTeam: null, favoritePlayer: null, focusMetric: null, motion: 'system',
  layers: { trail: true, threat: false, density: false, network: false },
  analystLayers: { trail: true, threat: true, density: false, network: false },
};

function read(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (stored && typeof stored === 'object') return { ...DEFAULT_PREFS, ...stored, layers: { ...DEFAULT_PREFS.layers, ...stored.layers },
      analystLayers: { ...DEFAULT_PREFS.analystLayers, ...stored.analystLayers } };
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
