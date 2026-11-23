// One shared, keyed scheduler for renderer polls: a ref-counted interval per key that parks while the window is hidden and wakes once, staggered, when it shows or focuses again.
const STAGGER_MS = 40;

interface Listener {
  run: () => void;
  wake: boolean;
  ms: number;
}
interface Entry {
  ms: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<Listener>;
  wakes: ReturnType<typeof setTimeout>[];
}

const entries = new Map<string, Entry>();
let attached = false;
let waking = false;

// store code also runs where no document exists (non-DOM tests, early boot): that counts as visible, with no page events
const hasPage = () => typeof document !== 'undefined';
const hidden = () => hasPage() && document.visibilityState === 'hidden';

function fire(listener: Listener) {
  try {
    listener.run();
  } catch (error) {
    console.error('A shared poll failed', error);
  }
}

function park(entry: Entry) {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = null;
}

function start(entry: Entry) {
  if (entry.timer || hidden() || !Number.isFinite(entry.ms)) return;
  entry.timer = setInterval(() => {
    if (hidden()) return park(entry);
    for (const listener of [...entry.listeners]) fire(listener);
  }, entry.ms);
}

/** Runs the listeners that asked to wake, a few ms apart so a long list does not all read in one frame. */
function wakeAll() {
  // a window that shows and takes focus in one tick wakes once
  if (waking) return;
  waking = true;
  queueMicrotask(() => (waking = false));
  for (const entry of entries.values()) {
    for (const t of entry.wakes) clearTimeout(t);
    entry.wakes = [];
    start(entry);
    const waiting = [...entry.listeners].filter((l) => l.wake);
    // spread over at most one interval: no clamp that lets a long list land at the same instant
    const step = Math.min(STAGGER_MS, entry.ms / waiting.length);
    let index = 0;
    for (const listener of waiting) {
      const delay = index++ * step;
      if (!delay) fire(listener);
      else entry.wakes.push(setTimeout(() => entry.listeners.has(listener) && fire(listener), delay));
    }
  }
}

function onVisibility() {
  if (hidden()) for (const entry of entries.values()) park(entry);
  else wakeAll();
}
function onFocus() {
  if (!hidden()) wakeAll();
}

/**
 * Call `run` every `ms` while the window is visible. Callers with the same key share one timer (the shortest `ms`
 * wins); the timer stops while the window is hidden and `run` is called again, staggered, when the window shows or
 * takes focus (`wake`, on by default). `ms` of Infinity runs it on that wake only. Returns the stop function.
 */
export function visiblePoll(key: string, ms: number, run: () => void, options: { wake?: boolean } = {}): () => void {
  const listener: Listener = { run, wake: options.wake ?? true, ms };
  let entry = entries.get(key);
  if (!entry) {
    entry = { ms, timer: null, listeners: new Set(), wakes: [] };
    entries.set(key, entry);
  } else if (ms < entry.ms) {
    park(entry);
    entry.ms = ms;
  }
  if (!attached && hasPage()) {
    attached = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
  }
  entry.listeners.add(listener);
  start(entry);
  const owner = entry;
  return () => {
    if (!owner.listeners.delete(listener)) return;
    if (owner.listeners.size) {
      // the interval is the shortest of those still here
      const ms = Math.min(...[...owner.listeners].map((l) => l.ms));
      if (ms !== owner.ms) {
        park(owner);
        owner.ms = ms;
        start(owner);
      }
      return;
    }
    park(owner);
    for (const t of owner.wakes) clearTimeout(t);
    entries.delete(key);
    if (!entries.size && attached) {
      attached = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    }
  };
}

/** The number of live keys, for tests. */
export const pollKeyCount = () => entries.size;
