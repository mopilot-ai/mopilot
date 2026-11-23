// MoMo's motion tokens (MoMo's design §6), one table for both clients: the Mac's CSS mirrors it (src/components/momo/shell/momoShell.module.css, held in step by tests/momoMotion.test.ts) and the phone's shell takes its durations and curves from it. Panels open in one frame on the Mac, so these time what does move: a reply arriving, a tab changing.

/** Durations in ms: hover, press, small moves, panels, page. */
export const MOMO_DUR = Object.freeze({ xs: 60, s: 120, m: 200, l: 300, xl: 450 });

/** The thread's own timings in ms, from the design (04b): the list rising after a send, the typing-dots row expanding, a short reply's bubble arriving. */
export const MOMO_THREAD = Object.freeze({ rise: 175, dots: 140, arrive: 210 });

/** Cubic Bézier control points [x1, y1, x2, y2]: arriving, panels and moves between resting places, a tick landing or a chip press (the one curve that passes its end; only desktop CSS uses it). */
export const MOMO_EASE = Object.freeze({
  out: Object.freeze([0.165, 0.84, 0.44, 1]),
  snap: Object.freeze([0.32, 0.72, 0, 1]),
  overshoot: Object.freeze([0.34, 1.3, 0.64, 1]),
});

/** A curve as CSS says it: `cubic-bezier(.165, .84, .44, 1)`. */
export const cssCurve = (/** @type {keyof typeof MOMO_EASE} */ name) => `cubic-bezier(${MOMO_EASE[name].join(', ')})`;

/** Every token as the custom properties the Mac's shell declares (`--momo-dur-m: 200ms`, `--momo-ease-out: cubic-bezier(...)`). */
export function momoMotionVars() {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const [name, ms] of Object.entries(MOMO_DUR)) vars[`--momo-dur-${name}`] = `${ms}ms`;
  for (const [name, ms] of Object.entries(MOMO_THREAD)) vars[`--momo-thread-${name}`] = `${ms}ms`;
  for (const name of /** @type {(keyof typeof MOMO_EASE)[]} */ (Object.keys(MOMO_EASE))) vars[`--momo-ease-${name}`] = cssCurve(name);
  return vars;
}
