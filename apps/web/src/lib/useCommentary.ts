import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './api';
import { Narrator, UNAVAILABLE, onHubChange, speaking, type NarratorState } from './narration';
import type { Audience, Language } from './prefs';
import type { RecapScope, ReplaySnapshot } from '../types/contracts';

/** Live spoken commentary. One "Enable commentary" turns it on; from then on it follows the match by itself:
 * - every snapshot, it asks the server for lines on what was revealed since its last position (play-by-play from
 *   events, context from moments), never for anything ahead of the replay;
 * - a short queue keeps the most important lines; routine lines that wait too long are dropped, and at high replay
 *   speeds only major lines are kept, so speech stays current and never piles up;
 * - when a half or the match actually ends during forward playback, the recap for that period is spoken once
 *   (remembered per run, period, audience and language, so reconnects and re-renders never repeat it);
 * - a seek back, a new run, or a language or audience change clears the queue and stops stale speech;
 * - "Listen + replay" outranks live commentary; live lines wait behind it.
 * Without speech, captions and the transcript continue and the panel says audio is unavailable. */
export interface Line { key: string; ref: string; kind: string; priority: number; sequence: number; period: number; clock: string; text: string; at: number }
export interface Spoken { clock: string; text: string; kind: string }

const MAX_QUEUE = 3, STALE_MS = 8000, MAJOR = 90;
const recapKey = (run: string, scope: RecapScope, audience: Audience, language: Language) => `omnipitch.recap.${run}.${scope}.${audience}.${language}`;
const seen = (key: string) => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } };
const remember = (key: string) => { try { sessionStorage.setItem(key, '1'); } catch { /* storage unavailable: at worst a repeat */ } };

