// Each harness's session list as a paired phone's chats.recent reads it: the last good list at once, a refresh started behind it, and a deadline on the first read, so one slow or stuck harness (a busy disk, a stalled app server, an agent that never answers) never holds the phone's list.
const { noteIgnored, ignoring } = require('../ignored.cjs');

/** How long a list is served without asking again, how long a read that is still running is joined before it is let go, and how long a list that is out of date waits for its refresh. */
const FRESH_MS = 15_000;
const HUNG_MS = 60_000;
const WARM_WAIT_MS = 150;
/** How long the first read of a list (nothing kept yet) is waited for; the read goes on and the next list has it. */
const COLD_WAIT_MS = 1_500;

/**
 * @template {Record<string, (archived: boolean) => Promise<any[]>>} S
 * @param {S} sources each harness's own list (app/ipc/chatList.cjs chatSources)
 * @param {{ now?: () => number, freshMs?: number, hungMs?: number, warmMs?: number, coldMs?: number, warm?: boolean, changed?: () => void, generation?: () => number }} [o]
 * @returns {S}
 */
function createPhoneSources(sources, o = {}) {
  const now = o.now ?? Date.now;
  const generation = () => o.generation?.() ?? 0;
  const { freshMs = FRESH_MS, hungMs = HUNG_MS, warmMs = WARM_WAIT_MS, coldMs = COLD_WAIT_MS } = o;
  /** @type {Map<string, { list?: any[], at: number, error?: Error, running?: Promise<void>, since: number, generation: number, runningGeneration: number }>} */
  const kept = new Map();

  /** Waits for `p` at most `ms`: true when it ended first. @param {Promise<unknown>} p @param {number} ms */
  async function ended(p, ms) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const done = await Promise.race([p.then(() => true), late]);
    clearTimeout(timer);
    return done;
  }

  const tell = () => {
    try {
      o.changed?.();
    } catch (error) {
      // the list is served either way
      noteIgnored('tell paired phones their chat list changed', error);
    }
  };
  /** The sessions a list holds, in order: a read that finds the same ones changes nothing a phone shows. @param {any[]} list */
  const keysOf = (list) => list.map((c) => `${c.key}\u0000${c.title}\u0000${c.at}`).join('\u0001');

  /** Starts a read unless one is running (a hung one is let go), and keeps what it answers. */
  function refresh(/** @type {string} */ family, /** @type {boolean} */ archived) {
    const key = `${family}:${archived}`;
    const entry = kept.get(key) ?? { at: 0, since: 0, generation: -1, runningGeneration: -1 };
    const version = generation();
    kept.set(key, entry);
    if (entry.runningGeneration === version && entry.running && now() - entry.since < hungMs) return entry.running;
    entry.runningGeneration = version;
    entry.since = now();
    const run = Promise.resolve()
      .then(() => sources[family](archived))
      .then(
        (list) => {
          // a read that was let go and lands after a newer one began is not kept over it
          if (entry.running !== run || generation() !== version) return;
          const was = entry.list;
          entry.list = list;
          entry.generation = version;
          entry.at = now();
          entry.error = undefined;
          // a list that landed after its answer (the first read was too slow, or a refresh found more) is news to the phone's screen
          if (!was || keysOf(was) !== keysOf(list)) tell();
        },
        (error) => {
          if (entry.running !== run || generation() !== version) return;
          entry.error = error instanceof Error ? error : new Error(String(error));
        },
      )
      .finally(() => {
        if (entry.running === run) entry.running = undefined;
      });
    entry.running = run;
    return run;
  }

  const phone = /** @type {S} */ (
    Object.fromEntries(
      Object.keys(sources).map((family) => [
        family,
        async (/** @type {boolean} */ archived) => {
          const entry = kept.get(`${family}:${archived}`);
          if (entry?.list && entry.generation === generation() && now() - entry.at < freshMs) return entry.list;
          const run = refresh(family, archived);
          const got = kept.get(`${family}:${archived}`);
          // out of date: what is kept now, unless the refresh is quick; nothing kept yet: the read, up to a longer deadline
          await ended(run, got?.list ? warmMs : coldMs);
          if (got?.list) return got.list;
          throw got?.error ?? new Error(`${family} list timed out`);
        },
      ]),
    )
  );
  // read once now, so the first list a phone asks for after the app starts is not the first read
  if (o.warm) for (const family of Object.keys(sources)) phone[family](false).catch(ignoring(`warm the ${family} chat list`));
  return phone;
}

/**
 * Every harness's list, each an Error instead when it failed or is too slow: one harness failing leaves the others' chats.
 * @param {Record<string, (archived: boolean) => Promise<any[]>>} sources from createPhoneSources
 * @param {boolean} archived
 */
async function readAll(sources, archived) {
  const families = Object.keys(sources);
  // the lists only ever reject with an Error
  const lists = await Promise.all(families.map((f) => sources[f](archived).catch((/** @type {Error} */ e) => e)));
  return Object.fromEntries(families.map((f, i) => [f, lists[i]]));
}

module.exports = { createPhoneSources, readAll, FRESH_MS, HUNG_MS, WARM_WAIT_MS, COLD_WAIT_MS };
