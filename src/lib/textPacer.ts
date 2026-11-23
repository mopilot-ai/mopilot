// Presentation-only pacing. Received and persisted text remains authoritative.

/**
 * Claude Desktop's streaming text: it reveals about `stepChars` characters a step, spacing the steps so what has
 * arrived shows over about `targetLagMs`, which steady bursty deltas into an even flow. A backlog beyond what the
 * fastest steps show in that time is caught up within `catchUpMs`. A finished reply shows the rest in steps every
 * `minStepMs`, each large enough that all of it shows within about `finishMs`: no long tail, and no large jumps.
 * A reply that pauses for `quietMs` shows what the reveal held back for its Markdown (streamCut.ts), as if finished.
 */
export const PACE = Object.freeze({
  stepChars: 22,
  targetLagMs: 550,
  minStepMs: 25,
  maxStepMs: 150,
  catchUpMs: 75,
  finishMs: 600,
  quietMs: 1000,
});

/** How long after its step starts a word `offset` characters into the step starts to fade in. */
export function fadeDelayMs(offset: number): number {
  return Math.min(offset * 2.5, 150);
}

/** Where a step that wants to show `want` more characters after `from` may end (a safe Markdown cut). */
export type StepCut = (from: number, want: number) => number;

const wholeSteps: StepCut = (from, want) => from + want;

export class TextPacer {
  shown: number;
  target: number;
  /** When the last step ran, or null while there was nothing to show. */
  private last: number | null = null;
  private finishing = false;
  /** How much each finishing step shows: the backlog when the reply finished, spread over `finishMs`. */
  private finishWant: number | null = null;

  constructor(shown: number, target = shown) {
    this.shown = Math.min(shown, target);
    this.target = target;
  }

  push(length: number) {
    // a late correction after the reply finished is spread over its own finishMs
    if (length > this.target) this.finishWant = null;
    this.target = length;
    this.shown = Math.min(this.shown, length);
  }

  /** The reply finished: show the rest within about finishMs, in quick steps. */
  finish() {
    this.finishing = true;
  }

  /** Completion, a hidden window or reduced motion: everything received shows now. */
  flush(): number {
    this.last = null;
    this.finishing = false;
    this.finishWant = null;
    return (this.shown = this.target);
  }

  get done() {
    return this.shown >= this.target;
  }

  /**
   * Run a step at `now` (ms). Returns how many ms until the next step should run, or null when there is nothing to
   * show until more text arrives. `cut` decides where a step may end; a step it cannot end waits for more text.
   */
  step(now: number, cut: StepCut = wholeSteps): number | null {
    const backlog = this.target - this.shown;
    if (backlog <= 0) {
      this.last = null;
      return null;
    }
    // text after a pause waits one step: that wait is the lag that evens out the next burst
    if (this.last === null) this.last = now;
    let want: number = PACE.stepChars;
    if (this.finishing) {
      const elapsed = now - this.last;
      if (PACE.minStepMs - elapsed >= 1) return Math.ceil(PACE.minStepMs - elapsed);
      this.last = now;
      this.finishWant ??= Math.max(PACE.stepChars, Math.ceil(backlog / (PACE.finishMs / PACE.minStepMs)));
      want = this.finishWant;
    } else {
      const lag = PACE.targetLagMs * PACE.stepChars;
      const interval = Math.min(PACE.maxStepMs, Math.max(PACE.minStepMs, lag / backlog));
      const elapsed = now - this.last;
      // waits are whole ms: a float remainder below that (0.1 + 0.2) would run again at the same instant
      if (interval - elapsed >= 1) return Math.ceil(interval - elapsed);
      this.last = now;
      const excess = Math.max(0, backlog - lag / PACE.minStepMs);
      want += Math.ceil(excess * Math.min(1, elapsed / PACE.catchUpMs));
    }
    const end = Math.min(this.target, cut(this.shown, Math.min(want, backlog)));
    if (end <= this.shown) {
      // nothing safe to show yet: the next delta wakes the pacer
      this.last = null;
      return null;
    }
    this.shown = end;
    return PACE.minStepMs;
  }
}

/** An individual reply can finish before the rest of its turn. */
export function replyIsStreaming(turnRunning: boolean, itemEndedAt?: number): boolean {
  return turnRunning && itemEndedAt == null;
}

/** Made on first use, and absent where the engine has no Intl.Segmenter (the phone's Hermes): code points then. */
let segmenter: Intl.Segmenter | null | undefined;
const graphemes = (): Intl.Segmenter | null =>
  (segmenter ??= typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null);
/** Without a segmenter a step still never splits a surrogate pair: code point starts stand in for graphemes. */
function* codePoints(text: string) {
  let index = 0;
  for (const point of text) {
    yield { index };
    index += point.length;
  }
}
/** Grapheme boundaries of the replies streaming now, most recently used last. */
const segmented = new Map<string, { text: string; boundaries: number[] }>();
export const SEGMENT_CACHE_SIZE = 8;

function segmentFrom(text: string, start: number, into: number[]) {
  const rest = start ? text.slice(start) : text;
  for (const s of graphemes()?.segment(rest) ?? codePoints(rest)) into.push(start + s.index);
}

/**
 * Grapheme boundaries of `text`, cached per streaming item. A reply that grows only segments what
 * it appended: a cluster can extend across the old end (a combining mark, a ZWJ emoji, the second
 * half of a flag or a surrogate pair), so segmentation restarts at the second-to-last boundary,
 * which no later text can move. The array is the cache's own: read it before the next call.
 */
export function graphemeBoundaries(key: string, text: string): number[] {
  let entry = segmented.get(key);
  if (entry) segmented.delete(key);
  // the same string again (render and frame both ask) skips the prefix scan
  if (!entry || (text !== entry.text && !text.startsWith(entry.text))) {
    entry = { text, boundaries: [] };
    segmentFrom(text, 0, entry.boundaries);
  } else if (text.length !== entry.text.length) {
    const b = entry.boundaries;
    const restart = b.length >= 2 ? b[b.length - 2] : 0;
    b.length = Math.max(0, b.length - 2);
    segmentFrom(text, restart, b);
    entry.text = text;
  }
  segmented.set(key, entry);
  if (segmented.size > SEGMENT_CACHE_SIZE) segmented.delete(segmented.keys().next().value!);
  return entry.boundaries;
}

/**
 * Never split a surrogate pair, combining sequence, or emoji; no whitespace dependency. `key`
 * names the streaming item, so replies streaming at once keep their own boundaries.
 */
export function revealedPrefix(text: string, n: number, key = ''): string {
  if (n >= text.length) return text;
  if (n <= 0) return '';
  const boundaries = graphemeBoundaries(key, text);
  let lo = 0,
    hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boundaries[mid] <= n) lo = mid + 1;
    else hi = mid;
  }
  // boundaries[0] is 0 and n > 0, so lo >= 1
  return text.slice(0, boundaries[lo - 1]);
}
