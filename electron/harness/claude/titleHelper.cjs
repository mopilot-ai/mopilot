// A warm, lean Claude Code CLI per login that writes new chats' titles at send (#3413): no settings, MCP servers or tools,
// so it is up in about half a second and never waits behind a chat's own CLI start; it ends after a few idle minutes.
// A MoMo chat's title is never written here: queries.cjs title answers null for an isolated chat before asking it.
const { clock } = require('../../platform/ports/clock.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How long a helper no chat asked for a title stays up. */
const IDLE_MS = 5 * 60_000;

/**
 * @param {object} o
 * @param {() => Promise<{ query: (args: { prompt: AsyncIterable<unknown>, options: object }) => any }>} o.sdk
 * @param {(account: string | undefined, binOverride: string | undefined) => Promise<object | null>} o.options the lean
 *   CLI's query options for a login (null when no CLI is installed)
 * @param {() => string} [o.sig] what only a new CLI changes (its billing): a change starts a helper of its own
 * @param {number} [o.idleMs]
 */
function createTitleHelper({ sdk, options, sig = () => '', idleMs = IDLE_MS }) {
  /**
   * login and binary → its helper; the query is a promise, so a title asked for while the helper starts waits for it
   * @type {Map<string, { q: Promise<any>, end: () => void, timer: any }>}
   */
  const helpers = new Map();

  function drop(key, h) {
    if (helpers.get(key) !== h) return;
    helpers.delete(key);
    clock.clearTimeout(h.timer);
    // its prompt ends, so the CLI exits on its own
    h.end();
  }

  /** The login's helper, started on first use; each use restarts its idle clock. */
  function helperFor(account, binOverride) {
    const key = JSON.stringify([account ?? null, binOverride ?? null, sig()]);
    let h = helpers.get(key);
    if (!h) {
      /** @type {{ promise: Promise<void>, resolve: () => void }} */
      const { promise: ended, resolve: end } = /** @type {any} */ (Promise).withResolvers();
      // a prompt that never sends a message: the helper only answers title requests on its control channel
      const prompt = (async function* () {
        await ended;
      })();
      const entry = { q: /** @type {Promise<any>} */ (Promise.resolve(null)), end, timer: null };
      entry.q = Promise.all([sdk(), options(account, binOverride)]).then(([{ query }, opts]) => {
        if (!opts) return null;
        const q = query({ prompt, options: opts });
        // its output is read to its end, so the helper is let go when its CLI exits
        (async () => {
          for await (const _ of q);
        })()
          .catch((error) => noteIgnored('run the Claude Code title helper', error))
          .finally(() => drop(key, entry));
        return q;
      });
      entry.q.catch(() => drop(key, entry));
      helpers.set(key, (h = entry));
    }
    clock.clearTimeout(h.timer);
    const held = h;
    h.timer = clock.setTimeout(() => drop(key, held), idleMs);
    h.timer.unref?.();
    return { key, h };
  }

  return {
    /** Start the login's helper ahead of a new chat's first message (a composer opened, harness/claude/warm.cjs). */
    warm(account, binOverride) {
      helperFor(account, binOverride).h.q.catch((error) => noteIgnored('start the Claude Code title helper', error));
    },
    /**
     * The CLI's own title for `text` (its side query on the small model), or null when no CLI is installed or this one
     * is too old to write titles. Rejects when the request fails; the CLI stays up (it is let go when it exits), so a CLI
     * that refuses the request is not started again for every chat.
     * @returns {Promise<string | null>}
     */
    async title(text, account, binOverride) {
      const q = await helperFor(account, binOverride).h.q;
      if (typeof q?.generateSessionTitle !== 'function') return null;
      const title = await q.generateSessionTitle(String(text), { persist: false });
      return typeof title === 'string' && title.trim() ? title : null;
    },
    /** Let every helper go (the app quits). */
    closeAll() {
      for (const [key, h] of [...helpers]) drop(key, h);
    },
  };
}

module.exports = { createTitleHelper, IDLE_MS };
