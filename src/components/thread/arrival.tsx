// Arrival animations in a thread: which items arrived live, fading them in and smoothing streamed text.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { PACE, TextPacer, revealedPrefix } from '../../lib/textPacer';
import { noteReveal } from '../../session/perf';
import { revealCeiling, stepEnd } from '../../lib/streamCut';
import { useWindowVisible } from '../../lib/windowVisible';

// What arrived while the chat was on screen animates in; what was already there when it opened
// (history, a reload, expanding a finished turn) does not. The decision is made once per item and
// remembered, so an item that remounts (moving between the work list and the final answer) neither
// replays its entrance nor restarts its text.

/** Set once a chat's loaded turns have painted; items that mount after that are arrivals. */
export const ArrivalContext = createContext<{ ready: boolean; scope?: string; turn?: string }>({ ready: false });

const decided = new Map<string, boolean>();
const revealed = new Map<string, number>();

/** Whether item `id` arrived live (mounted after the chat painted, while its turn was running). */
export function useArrived(id: string, running: boolean): boolean {
  const ctx = useContext(ArrivalContext);
  const key = JSON.stringify([ctx.scope ?? '', ctx.turn ?? '', id]);
  const [arrived] = useState(() => {
    let d = decided.get(key);
    if (d === undefined) decided.set(key, (d = ctx.ready && running));
    return d;
  });
  return arrived;
}

/** A row that arrived fades in, like the official app; rows already there render as they are. */
export function Enter({ id, running, children }: { id: string; running: boolean; children: ReactNode }) {
  return useArrived(id, running) ? <div className="item-enter">{children}</div> : <>{children}</>;
}

/**
 * A block that rises into place when it appears live (Claude Desktop's reveal-in), and renders still when it was
 * already there: an error that ends the latest turn while the chat is open, not one in history.
 */
export function Reveal({ id, live, className, children }: { id: string; live: boolean; className: string; children: ReactNode }) {
  return <div className={useArrived(id, live) ? `${className} reveal-in` : className}>{children}</div>;
}

/** A paced reply: the part to show, whether its words fade, whether it is still revealing, and where each step began. */
export interface SmoothText {
  text: string;
  animate: boolean;
  /** Still revealing: streaming, or showing the rest of a finished reply in its last steps. */
  streaming: boolean;
  /** Where each reveal step started in `text`, ascending; the words of a step fade in one after another. */
  steps: readonly number[];
  /** When each step showed, on the document timeline (performance.now): its words fade in from then. */
  stepTimes: readonly number[];
}

const NO_STEPS: readonly number[] = [];

/**
 * Pace an arriving reply's text in steps (textPacer.ts), each ending where its Markdown is complete
 * (streamCut.ts), so nothing shown changes form or fades in again when the rest arrives. Text that was already on
 * screen is returned whole, without animation. A hidden window shows arriving text at once, and paces again from
 * there when it is shown; a visible window paces whether or not it has focus.
 */
export function useSmoothText(id: string, text: string, running: boolean, streaming = running): SmoothText {
  const arrived = useArrived(id, running);
  const ctx = useContext(ArrivalContext);
  const key = JSON.stringify([ctx.scope ?? '', ctx.turn ?? '', id]);
  const resumed = useRef(revealed.has(key));
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const visible = useWindowVisible();
  const paced = arrived && !reducedMotion && visible;
  const target = useRef(text);
  target.current = text;
  const live = useRef(streaming);
  live.current = streaming;
  /** When text last arrived: a reply quiet for PACE.quietMs shows what it holds back (its last word, an open link). */
  const arrivedAt = useRef(0);
  const pacer = useRef<TextPacer | null>(null);
  if (arrived && !pacer.current) pacer.current = new TextPacer(revealed.get(key) ?? 0);
  const [shown, setShown] = useState(() => (arrived ? (revealed.get(key) ?? 0) : text.length));
  const steps = useRef<number[]>([]);
  /** When each step showed, so its words fade in from then wherever they mount. */
  const stepTimes = useRef<number[]>([]);
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Deltas only update the target and wake the step timer. Reduced motion and a hidden window show everything at
  // once without waiting for a timer, keeping the saved prefix in sync so moving the reply or showing the window
  // again cannot hide it; what they show is one step, so it fades once.
  useEffect(() => {
    const p = pacer.current;
    if (!p) return;
    if (text.length > p.target) arrivedAt.current = performance.now();
    p.push(text.length);
    const kept = steps.current.filter((s) => s < p.shown).length;
    steps.current.length = kept;
    stepTimes.current.length = kept;
    if (!paced) {
      if (p.shown < p.target) {
        steps.current.push(p.shown);
        stepTimes.current.push(performance.now());
      }
      const n = p.flush();
      revealed.set(key, n);
      setShown(n);
      return;
    }
    if (!streaming) p.finish();
    wake.current?.();
  }, [key, text, streaming, paced]);

  useEffect(() => {
    if (!paced) return;
    const p = pacer.current!;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // a step ends where its Markdown is complete, on a whole grapheme
    const cut = (from: number, want: number) => {
      const t = target.current;
      const quiet = performance.now() - arrivedAt.current >= PACE.quietMs;
      return revealedPrefix(t, stepEnd(t, from, want, revealCeiling(t, !live.current || quiet)), key).length;
    };
    const run = () => {
      timer = null;
      const before = p.shown;
      const wait = p.step(performance.now(), cut);
      if (p.shown > before) {
        steps.current.push(before);
        stepTimes.current.push(performance.now());
        noteReveal(p.shown - before);
        revealed.set(key, p.shown);
        setShown(p.shown);
      }
      if (wait !== null) timer = setTimeout(run, wait);
      // held back while the reply pauses: show it once the pause has lasted quietMs
      else if (p.shown < p.target) timer = setTimeout(run, Math.max(1, Math.ceil(arrivedAt.current + PACE.quietMs - performance.now())));
    };
    // new text runs a step now: the pacer itself waits out the rest of the step's interval
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, 0);
    };
    wake.current = schedule;
    schedule();
    return () => {
      wake.current = null;
      if (timer !== null) clearTimeout(timer);
      // a finished reply that unmounts mid-drain (moving into the final answer) is whole wherever it mounts next
      if (!live.current) revealed.set(key, target.current.length);
    };
  }, [key, paced]);

  if (!arrived || reducedMotion) {
    revealed.set(key, text.length);
    return { text, animate: false, streaming, steps: NO_STEPS, stepTimes: NO_STEPS };
  }
  // Remounted text (e.g. work becoming the final answer) never replays its entrance. A hidden window keeps its fades,
  // so showing it again does not fade the whole reply in.
  const revealing = paced && shown < text.length;
  return {
    text: revealing ? revealedPrefix(text, shown, key) : text,
    animate: !resumed.current,
    streaming: streaming || revealing,
    steps: resumed.current ? NO_STEPS : steps.current.slice(),
    stepTimes: resumed.current ? NO_STEPS : stepTimes.current.slice(),
  };
}
