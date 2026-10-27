import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Mic, Pause, Play, RotateCcw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { useCommentary } from '../lib/useCommentary';
import type { Language } from '../lib/prefs';

const T = {
  en: { enable: 'Enable commentary', off: 'Turn commentary off', live: 'Commentary', pause: 'Pause', resume: 'Resume', skip: 'Skip', again: 'Say again',
    volume: 'Commentary volume', transcript: 'Transcript', tap: 'Tap to resume commentary', wait: 'Commentary is on. It starts with the next action.',
    unavailable: 'Commentary unavailable. Text updates continue.', recap: 'Recap', empty: 'Nothing said yet.', options: 'Commentary options',
    speaking: 'Speaking', paused: 'Paused', listening: 'Waiting for the next action' },
  es: { enable: 'Activar narración', off: 'Desactivar narración', live: 'Narración', pause: 'Pausa', resume: 'Seguir', skip: 'Saltar', again: 'Repetir',
    volume: 'Volumen de la narración', transcript: 'Transcripción', tap: 'Toca para seguir la narración', wait: 'Narración activada. Empieza con la próxima acción.',
    unavailable: 'Narración no disponible. Los textos siguen actualizándose.', recap: 'Resumen', empty: 'Aún no se ha dicho nada.', options: 'Opciones de narración',
    speaking: 'Narrando', paused: 'En pausa', listening: 'Esperando la próxima acción' },
};

/** Live commentary as one transport control: off, a "Commentary" button; on, the same button with a live dot that opens
 * a small menu (pause, skip, say again, volume, transcript, turn off). Each spoken line appears in full as a subtitle
 * on the pitch (CommentarySubtitle), so the control itself never has to show text. */
export function CommentaryBar({ c, language }: { c: ReturnType<typeof useCommentary>; language: Language }) {
  const t = T[language];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, [open]);
  useEffect(() => { if (!c.enabled) setOpen(false); }, [c.enabled]);
  if (!c.enabled) {
    return <div className="commentary">
      <button type="button" className="tool-button" aria-label={t.enable} onClick={() => c.enable(true)}><Mic size={15} aria-hidden="true" />{t.live}</button>
    </div>;
  }
  if (c.needsTap) {
    return <div className="commentary">
      <button type="button" className="tool-button" data-attention onClick={c.resumeAfterTap}><Volume2 size={15} aria-hidden="true" />{t.tap}</button>
    </div>;
  }
  const speakingNow = c.voice.state === 'playing' || c.voice.state === 'loading';
  const status = c.unavailable ? t.unavailable : c.paused ? t.paused : speakingNow ? t.speaking : c.caption ? t.listening : t.wait;
  return <div className="commentary" ref={box}>
    <button type="button" className="tool-button" aria-pressed="true" aria-expanded={open} aria-controls="commentary-menu" aria-label={`${t.options}: ${status}`}
      onClick={() => setOpen(value => !value)}>
      <span className="commentary-dot" data-on={speakingNow || undefined} data-paused={c.paused || undefined} aria-hidden="true" />{t.live}
      <ChevronDown size={14} aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
    </button>
    {open && <section className="commentary-menu" id="commentary-menu" aria-label={t.options}>
      <p className="commentary-status" aria-live="polite">{status}</p>
      <div className="commentary-controls">
        <button type="button" className="icon-button" onClick={c.paused ? c.resume : c.pause} aria-label={c.paused ? t.resume : t.pause} title={c.paused ? t.resume : t.pause}>
          {c.paused ? <Play size={15} /> : <Pause size={15} />}</button>
        <button type="button" className="icon-button" onClick={c.skip} aria-label={t.skip} title={t.skip}><SkipForward size={15} /></button>
        <button type="button" className="icon-button" onClick={c.replayLast} aria-label={t.again} title={t.again}><RotateCcw size={15} /></button>
        <label className="commentary-volume"><Volume2 size={15} aria-hidden="true" /><span className="sr-only">{t.volume}</span>
          <input type="range" min="0" max="1" step="0.05" value={c.volume} onChange={event => c.setVolume(Number(event.target.value))} /></label>
      </div>
      <h3>{t.transcript}</h3>
      <ol className="commentary-transcript" aria-label={t.transcript}>
        {c.transcript.length === 0 ? <li className="hint">{t.empty}</li>
          : [...c.transcript].reverse().slice(0, 30).map((line, i) => <li key={`${line.clock}-${i}`}><b>{line.kind === 'recap' ? t.recap : line.clock}</b><span>{line.text}</span></li>)}
      </ol>
      <button type="button" className="text-button commentary-off" onClick={() => c.enable(false)}><VolumeX size={15} aria-hidden="true" />{t.off}</button>
    </section>}
  </div>;
}

/** A subtitle stays a moment after its line ends, then fades, so an old line never sits over newer play. */
const LINGER_MS = 2500;

/** The line being spoken, in full, as a subtitle on the pitch (below it on phones). Keyed per line so each new line
 * fades in; it fades out shortly after the voice finishes (or, without audio, after the time it takes to read it).
 * Screen readers hear it once through the live region. */
export function CommentarySubtitle({ c, language }: { c: ReturnType<typeof useCommentary>; language: Language }) {
  const t = T[language];
  const caption = c.caption;
  const key = caption ? `${caption.clock}|${caption.text}` : '';
  const speaking = c.voice.state === 'playing' || c.voice.state === 'loading';
  const [faded, setFaded] = useState(false);
  useEffect(() => { setFaded(false); }, [key]);
  useEffect(() => {
    if (!key || speaking || c.paused) return;
    const delay = c.unavailable ? Math.min(6000, 1500 + key.length * 45) : LINGER_MS;
    const timer = setTimeout(() => setFaded(true), delay);
    return () => clearTimeout(timer);
  }, [key, speaking, c.paused, c.unavailable]);
  if (!c.enabled || !caption) return null;
  return <div className="commentary-subtitle" aria-live="polite" lang={language} data-faded={faded || undefined}>
    <p key={`${caption.clock}|${caption.text}`} data-kind={caption.kind}>
      <b>{caption.kind === 'recap' ? t.recap : caption.clock}</b><span>{caption.text}</span>
    </p>
  </div>;
}
