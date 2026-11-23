// Prewarming a new chat's harness while its composer is open (#1664, latency #3 of #1651): one entry per composer, the
// family's hook warming what the first send would start anyway, the take by that send, and the entry's disposal when
// the composer goes, sits idle, its window closes or the app quits. Shared code reads only the hook table.
const { clock } = require('../../platform/ports/clock.cjs');
const { byFamily } = require('./route.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** An entry the composer stopped asking for (no hint this long) is disposed; a shown composer hints every minute. */
const IDLE_MS = 3 * 60_000;
/** A warm that failed is tried again for the same key only after this long, not on every heartbeat. */
const RETRY_MS = 60_000;

/**
 * One family's prewarm. Every function runs in main, from what the send will use there.
 * @typedef {object} PrewarmHook
 * @property {(spec: any) => string | null} key what the warm depends on, as the send would compute it now (null: nothing to warm)
 * @property {(spec: any) => Promise<any>} warm starts it; resolves the handle
 * @property {(handle: any) => unknown} dispose lets an unused handle go
 * @property {(handle: any) => boolean} [valid] whether a ready handle can still serve the send (a process that is still running)
 * @property {(handle: any) => any} [claim] the send takes it: what the take answers (absent: the take answers null)
 */

/**
 * @param {object} o
 * @param {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, PrewarmHook | null>} o.hooks one per family; null: that
 *   family warms nothing
 * @param {() => boolean} [o.enabled] the kill switch (shared.prewarm)
 * @param {number} [o.idleMs]
 * @param {number} [o.retryMs]
 * @param {() => number} [o.now]
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [o.timers]
 */
function createPrewarm(o) {
  const hooks = o.hooks;
  const enabled = o.enabled ?? (() => true);
  const idleMs = o.idleMs ?? IDLE_MS;
  const retryMs = o.retryMs ?? RETRY_MS;
  const now = o.now ?? (() => clock.now());
  const timers = o.timers ?? { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  /** slot (a composer: its window) -> its entry */
  const slots = new Map();

  /**
   * The hook and the entry id for a spec now, or null when there is nothing to warm.
   * @returns {{ hook: PrewarmHook, id: string } | null}
   */
  function identify(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') return null;
    try {
      const hook = byFamily(hooks, spec.kind);
      const key = hook ? hook.key(spec) : null;
      return hook && key != null ? { hook, id: JSON.stringify([spec.kind, key]) } : null;
    } catch (error) {
      noteIgnored("read what a new chat's prewarm depends on", error);
      return null;
    }
  }

  function letGo(entry) {
    timers.clearTimeout(entry.timer);
    entry.disposed = true;
    if (entry.handle == null) return;
    const handle = entry.handle;
    entry.handle = null;
    try {
      Promise.resolve(entry.hook.dispose(handle)).catch((error) => noteIgnored("let go of a new chat's prewarm", error));
    } catch (error) {
      noteIgnored("let go of a new chat's prewarm", error);
    }
  }

  function arm(slot, entry) {
    timers.clearTimeout(entry.timer);
    entry.timer = timers.setTimeout(() => slots.get(slot) === entry && release(slot), idleMs);
    entry.timer?.unref?.();
  }

  /** The same key again keeps an entry still warming or still able to serve; a failed one only until RETRY_MS has passed. */
  function keeps(entry) {
    if (entry.failedAt !== null) return now() - entry.failedAt < retryMs;
    // a ready handle whose process went away meanwhile is warmed again
    return entry.handle == null || !entry.hook.valid || entry.hook.valid(entry.handle);
  }

  /** The composer in `slot` would start `spec` on its first send (null: it would start nothing, or it went away). */
  function hint(slot, spec) {
    const it = enabled() ? identify(spec) : null;
    if (!it) return release(slot);
    const cur = slots.get(slot);
    if (cur && cur.id === it.id && keeps(cur)) return arm(slot, cur);
    release(slot);
    /** @type {{ id: string, hook: PrewarmHook, handle: any, disposed: boolean, failedAt: number | null, timer: any, ready: Promise<any> | null }} */
    const entry = { id: it.id, hook: it.hook, handle: null, disposed: false, failedAt: null, timer: null, ready: null };
    entry.ready = Promise.resolve()
      .then(() => it.hook.warm(spec))
      .then(
        (handle) => {
          entry.handle = handle ?? null;
          // replaced, released or timed out while it warmed: it goes now
          if (entry.disposed) letGo(entry);
          return entry.handle;
        },
        (error) => {
          entry.failedAt = now();
          noteIgnored("prewarm a new chat's harness", error);
          return null;
        },
      );
    slots.set(slot, entry);
    arm(slot, entry);
  }

  /**
   * The first send of the composer in `slot` takes its entry when it is what `spec` needs now; the answer is the
   * hook's claim, or null (nothing warm, still warming and then failed, or no longer matching: the send starts cold).
   */
  async function take(slot, spec) {
    const entry = slots.get(slot);
    if (!entry) return null;
    slots.delete(slot);
    timers.clearTimeout(entry.timer);
    // what the send needs changed since it warmed: it can't serve it
    if (identify(spec)?.id !== entry.id) {
      letGo(entry);
      return null;
    }
    const handle = await entry.ready;
    if (handle == null) return null;
    const hook = entry.hook;
    if (hook.valid && !hook.valid(handle)) {
      letGo(entry);
      return null;
    }
    entry.handle = null;
    return hook.claim ? hook.claim(handle) : null;
  }

  function release(slot) {
    const entry = slots.get(slot);
    if (!entry) return;
    slots.delete(slot);
    letGo(entry);
  }

  function releaseAll() {
    for (const slot of [...slots.keys()]) release(slot);
  }

  return { hint, take, release, releaseAll, size: () => slots.size };
}

module.exports = { createPrewarm, IDLE_MS, RETRY_MS };
