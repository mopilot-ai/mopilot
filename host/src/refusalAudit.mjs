// What the audit record keeps of the requests a kind of client was refused (`client.refused`, ./controllerRefusals.mjs): a few lines per client per minute and a count of the rest, so a client that is refused in a loop (or by a method name it makes up each time) cannot fill the audit folder. One line per method per minute with a counter; at most `MAX_LINES` different methods per client per minute; the rest are counted and told as one line at the start of the next minute.

/** How long one window of a client's refusals is. */
export const WINDOW_MS = 60_000;
/** The most different methods one client has its own line for in a window. */
export const MAX_LINES = 8;
/** The most clients whose windows are kept at once (the oldest is dropped: a client that comes back starts a new window). */
const MAX_CLIENTS = 64;
/** The method name a count of unlined refusals is told under. */
export const OTHERS = '(others)';

/**
 * @param {object} o
 * @param {(e: { kind: string, by: { fingerprint: string, name: string, kind: string }, what?: Record<string, string | number> }) => void} o.write one line of the audit record
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => { unref?: () => unknown }} [o.setTimer] a window that ends with no further refusal is settled by this timer (unref'd: it never holds the Host open)
 */
export function createRefusalAudit({ write, now = Date.now, setTimer = setTimeout }) {
  /** @type {Map<string, { at: number, lined: Set<string>, counts: Map<string, number>, others: number, by: { fingerprint: string, name: string, kind: string } }>} */
  const windows = new Map();
  /** The lines a finished window still owes: one per method that was refused more than once, and one for the methods that had no line. @param {NonNullable<ReturnType<typeof windows.get>>} w */
  const settle = (w) => {
    for (const [method, count] of w.counts) if (count > 0) write({ kind: 'client.refused', by: w.by, what: { tool: method, count } });
    if (w.others > 0) write({ kind: 'client.refused', by: w.by, what: { tool: OTHERS, count: w.others } });
  };
  return {
    /** @param {{ kind: string, by: { fingerprint: string, name: string, kind: string }, what?: Record<string, string | number> }} e */
    note(e) {
      const method = String(e.what?.tool ?? '').slice(0, 64);
      const who = e.by.fingerprint;
      let w = windows.get(who);
      if (w && now() - w.at >= WINDOW_MS) {
        settle(w);
        windows.delete(who);
        w = undefined;
      }
      if (!w) {
        if (windows.size >= MAX_CLIENTS) {
          const [oldest] = windows.keys();
          const gone = windows.get(oldest);
          if (gone) settle(gone);
          windows.delete(oldest);
        }
        const fresh = { at: now(), lined: new Set(), counts: new Map(), others: 0, by: e.by };
        w = fresh;
        windows.set(who, fresh);
        // a window that no refusal follows still tells its counts when it ends
        const timer = setTimer(() => {
          if (windows.get(who) !== fresh) return;
          settle(fresh);
          windows.delete(who);
        }, WINDOW_MS);
        timer.unref?.();
      }
      // the first refusal of a method in a window has its line; the same method again is counted under its name; a ninth different one is counted in one number, so what a window holds is bounded whatever names a client makes up
      if (w.lined.has(method)) return void w.counts.set(method, /** @type {number} */ (w.counts.get(method)) + 1);
      if (w.lined.size >= MAX_LINES) return void (w.others += 1);
      w.lined.add(method);
      w.counts.set(method, 0);
      write({ kind: 'client.refused', by: e.by, what: { tool: method } });
    },
  };
}
