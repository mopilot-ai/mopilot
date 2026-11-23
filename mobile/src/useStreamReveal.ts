// Paces a streaming reply the way Claude does: the desktop's pacer (src/lib/textPacer.ts) and Markdown-safe cuts (src/lib/streamCut.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { PACE, TextPacer, revealedPrefix } from '../../src/lib/textPacer';
import { revealCeiling, stepEnd } from '../../src/lib/streamCut';
import { catchingUp } from './catchUp';
import { liveSteps, type Step } from './presentation/wordFade';

/**
 * The part of `text` to show now. Text already there when the row mounts shows whole; what arrives after is shown in
 * even steps, each ending where its Markdown is complete, so bursts of deltas read as a steady flow and nothing shown
 * changes form when the rest arrives. A reply that stopped streaming drains what is left within PACE.finishMs.
 */
export function useStreamReveal(id: string, text: string, streaming: boolean): string {
  return useStreamRevealSteps(id, text, streaming).shown;
}

/** As useStreamReveal, and the steps that revealed the text (where each began, when it showed) for per-word fades. */
export function useStreamRevealSteps(id: string, text: string, streaming: boolean): { shown: string; steps: Step[] } {
  const pacer = useRef<TextPacer | null>(null);
  pacer.current ??= new TextPacer(text.length);
  const [shown, setShown] = useState(text.length);
  const target = useRef(text);
  target.current = text;
  const live = useRef(streaming);
  live.current = streaming;
  /** When text last arrived: a reply quiet for PACE.quietMs shows what it held back (its last word, an open link). */
  const arrivedAt = useRef(0);
  const wake = useRef<(() => void) | null>(null);
  const steps = useRef<Step[]>([]);

  const shownAt = useRef(text.length);
  const record = useCallback((to: number) => {
    const now = Date.now();
    steps.current = [...liveSteps(steps.current, now), { at: shownAt.current, time: now }];
    shownAt.current = to;
  }, []);

  useEffect(() => {
    const p = pacer.current!;
    // Corrections invalidate old reveal offsets; the retained prefix is already visible.
    if (text.length < p.target) steps.current = [];
    if (text.length > p.target) arrivedAt.current = Date.now();
    p.push(text.length);
    // back in front after being away: what arrived meanwhile shows now, unpaced and without the word fade
    if (catchingUp()) {
      steps.current = [];
      shownAt.current = p.flush();
    }
    // a reply that shrank puts the next step's start back with it
    shownAt.current = Math.min(shownAt.current, p.shown);
    setShown(p.shown);
    if (!streaming) p.finish();
    wake.current?.();
  }, [text, streaming]);

  useEffect(() => {
    const p = pacer.current!;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cut = (from: number, want: number) => {
      const t = target.current;
      const quiet = Date.now() - arrivedAt.current >= PACE.quietMs;
      return revealedPrefix(t, stepEnd(t, from, want, revealCeiling(t, !live.current || quiet)), id).length;
    };
    const run = () => {
      timer = null;
      const before = p.shown;
      const wait = p.step(Date.now(), cut);
      if (p.shown > before) {
        record(p.shown);
        setShown(p.shown);
      }
      if (wait !== null) timer = setTimeout(run, wait);
      // held back while the reply pauses: shown once the pause has lasted quietMs
      else if (p.shown < p.target) timer = setTimeout(run, Math.max(1, Math.ceil(arrivedAt.current + PACE.quietMs - Date.now())));
    };
    wake.current = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, 0);
    };
    return () => {
      wake.current = null;
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, record]);

  return { shown: shown >= text.length ? text : revealedPrefix(text, shown, id), steps: steps.current };
}
