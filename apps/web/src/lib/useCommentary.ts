import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { Narrator, UNAVAILABLE, onHubChange, speaking, type NarratorState } from './narration';
import type { Audience, Language } from './prefs';
import type { RecapScope, ReplaySnapshot } from '../types/contracts';

/** Live spoken commentary. One "Enable commentary" turns it on; from then on it follows the match by itself:
 * - every snapshot, it asks the server for lines on what was revealed since its last position (play-by-play from
 *   events, context from moments), never for anything ahead of the replay;
 * - it keeps pace with the match, judged in match time against the replay clock (so it scales with replay speed):
 *   a line the match has moved past is dropped before it is fetched, and again once its audio arrives, instead of
 *   being spoken late; a goal or a whistle interrupts a routine line; at higher speeds moment lines are cut to their
 *   headline, only major lines are kept, and the voice reads a little faster;
 * - at high speeds, routine lines (a foul, a long ball, a pass into the box, a long move) are not queued; the newest
 *   one is held in reserve and said as soon as the voice is free and it is still fresh, so there are no long silences;
 * - when a half or the match actually ends during forward playback, the recap for that period is spoken once
 *   (remembered per run, period, audience and language, so reconnects and re-renders never repeat it);
 * - a seek back, a new run, or a language or audience change clears the queue and stops stale speech;
 * - "Listen + replay" outranks live commentary; live lines wait behind it.
 * Without speech, captions and the transcript continue and the panel says audio is unavailable. */
export interface Line { key: string; ref: string; kind: string; priority: number; sequence: number; period: number; match_time_ms: number; clock: string; text: string }
export interface Spoken { clock: string; text: string; kind: string }

const MAX_QUEUE = 3, MAJOR = 90, SHOT_LEVEL = 55, HALF_MS = 45 * 60_000;

/** How far, in match time, the replay has moved past a line. Match time restarts at 0 each half. */
export function lagMs(line: Pick<Line, 'period' | 'match_time_ms'>, clock: { clock_period: number; clock_ms: number }) {
  if (clock.clock_period === line.period) return Math.max(0, clock.clock_ms - line.match_time_ms);
  return clock.clock_period > line.period ? clock.clock_ms + Math.max(0, HALF_MS - line.match_time_ms) : 0;
}
/** The most match time a line may fall behind and still be worth saying: a fixed match-time allowance, or a few
 * seconds of real time at high speed (enough to synthesize and start the line, no more). A goal or a whistle may
 * trail a little more than routine lines. */
