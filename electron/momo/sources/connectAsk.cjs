// MoMo's "connect this" card (#2999): a MoMo chat tool that needs Calendar or Reminders before the user connected it puts a momoConnect card in that chat through the app's one ApprovalBroker, the same on every harness (the ask comes from the shared source tools, not the harness). Only the user's click on the card connects anything: it runs the same connect as Settings › MoMo › Sources, and main answers the card itself when the source turns connected (also when the user connects it in Settings meanwhile). A routine's unattended run never gets a card (its chat has a scope); the tool keeps its "not connected" error and the run's "MoMo needs you" notice. One card per chat and source at a time, and after "Not now" the chat is not asked about that source again for COOLDOWN_MS. The call's signal withdraws the card, as does MoMo being turned off or the chat deleted.
const { identityKey } = require('../../../shared/identityKey.mjs');

const KIND = 'momoConnect';
/** The sources a card can connect: the ones macOS asks for (Files needs a folder, picked in Settings). */
const ASKABLE = new Set(['calendar', 'reminders']);
/** After "Not now", how long the same chat is not asked about that source again. */
const COOLDOWN_MS = 5 * 60_000;

/**
 * @typedef {'connected' | 'declined' | 'none'} Outcome connected: the source is connected now; declined: the user said Not now (or did a
 *   moment ago); none: no card was shown or it went away unanswered
 */

/**
 * @param {object} o
 * @param {() => ({ ask: (chatId: string, kind: string, params: object, o: { signal: AbortSignal | null }) => Promise<unknown> & { id?: string },
 *   answer: (id: string, result: unknown) => boolean }) | null} o.broker the app's ApprovalBroker, once computer use set it up
 * @param {{ ready: (id: string) => boolean, on: (event: string, fn: () => void) => unknown, off: (event: string, fn: () => void) => unknown }} o.hub the sources hub (ready: connected, and macOS allows its reads)
 * @param {(chatId: string) => string | null | undefined} o.harnessOf the chat's harness now
 * @param {(chatId: string) => boolean | Promise<boolean>} o.attended a person is in the chat (not a routine's run)
 * @param {() => number} [o.now]
 */
function createConnectAsk({ broker, hub, harnessOf, attended, now = Date.now }) {
  /** @type {Map<string, Promise<Outcome>>} chat and source -> the card still up */
  const asking = new Map();
  /** @type {Map<string, string>} chat and source -> the id of its card */
  const ids = new Map();
  /** @type {Map<string, number>} chat and source -> when the user said Not now */
  const declined = new Map();

  /** @returns {Promise<Outcome>} */
  async function show(/** @type {string} */ chatId, /** @type {string} */ source, /** @type {AbortSignal | null} */ signal) {
    const b = broker();
    if (!b) return 'none';
    const key = identityKey(chatId, source);
    const pending = b.ask(chatId, KIND, { harness: harnessOf(chatId) ?? '', momoConnect: { source } }, { signal });
    // the broker names every card it puts up
    ids.set(key, /** @type {string} */ (pending.id));
    // the user connected it (here or in Settings): the card is answered
    const connected = () => {
      if (hub.ready(source)) b.answer(/** @type {string} */ (pending.id), { connected: true });
    };
    hub.on('changed', connected);
    try {
      const answer = /** @type {any} */ (await pending);
      if (answer?.connected === true && hub.ready(source)) return 'connected';
      if (answer?.decision === 'deny') {
        declined.set(key, now());
        return 'declined';
      }
      return 'none';
    } finally {
      hub.off('changed', connected);
      ids.delete(key);
    }
  }

  return {
    /**
     * Puts the card up for a source the chat's tool found not connected and resolves with how it ended. Overlapping asks for the
     * same chat and source share one card.
     * @param {{ chatId: string, source: string }} o
     * @param {{ signal?: AbortSignal | null }} [opts]
     * @returns {Promise<Outcome>}
     */
    async ask({ chatId, source }, { signal = null } = {}) {
      if (!ASKABLE.has(source) || signal?.aborted) return 'none';
      if (hub.ready(source)) return 'connected';
      const key = identityKey(chatId, source);
      const known = asking.get(key);
      if (known) return known;
      const at = declined.get(key);
      if (at !== undefined && now() - at < COOLDOWN_MS) return 'declined';
      declined.delete(key);
      // a person must be in the chat: a routine's run is not asked
      if (!(await attended(chatId))) return 'none';
      const again = asking.get(key);
      if (again) return again;
      const shown = show(chatId, source, signal);
      asking.set(key, shown);
      // however it ends, the next ask starts fresh
      const done = () => asking.delete(key);
      shown.then(done, done);
      return shown;
    },
    /** MoMo was turned off for the account: every card still up goes, answering nothing. */
    withdrawAll() {
      const b = broker();
      for (const id of [...ids.values()]) b?.answer(id, null);
    },
    /** The chat was deleted: its cards still up go, answering nothing. */
    withdrawChat(/** @type {string} */ chatId) {
      const b = broker();
      for (const [key, id] of [...ids]) if (JSON.parse(key)[0] === chatId) b?.answer(id, null);
    },
    /** How many cards are up (tests, diagnostics). */
    openCount: () => ids.size,
  };
}

module.exports = { createConnectAsk, KIND, ASKABLE, COOLDOWN_MS };
