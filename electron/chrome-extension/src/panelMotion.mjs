// The side panel's step timeline motion and window: a new
// step enters, a step whose state changed (running, done, failed) fades its new line in, and the run still going shows its last
// three steps beside its summary. The stylesheet draws the motion (sidepanel.css, off under prefers-reduced-motion) from the
// marks set here; a mark clears when the animation is over (on a timer: under reduced motion none runs, and a mark left on
// would play when the preference changes), so moving the row into a fold later does not play it again.

/** How many of a running run's latest steps show while its fold is closed. */
export const WINDOW = 3;

/** How long each mark stays: its animation (430ms, .25s in sidepanel.css) and a little more. */
export const MOTION_MS = Object.freeze({ enter: 450, fade: 270 });

/** Marks a step row as one that just came (`enter`) or whose line just changed (`fade`). */
export function mark(
  /** @type {any} */ el,
  /** @type {'enter' | 'fade'} */ kind,
  /** @type {{ setTimeout: (f: () => void, ms: number) => any }} */ timers,
) {
  el.dataset.motion = kind;
  timers.setTimeout(() => {
    delete el.dataset.motion;
  }, MOTION_MS[kind]);
}

/**
 * Marks which steps of a run are older than its last WINDOW, and whether the run is the one at the end of the thread (the
 * only one a running turn shows a window of). The stylesheet hides the older steps of that run's closed fold while the chat's
 * turn runs; once it is idle nothing is hidden, whatever these marks say.
 */
export function windowed(/** @type {any} */ box, /** @type {any[]} */ els, /** @type {boolean} */ last) {
  if (last) box.dataset.last = '';
  else delete box.dataset.last;
  els.forEach((el, i) => {
    if (last && i < els.length - WINDOW) el.dataset.older = '';
    else delete el.dataset.older;
  });
}