export function budgetMs(line: Pick<Line, 'priority' | 'ref'>, speed: number) {
  if (line.ref.startsWith('recap:')) return Math.max(180_000, speed * 12_000);
  if (line.priority >= MAJOR) return Math.max(60_000, speed * 5_000);
  return Math.max(20_000, speed * 3_000);
}
/** Delivery speed for the replay speed: normal up to 2x, then slightly brisker. */
export const voiceRate = (speed: number) => speed <= 2 ? 1 : speed < 10 ? 1.1 : 1.2;
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
  // Stable line identities said in this pass through the match: a line is never spoken twice, whatever polls,
  // reconnects or re-renders deliver it again. A seek back or a new run starts a new pass.
  const said = useRef(new Set<string>());
  const lastStatus = useRef<string | null>(null);
  const busy = useRef(false);
  const last = useRef<Line | null>(null);
  const reserve = useRef<Line | null>(null);  // the newest routine line, said when nothing more important is waiting
  const live = useRef({ enabled, paused, audience, language, focusPlayer, replay });
  live.current = { enabled, paused, audience, language, focusPlayer, replay };
  const fresh = useCallback((line: Line) => {
    const info = live.current.replay?.replay;
    if (!info) return false;
    if (live.current.replay?.state.replay_status === 'finished' && line.ref === 'recap:full_time') return true;
    return lagMs(line, info) <= budgetMs(line, info.speed);
  }, []);

  const say = useCallback(async (line: Line, again = false) => {
    const { replay: current, audience: a, language: l } = live.current;
    if (!current) return;
    const isRecap = line.ref.startsWith('recap:');
    if (isRecap) onRecap(line.ref.slice(6) as RecapScope);
    const speaker = isRecap ? recapVoice.current! : narrator.current!;
    speaker.setVolume(volumeRef.current);
    const speed = current.replay.speed;
    speaker.rate = isRecap ? 1 : voiceRate(speed);
    // The caption and transcript appear as the voice starts (or at once, when there is no audio).
    const show = (text: string) => {
      if (!again) said.current.add(line.key);
      const spoken = { clock: line.clock, text, kind: line.kind };
      setCaption(spoken);
      if (!again) setTranscript(previous => [...previous.slice(-79), spoken]);
    };
    const outcome = await speaker.play('/api/v1/commentary/audio',
      { run_id: current.state.run_id, ref: line.ref, audience: a, language: l, brief: speed >= 5 },
      caption => show(caption ?? line.text), again ? undefined : () => fresh(line) && live.current.enabled);
    if (outcome.result === 'blocked' && outcome.error === 'autoplay') { setNeedsTap(true); queue.current.unshift(line); return; }
    if (outcome.result === 'error') {
      show(line.text);
      await new Promise(resolve => setTimeout(resolve, Math.min(4500, 1500 + line.text.length * 25)));  // text-only pacing
    }
    if (outcome.result === 'blocked') queue.current.unshift(line);  // behind "Listen + replay": try again after it
  }, [onRecap, fresh]);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (live.current.enabled && !live.current.paused) {
        if (speaking() === 'evidence') break;  // the viewer's own replay comes first
        const spare = reserve.current;
        if (!queue.current.length && spare && fresh(spare) && spare.sequence > (last.current?.sequence ?? -1)) queue.current.push(spare);
        reserve.current = null;
        if (!queue.current.length) break;
        queue.current = queue.current.filter(fresh);
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
  }, [say, fresh]);
  const needsTapRef = useRef(needsTap);
  needsTapRef.current = needsTap;
  useEffect(() => onHubChange(() => { if (!speaking() && (queue.current.length || reserve.current)) void pump(); }), [pump]);

  const enqueue = useCallback((lines: Line[], speed: number) => {
    // At 20x and above only major and shot-level lines are queued; never more than a few waiting, most important first.
    // From 5x a moment line right behind a goal or whistle repeats it, so only the event line is kept.
    const majors = lines.filter(line => line.ref.startsWith('event:') && line.priority >= MAJOR);
    const kept = lines.filter(line => (speed < 20 || line.priority >= SHOT_LEVEL) && fresh(line)
      && !(speed >= 5 && line.ref.startsWith('moment:') && majors.some(m => Math.abs(m.sequence - line.sequence) <= 3)));
    // Routine lines left out at high speed: the newest fresh one waits in reserve for a quiet moment.
    const routine = lines.filter(line => !kept.includes(line) && line.priority < SHOT_LEVEL && fresh(line));
    if (routine.length) {
      const best = routine.reduce((a, b) => b.sequence > a.sequence || (b.sequence === a.sequence && b.priority > a.priority) ? b : a);
      if (!reserve.current || best.sequence > reserve.current.sequence) reserve.current = best;
    }
    const current = last.current;
    if (speaking() === 'live' && current && current.priority < MAJOR && kept.some(line => line.priority >= MAJOR)) narrator.current?.stop();
    const all = [...queue.current.filter(fresh), ...kept];
    all.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    queue.current = all.slice(0, MAX_QUEUE).sort((a, b) => a.sequence - b.sequence || b.priority - a.priority);
  }, [fresh]);

  const reset = useCallback((seq: number, run: string) => {
    queue.current = [];
    reserve.current = null;
    said.current = new Set();
    cursor.current = { run, seq };
    narrator.current?.stop();
    recapVoice.current?.stop();
  }, []);

  // Follow the match: new lines since the last position; a seek back or a new run starts from where the replay is.
  useEffect(() => {
    if (!replay || !enabled) return;
    const { run_id: run, latest_event_sequence: seq, replay_status: status } = replay.state;
    const before = lastStatus.current;
    lastStatus.current = status;
    const from = cursor.current;
    if (from.run !== run || seq < from.seq) { reset(seq, run); return; }
    if (seq === from.seq) return;
    cursor.current = { run, seq };
    // Playing forward (including the poll that reaches the final whistle at speed) is followed; a jump while paused
    // (a seek ahead) is not narrated after the fact.
    const forward = status === 'playing' || (status === 'finished' && before === 'playing') || seq - from.seq < 40;
    if (!forward) { queue.current = []; reserve.current = null; narrator.current?.stop(); }
    const query = new URLSearchParams({ run_id: run, after: String(from.seq), audience, lang: language, brief: String(replay.replay.speed >= 5),
      ...(focusPlayer ? { player_id: focusPlayer } : {}) });
    apiFetch(`/api/v1/commentary/lines?${query}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: { lines: Omit<Line, 'key'>[]; stale: boolean }) => {
        if (body.stale || cursor.current.run !== run || !forward) return;
        let lines: Line[] = body.lines.map(line => ({ ...line, key: line.ref }))
          .filter(line => !said.current.has(line.key) && !queue.current.some(queued => queued.key === line.key));
        // A half or the match ended during forward playback: its recap follows the whistle, once per viewer session.
        // The recap opens with the score, so the separate whistle line is dropped rather than announced twice.
        for (const end of lines.filter(line => line.kind === 'period_end')) {
          const scope: RecapScope = end.period === 2 ? 'full_time' : 'first_half';
          const key = recapKey(run, scope, audience, language);
          if (!seen(key)) {
            remember(key);
            lines = lines.filter(line => line !== end);
            lines.push({ ...end, key, ref: `recap:${scope}`, kind: 'recap', priority: 99, sequence: end.sequence + .5 });
          }
        }
        enqueue(lines, replay.replay.speed);
        void pump();
      })
      .catch(error => console.error('[omnipitch] commentary', error));
  }, [replay?.state.latest_event_sequence, replay?.state.run_id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // A language or audience change makes queued and playing lines obsolete.
  useEffect(() => { queue.current = []; reserve.current = null; narrator.current?.stop(); }, [language, audience]);
  useEffect(() => () => { narrator.current?.stop(); recapVoice.current?.stop(); }, []);

  const enable = useCallback((on: boolean) => {
    setEnabled(on);
    try { sessionStorage.setItem('omnipitch.commentary', on ? '1' : '0'); } catch { /* per tab only */ }
    if (!on) { queue.current = []; reserve.current = null; narrator.current?.stop(); recapVoice.current?.stop(); setCaption(null); return; }
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
