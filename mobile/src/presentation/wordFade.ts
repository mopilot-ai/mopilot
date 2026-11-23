// Per-word fade of streamed text on the phone: which words of a text node are still fading in, and how opaque each is.
import { fadeDelayMs } from '../../../src/lib/textPacer';

/** One reveal step: it started at source offset `at` and showed at `time` (ms, Date.now()). */
export type Step = { at: number; time: number };

/** A word fades in over 400 ms, linear: Claude Desktop's `delta-fade`. */
export const FADE_MS = 400;
const WORD = /(?:^\s+)?\S+\s*/g;

/** When the last word of the newest step is fully opaque: nothing needs a frame after this. */
export function fadeEnd(steps: readonly Step[]): number {
  const last = steps[steps.length - 1];
  return last ? last.time + fadeDelayMs(Infinity) + FADE_MS : 0;
}

/** Steps whose words are all opaque at `now` are dropped; the newest is always kept. */
export function liveSteps(steps: readonly Step[], now: number): Step[] {
  const cut = steps.findIndex((s) => now < s.time + fadeDelayMs(Infinity) + FADE_MS);
  return cut === -1 ? steps.slice(-1) : steps.slice(cut);
}

/** The first index of an ascending `map` whose offset is at or after `off`, or its length (a binary search: it runs every frame). */
const firstAtOrAfter = (map: readonly number[], off: number) => {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (map[mid] >= off) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

/**
 * Where each character of a text node's `value` sits in its markdown `source` (a quote's `> ` markers, a list's indent and
 * a backslash escape are in the source and not in the value): a character-by-character walk that skips what the value
 * lacks. Without a usable source, or when the walk cannot place every character, the offsets scale by the two lengths.
 */
function offsetMap(value: string, source: string, span: number) {
  const scaled = span > 0 && span !== value.length ? value.length / span : 1;
  const map: number[] = [];
  if (source.length === span && span !== value.length) {
    let at = 0;
    for (const ch of value) {
      at = source.indexOf(ch, at);
      if (at < 0) break;
      for (let k = 0; k < ch.length; k++) map.push(at + k);
      at += ch.length;
    }
  }
  const exact = map.length === value.length && map.length > 0;
  return {
    toSource: (i: number) => (exact ? map[Math.min(i, map.length - 1)] : Math.round(i / scaled)),
    // the first value index at or after a source offset
    toValue: (off: number) => (exact ? firstAtOrAfter(map, off) : Math.round(off * scaled)),
  };
}

/**
 * The pieces of a text node whose source spans [start, end): each word of a step fades from its step's moment, a few ms
 * after the word before it. Adjacent opaque words join, so settled text is one piece. Text before the first live step
 * is opaque.
 */
export function splitFades(
  value: string,
  start: number,
  end: number,
  steps: readonly Step[],
  now: number,
  source = '',
): { text: string; alpha: number }[] {
  const { toSource, toValue } = offsetMap(value, source, end - start);
  const out: { text: string; alpha: number }[] = [];
  const push = (text: string, alpha: number) => {
    const prev = out[out.length - 1];
    if (prev && prev.alpha === alpha && alpha === 1) prev.text += text;
    else out.push({ text, alpha });
  };
  if (!steps.length || now >= fadeEnd(steps) || end <= steps[0].at) return [{ text: value, alpha: 1 }];
  // where each step starts in the value: the same for every word, so found once per call
  const stepCuts = steps.map((s) => toValue(s.at - start));
  for (const m of value.matchAll(WORD)) {
    const limit = m.index + m[0].length;
    let from = m.index;
    // CJK and long words can cross reveal steps without whitespace. Split at those
    // boundaries too, so their existing prefix never hides the new suffix's fade.
    const cuts = stepCuts.filter((at) => at > from && at < limit);
    for (const to of [...cuts, limit]) {
      const at = start + toSource(from);
      let step = -1;
      for (let i = 0; i < steps.length && steps[i].at <= at; i++) step = i;
      if (step === -1) push(value.slice(from, to), 1);
      else {
        const age = now - (steps[step].time + fadeDelayMs(at - steps[step].at));
        push(value.slice(from, to), Math.max(0, Math.min(1, age / FADE_MS)));
      }
      from = to;
    }
  }
  return out;
}

/** `color` (#rrggbb) at `alpha`; any other format is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (alpha >= 1 || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const n = parseInt(color.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}
