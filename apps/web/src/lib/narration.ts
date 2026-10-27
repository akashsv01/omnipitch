/** Every voice in the app goes through one hub: live commentary, narrated recaps, "Listen + replay" and producer
 * commentary. Only one plays at a time. A higher-priority owner (evidence the viewer asked for > recap > live)
 * stops a lower one; a lower one cannot start over a higher one. Text is always composed on the server; the browser
 * only names what to say (a moment, a commentary reference or a recap) and gets back audio plus the spoken caption.
 * Credentials stay on the server. Nothing plays until the viewer turns it on. */
import { API_BASE_URL } from './api';
import type { Audience, Language } from './prefs';

export interface SpeechStatus { configured: boolean; reason: string | null }
export type NarratorState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
export type Owner = 'live' | 'recap' | 'evidence';
const RANK: Record<Owner, number> = { live: 1, recap: 2, evidence: 3 };
export const UNAVAILABLE = 'Commentary unavailable. Text updates continue.';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

let status: Promise<SpeechStatus> | null = null;
export function speechStatus(): Promise<SpeechStatus> {
  status ??= fetch(`${API_BASE_URL}/api/v1/speech/status`, { signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() as Promise<SpeechStatus> : { configured: false, reason: null })
    .catch(() => ({ configured: false, reason: null }));
  return status;
}

let onAir: Narrator | null = null;
const listeners = new Set<() => void>();
/** The owner currently speaking (or loading), for the commentary engine to wait behind. */
export const speaking = () => onAir && (onAir.state === 'playing' || onAir.state === 'loading' || onAir.state === 'paused') ? onAir.owner : null;
export const onHubChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export interface SpeakRequest { moment_id: string; audience: Audience; language: Language }
export type Outcome = { result: 'ended' | 'stopped' | 'stale' | 'blocked' | 'error'; caption: string | null; error?: string };

export class Narrator {
  private audio: HTMLAudioElement | null = null;
  private abort: AbortController | null = null;
  private url: string | null = null;
  private token = 0;
  private done: ((outcome: Outcome) => void) | null = null;
  volume = 0.9;
  /** Delivery speed (1 = normal); live commentary reads a little faster when the replay runs fast. */
  rate = 1;
  state: NarratorState = 'idle';
  error: string | null = null;
  constructor(readonly owner: Owner = 'evidence', private onChange: (state: NarratorState, error: string | null) => void = () => undefined) {}

  private set(state: NarratorState, error: string | null = null) { this.state = state; this.error = error; this.onChange(state, error); listeners.forEach(fn => fn()); }

  // One audio element per narrator, unlocked by prime() inside the viewer's click, so lines that start seconds later
  // (a cue going on air, the next commentary line) still play under strict autoplay rules (Safari, locked-down Chrome).
  private element: HTMLAudioElement | null = null;
  private el() { return this.element ??= new Audio(); }
  /** Call from the click that turns audio on. */
  prime() {
    const audio = this.el();
    if (this.state === 'playing') return;
    audio.src = SILENT;
    audio.play().catch(() => undefined);
  }

  /** "Listen + replay": the accepted text of one moment. */
  speak(request: SpeakRequest): Promise<Outcome> { return this.play('/api/v1/speech/moment', request); }

  /** Any server speech endpoint. Resolves when the line ends, is stopped or superseded, or fails. `wanted` is asked
   * again once the audio has arrived: a line the match has moved past is dropped rather than spoken late. */
  async play(path: string, body: unknown, onStart?: (caption: string | null) => void, wanted?: () => boolean): Promise<Outcome> {
    if (onAir && onAir !== this && RANK[onAir.owner] > RANK[this.owner] && speaking()) return { result: 'blocked', caption: null };
    if (onAir && onAir !== this) onAir.stop();
    this.stop();
    onAir = this;
    const token = ++this.token;
    const abort = this.abort = new AbortController();
    this.set('loading');
    const finished = new Promise<Outcome>(resolve => { this.done = resolve; });
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25000)]),
      });
      if (token !== this.token) return { result: 'stopped', caption: null };
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { detail?: { code?: string } } | null;
        console.error('[omnipitch] speech', response.status, detail);
        this.set('error', UNAVAILABLE);
        this.finish({ result: 'error', caption: null, error: detail?.detail?.code });
        return finished;
      }
      const caption = decodeURIComponent(response.headers.get('X-Caption') ?? '') || null;
      const blob = await response.blob();
      if (token !== this.token) return { result: 'stopped', caption };
      if (wanted && !wanted()) { this.set('idle'); this.finish({ result: 'stale', caption }); return finished; }
      this.url = URL.createObjectURL(blob);
      const audio = this.audio = this.el();
      audio.src = this.url;
      audio.volume = this.volume;
      audio.defaultPlaybackRate = audio.playbackRate = this.rate;  // loading a new src resets playbackRate to the default
      audio.preservesPitch = true;
      audio.onended = () => { if (token === this.token) { this.set('ended'); this.finish({ result: 'ended', caption }); } };
      this.lastCaption = caption;
      await audio.play();
      if (token === this.token) { this.set('playing'); onStart?.(caption); }
    } catch (error) {
      if (token !== this.token || (error instanceof DOMException && error.name === 'AbortError')) return { result: 'stopped', caption: null };
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      console.error('[omnipitch] speech', error);
      this.set('error', blocked ? 'autoplay' : UNAVAILABLE);
      this.finish({ result: blocked ? 'blocked' : 'error', caption: null, error: blocked ? 'autoplay' : undefined });
    }
    return finished;
  }
  lastCaption: string | null = null;

  private finish(outcome: Outcome) { const done = this.done; this.done = null; done?.(outcome); if (onAir === this) onAir = null; listeners.forEach(fn => fn()); }

  pause() { if (this.audio && this.state === 'playing') { this.audio.pause(); this.set('paused'); } }
  resume() { if (this.audio && this.state === 'paused') { void this.audio.play(); this.set('playing'); } }
  setVolume(value: number) { this.volume = value; if (this.audio) this.audio.volume = value; }

  stop() {
    this.token += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.audio) { this.audio.pause(); this.audio.onended = null; this.audio.removeAttribute('src'); this.audio.load(); this.audio = null; }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    if (this.state !== 'idle') this.set('idle');
    this.finish({ result: 'stopped', caption: null });
  }
}
