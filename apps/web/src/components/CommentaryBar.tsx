import { useState } from 'react';
import { ChevronDown, Mic, Pause, Play, RotateCcw, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { useCommentary } from '../lib/useCommentary';
import type { Language } from '../lib/prefs';

const T = {
  en: { enable: 'Enable commentary', off: 'Turn commentary off', live: 'Commentary', pause: 'Pause', resume: 'Resume', skip: 'Skip', again: 'Say again',
    volume: 'Commentary volume', transcript: 'Transcript', tap: 'Tap to resume commentary', wait: 'Commentary is on. It starts with the next action.',
    unavailable: 'Commentary unavailable. Text updates continue.', recap: 'Recap', empty: 'Nothing said yet.' },
  es: { enable: 'Activar narración', off: 'Desactivar narración', live: 'Narración', pause: 'Pausa', resume: 'Seguir', skip: 'Saltar', again: 'Repetir',
    volume: 'Volumen de la narración', transcript: 'Transcripción', tap: 'Toca para seguir la narración', wait: 'Narración activada. Empieza con la próxima acción.',
    unavailable: 'Narración no disponible. Los textos siguen actualizándose.', recap: 'Resumen', empty: 'Aún no se ha dicho nada.' },
};

/** Live commentary: one action turns it on; then captions, controls and a timestamped transcript follow the match. */
export function CommentaryBar({ c, language }: { c: ReturnType<typeof useCommentary>; language: Language }) {
  const t = T[language];
  const [open, setOpen] = useState(false);
  if (!c.enabled) {
    return <div className="commentary off">
      <button type="button" className="button" onClick={() => c.enable(true)}><Mic size={15} aria-hidden="true" />{t.enable}</button>
    </div>;
  }
  const speakingNow = c.voice.state === 'playing' || c.voice.state === 'loading';
  return <section className="commentary" aria-label={t.live}>
    <div className="commentary-row">
      <span className="commentary-dot" data-on={speakingNow || undefined} aria-hidden="true" />
      <p className="commentary-caption" aria-live="polite">
        {c.needsTap ? <button type="button" className="text-button inline" onClick={c.resumeAfterTap}>{t.tap}</button>
          : c.caption ? <><b>{c.caption.kind === 'recap' ? t.recap : c.caption.clock}</b> {c.caption.text}</> : t.wait}
      </p>
      <div className="commentary-controls">
        <button type="button" className="icon-button" onClick={c.paused ? c.resume : c.pause} aria-label={c.paused ? t.resume : t.pause}>
          {c.paused ? <Play size={15} /> : <Pause size={15} />}</button>
        <button type="button" className="icon-button" onClick={c.skip} aria-label={t.skip}><SkipForward size={15} /></button>
        <button type="button" className="icon-button" onClick={c.replayLast} aria-label={t.again}><RotateCcw size={15} /></button>
        <label className="commentary-volume"><Volume2 size={15} aria-hidden="true" /><span className="sr-only">{t.volume}</span>
          <input type="range" min="0" max="1" step="0.05" value={c.volume} onChange={event => c.setVolume(Number(event.target.value))} /></label>
        <button type="button" className="icon-button" aria-expanded={open} aria-controls="commentary-transcript" onClick={() => setOpen(v => !v)}
          aria-label={t.transcript}><ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button>
        <button type="button" className="icon-button" onClick={() => c.enable(false)} aria-label={t.off}><VolumeX size={15} /></button>
      </div>
    </div>
    {c.unavailable && <p className="commentary-note">{t.unavailable}</p>}
    {open && <ol className="commentary-transcript" id="commentary-transcript" aria-label={t.transcript}>
      {c.transcript.length === 0 ? <li className="hint">{t.empty}</li>
        : [...c.transcript].reverse().map((line, i) => <li key={`${line.clock}-${i}`}><b>{line.kind === 'recap' ? t.recap : line.clock}</b><span>{line.text}</span></li>)}
    </ol>}
  </section>;
}
