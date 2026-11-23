// When a reply's prose is a native text view (#5369): not while a chat opens, not while it scrolls, and only for the runs near the screen. The React text is the same words at the same height, so a run that is not native yet looks and lays out the same; the native view only adds selecting in place, which a reader reaches for once the view is still. Opening 300 replies then costs what it did without selection, and a fling does not mount hundreds of text views.

/** The chat has been open this long with no scroll: its first screens are still. */
export const OPEN_SETTLE = 450;
/** The list has reported no scroll for this long: the reader has stopped (a flick follows another within less, and a fling keeps reporting until it ends). */
export const SCROLL_IDLE = 250;
/** A run becomes native when it is within this many screens above or below the window... */
export const NEAR_SCREENS = 0.5;
/** A long press on a shown native view that the view has not answered (a menu presented, words selected) this long after the finger lifted opens the app's sheet instead... */
export const MENU_GRACE = 250;
/** ...or this long after the press fired, with the finger still down (a view selects its word and shows its menu well within it). */
export const MENU_WAIT = 600;
/** ...and goes back to React text when it is further than this from it, so a long session does not collect native views. */
export const KEEP_SCREENS = 2;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/** Whether a run at `y` (window top) that is `height` tall is within `screens` screens of the window. */
export const isNear = (y: number, height: number, screen: number, screens = NEAR_SCREENS) =>
  y + height >= -screens * screen && y <= (1 + screens) * screen;

export function createNativeGate(timers: Timers = realTimers) {
  let lazy = false;
  let busy = false;
  let timer: unknown = null;
  // where the list's window stands in its content (from the scroll reports), and a way to reach the content's native node: the run asks where it is in the content (a layout fact) and subtracts this, since `measureInWindow` was seen to say a run is a whole screen lower than it is (#5369)
  let port: { top: number; height: number } | null = null;
  let content: (() => unknown) | null = null;
  // whether the touch in progress began on a native text view that is shown: a long press the native view answers is not answered a second time by the app's own sheet
  let underFinger = false;
  // one number per touch, so an answer or a wait belongs to the touch it began with; whether the finger is down; and the long press waiting to learn whether the view answers it
  let touchNo = 0;
  let answeredNo = -1;
  let down = false;
  let waiting: { no: number; open: () => void; timer: unknown } | null = null;
  const stopWaiting = () => {
    if (waiting) timers.clear(waiting.timer);
    waiting = null;
  };
  // only the timer of the press waiting can fire: a new wait or an answer to its own touch clears it, so the view did not answer
  const settle = () => {
    const w = waiting as NonNullable<typeof waiting>;
    waiting = null;
    w.open();
  };
  const idleListeners = new Set<() => void>();
  const quiet = (ms: number) => {
    busy = true;
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => {
      timer = null;
      busy = false;
      for (const listener of [...idleListeners]) listener();
    }, ms);
  };
  return {
    /** Mounting lazily is on in the app (set once at launch); off, every run is native at once, as before. */
    configure(on: boolean) {
      // the app says it on every render: the same answer changes nothing (it must not cancel a wait in progress)
      if (on === lazy) return;
      lazy = on;
      busy = false;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
    lazy: () => lazy,
    /** Whether runs may change between React text and a native view now. */
    idle: () => !lazy || !busy,
    /** A chat opened (or the view jumped to the newest): still for a moment before the first runs are drawn natively. */
    open() {
      // another chat's window says nothing about this one: until the list reports where it stands, a run asks the window itself
      port = null;
      if (lazy) quiet(OPEN_SETTLE);
    },
    /** The list reports its window: `top` the content offset, `height` the visible height. */
    view(top: number, height: number) {
      port = { top, height };
    },
    viewport: () => port,
    /** The list's content node, asked for when a run measures itself (`measureLayout` is relative to it); returns how to let go of it. */
    attach(node: () => unknown) {
      content = node;
      return () => {
        if (content === node) content = null;
      };
    },
    content: () => content?.() ?? null,
    /** The list scrolled or a finger began to drag it: nothing changes until it has been still for {@link SCROLL_IDLE}. A fling is reported all along, so it never has a gap; a streaming reply followed to the end keeps reporting too. */
    activity() {
      if (lazy) quiet(SCROLL_IDLE);
    },
    /** A touch began: `native` says a shown native view is under it. A reply clears this at every touch start (outer before inner), a run then sets it. */
    touch(native: boolean) {
      touchNo += 1;
      underFinger = native;
      down = true;
    },
    /** Whether the touch in progress began on a shown native view (its own menu answers a long press); otherwise the app's sheet does, so a long press never does nothing (#5369). */
    touchedNative: () => underFinger,
    /** The finger lifted or the touch was taken (a scroll): a long press still waiting for the view's answer has {@link MENU_GRACE} left. */
    release() {
      down = false;
      if (!waiting) return;
      timers.clear(waiting.timer);
      waiting.timer = timers.set(settle, MENU_GRACE);
    },
    /** The native view answered the touch in progress (it is presenting its menu, or selected words): the sheet stays shut. */
    answer() {
      answeredNo = touchNo;
      // an answer to a later touch says nothing of a press still waiting from an earlier one
      if (waiting?.no === touchNo) stopWaiting();
    },
    /** A long press fired on a touch a shown native view began on: `open` (the app's sheet) runs unless the view answers first, so a press the view does not answer (a blank stretch of it, a recogniser that failed) is never left with nothing. */
    awaitMenu(open: () => void) {
      const no = touchNo;
      if (answeredNo === no) return;
      stopWaiting();
      waiting = { no, open, timer: timers.set(settle, down ? MENU_WAIT : MENU_GRACE) };
    },
    /** `listener` runs each time the view becomes still. */
    onIdle(listener: () => void) {
      idleListeners.add(listener);
      return () => void idleListeners.delete(listener);
    },
  };
}
export const nativeGate = createNativeGate();