export function useCommentary(replay: ReplaySnapshot | undefined, audience: Audience, language: Language, focusPlayer: string | null,
  onRecap: (scope: RecapScope) => void) {
  const [enabled, setEnabled] = useState(() => { try { return sessionStorage.getItem('omnipitch.commentary') === '1'; } catch { return false; } });
  const [caption, setCaption] = useState<Spoken | null>(null);
  const [transcript, setTranscript] = useState<Spoken[]>([]);
  const [voice, setVoice] = useState<{ state: NarratorState; note: string | null }>({ state: 'idle', note: null });
  const [paused, setPaused] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [volume, setVolumeState] = useState(.9);

  const narrator = useRef<Narrator>(undefined);
  narrator.current ??= new Narrator('live', (state, error) => setVoice({ state, note: error === 'autoplay' ? null : error }));
  const recapVoice = useRef<Narrator>(undefined);
  recapVoice.current ??= new Narrator('recap', (state, error) => setVoice({ state, note: error === 'autoplay' ? null : error }));
  const queue = useRef<Line[]>([]);
  const cursor = useRef<{ run: string; seq: number }>({ run: '', seq: 0 });
  const busy = useRef(false);
  const last = useRef<Line | null>(null);
  const live = useRef({ enabled, paused, audience, language, focusPlayer, replay });
  live.current = { enabled, paused, audience, language, focusPlayer, replay };

  const say = useCallback(async (line: Line, again = false) => {
    const { replay: current, audience: a, language: l } = live.current;
    if (!current) return;
    const isRecap = line.ref.startsWith('recap:');
    if (isRecap) onRecap(line.ref.slice(6) as RecapScope);
    const speaker = isRecap ? recapVoice.current! : narrator.current!;
    speaker.setVolume(volumeRef.current);
    // The caption and transcript appear as the voice starts (or at once, when there is no audio).
    const show = (text: string) => {
      const spoken = { clock: line.clock, text, kind: line.kind };
      setCaption(spoken);
      if (!again) setTranscript(previous => [...previous.slice(-79), spoken]);
    };
    const outcome = await speaker.play('/api/v1/commentary/audio', { run_id: current.state.run_id, ref: line.ref, audience: a, language: l },
      caption => show(caption ?? line.text));
    if (outcome.result === 'blocked' && outcome.error === 'autoplay') { setNeedsTap(true); queue.current.unshift(line); return; }
    if (outcome.result === 'error') {
      show(line.text);
      await new Promise(resolve => setTimeout(resolve, Math.min(4500, 1500 + line.text.length * 25)));  // text-only pacing
    }
    if (outcome.result === 'blocked') queue.current.unshift(line);  // behind "Listen + replay": try again after it
  }, [onRecap]);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (live.current.enabled && !live.current.paused && queue.current.length) {
        if (speaking() === 'evidence') break;  // the viewer's own replay comes first
        const now = performance.now();
        queue.current = queue.current.filter(line => line.priority >= MAJOR || now - line.at < STALE_MS);
        // At high speed the newest important line wins; older routine lines are already out of date.
        if ((live.current.replay?.replay.speed ?? 1) >= 20 && queue.current.length > 1) {
          const newest = queue.current.reduce((a, b) => b.sequence > a.sequence ? b : a);
          queue.current = queue.current.filter(line => line === newest || line.priority >= MAJOR);
        }
        const next = queue.current.shift();
        if (!next) break;
        last.current = next;
        await say(next);
        if (needsTapRef.current) break;
      }
    } finally { busy.current = false; }
  }, [say]);
  const needsTapRef = useRef(needsTap);
  needsTapRef.current = needsTap;
  useEffect(() => onHubChange(() => { if (!speaking() && queue.current.length) void pump(); }), [pump]);

  const enqueue = useCallback((lines: Line[], speed: number) => {
    // At 20x and above only major and shot-level lines; never more than a few waiting, most important first.
    const kept = lines.filter(line => speed < 20 || line.priority >= 55);
    const all = [...queue.current, ...kept];
    all.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    queue.current = all.slice(0, MAX_QUEUE).sort((a, b) => a.sequence - b.sequence || b.priority - a.priority);
  }, []);

  const reset = useCallback((seq: number, run: string) => {
    queue.current = [];
    cursor.current = { run, seq };
    narrator.current?.stop();
  }, []);

  // Follow the match: new lines since the last position; a seek back or a new run starts from where the replay is.
  useEffect(() => {
    if (!replay || !enabled) return;
    const { run_id: run, latest_event_sequence: seq, replay_status: status } = replay.state;
    const from = cursor.current;
    if (from.run !== run || seq < from.seq) { reset(seq, run); return; }
    if (seq === from.seq) return;
    cursor.current = { run, seq };
    const forward = status === 'playing' || seq - from.seq < 40;
    const query = new URLSearchParams({ run_id: run, after: String(from.seq), audience, lang: language, ...(focusPlayer ? { player_id: focusPlayer } : {}) });
    fetch(`${API_BASE_URL}/api/v1/commentary/lines?${query}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: { lines: Omit<Line, 'key' | 'at'>[]; stale: boolean }) => {
        if (body.stale || cursor.current.run !== run || !forward) return;
        const now = performance.now();
        const lines: Line[] = body.lines.map(line => ({ ...line, key: line.ref, at: now }));
        // A half or the match ended during forward playback: its recap follows the whistle, once.
        for (const end of lines.filter(line => line.kind === 'period_end')) {
          const scope: RecapScope = end.period === 2 ? 'full_time' : 'first_half';
          const key = recapKey(run, scope, audience, language);
          if (!seen(key)) { remember(key); lines.push({ ...end, key, ref: `recap:${scope}`, kind: 'recap', priority: 99, sequence: end.sequence + .5 }); }
        }
        enqueue(lines, replay.replay.speed);
        void pump();
      })
      .catch(error => console.error('[omnipitch] commentary', error));
  }, [replay?.state.latest_event_sequence, replay?.state.run_id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // A language or audience change makes queued and playing lines obsolete.
  useEffect(() => { queue.current = []; narrator.current?.stop(); }, [language, audience]);
  useEffect(() => () => { narrator.current?.stop(); recapVoice.current?.stop(); }, []);

  const enable = useCallback((on: boolean) => {
    setEnabled(on);
    try { sessionStorage.setItem('omnipitch.commentary', on ? '1' : '0'); } catch { /* per tab only */ }
    if (!on) { queue.current = []; narrator.current?.stop(); recapVoice.current?.stop(); setCaption(null); return; }
    setNeedsTap(false);
    narrator.current?.prime(); recapVoice.current?.prime();  // inside the click: unlock audio for later lines
    // Start from where the match is now; a fresh kick-off gets its opening line.
    const state = live.current.replay?.state;
    if (state) cursor.current = { run: state.run_id, seq: state.latest_event_sequence <= 1 ? 0 : state.latest_event_sequence };
  }, []);

  return {
    enabled, enable, caption, transcript, voice, paused, needsTap, volume,
    unavailable: voice.note === UNAVAILABLE,
    resumeAfterTap: () => { narrator.current?.prime(); recapVoice.current?.prime(); setNeedsTap(false); void pump(); },
    pause: () => { setPaused(true); narrator.current?.pause(); recapVoice.current?.pause(); },
    resume: () => { setPaused(false); narrator.current?.resume(); recapVoice.current?.resume(); setTimeout(() => void pump(), 0); },
    skip: () => { narrator.current?.stop(); recapVoice.current?.stop(); setTimeout(() => void pump(), 0); },
    replayLast: () => { if (last.current) void say(last.current, true); },
    setVolume: (value: number) => { setVolumeState(value); narrator.current?.setVolume(value); recapVoice.current?.setVolume(value); },
  };
}
