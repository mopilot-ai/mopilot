// What a dictation shows while it records, beside the mic: the microphone's level as a moving waveform, the time, and a
// cancel button. In its input, Enter stops and transcribes (the message isn't sent) and Esc throws the recording away.
import { useEffect, useRef, useState } from 'react';
import { X } from './icons';
import { Tooltip } from './Popover';
import { ignoring } from '../../lib/ignored';
import { visiblePoll } from '../../lib/visiblePoll';

const BARS = 12;
/** How long a recording may run (Dictation.tsx stops it there); the last seconds count down. */
export const DICTATION_MAX_MS = 120_000;
const COUNTDOWN_MS = 10_000;

/** m:ss of `ms`. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The level of each recent moment, newest last, from the stream's own audio; flat without an AudioContext (tests). */
function useLevels(stream: MediaStream) {
  // each bar keeps its moment's id as it moves left, so React moves it rather than redrawing the row
  const [levels, setLevels] = useState(() => Array.from({ length: BARS }, (_, id) => ({ id, level: 0 })));
  useEffect(() => {
    const Ctx = (window as Window & { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let frame = 0;
    let last = 0;
    let id = BARS;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      if (t - last < 80) return;
      last = t;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += v * v;
      // speech sits around 0.02–0.2 RMS: a square root spreads it over the bar's height
      const level = Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.6);
      const moment = { id: id++, level };
      setLevels((l) => [...l.slice(1), moment]);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      void ctx.close().catch(ignoring('close the dictation level meter'));
    };
  }, [stream]);
  return levels;
}

export function DictationMeter({
  stream,
  startedAt,
  caption = '',
  scope,
  onStop,
  onCancel,
}: {
  stream: MediaStream;
  /** Date.now() when recording began */
  startedAt: number;
  /** what this Mac's live recognition has heard so far (its last words are shown) */
  caption?: string;
  /** the input this dictation writes into: its Enter and Esc belong to the recording while it runs */
  scope: () => Element | null;
  onStop(): void;
  onCancel(): void;
}) {
  const levels = useLevels(stream);
  const [now, setNow] = useState(() => Date.now());
  const handlers = useRef({ onStop, onCancel, scope });
  handlers.current = { onStop, onCancel, scope };
  // the clock, on the shared timer: one recording runs at a time
  useEffect(() => visiblePoll('dictation-clock', 250, () => setNow(Date.now())), []);
  useEffect(() => {
    // first, before the editor sends on Enter or the pane closes on Esc
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape') || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      const here = handlers.current.scope();
      if (!here || !(e.target instanceof Node) || !here.contains(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Enter') handlers.current.onStop();
      else handlers.current.onCancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const elapsed = now - startedAt;
  const left = DICTATION_MAX_MS - elapsed;
  return (
    <span className="dictation-meter" role="status" aria-label="Recording">
      <span className="dictation-wave" aria-hidden>
        {levels.map((l) => (
          <i key={l.id} style={{ transform: `scaleY(${0.12 + l.level * 0.88})` }} />
        ))}
      </span>
      {caption && (
        <span className="dictation-caption" title={caption}>
          {caption.length > 48 ? `…${caption.slice(-47)}` : caption}
        </span>
      )}
      {/* the clock is read on screen only: a live region announcing every second would talk over the dictation */}
      <span className={`dictation-time ${left <= COUNTDOWN_MS ? 'ending' : ''}`} aria-hidden>
        {left <= COUNTDOWN_MS ? `${Math.ceil(Math.max(0, left) / 1000)}s left` : clock(elapsed)}
      </span>
      <Tooltip label="Discard recording" shortcut="Esc">
        <button type="button" className="composer-icon-btn dictation-cancel" aria-label="Discard recording" onClick={onCancel}>
          <X size={14} />
        </button>
      </Tooltip>
    </span>
  );
}
