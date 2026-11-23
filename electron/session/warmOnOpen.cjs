// Warm on open for every harness (#1830, Claude Desktop's onWarmUp): a chat that stays in view a moment gets its harness's
// process ready before the user sends, one start a second at most. The chat's harness decides what that means: Claude Code
// resumes the chat's CLI (harness/claude/warmOnOpen.cjs). An ACP agent keeps its sessions open, so it has none. Codex has
// none yet: loading a thread takes its writer lock (codexLeases.cjs), so a Codex chat opened after its app-server was
// recycled (codexRecycle.cjs) resumes at its send (#1830 tracks it).
const { clock } = require('../platform/ports/clock.cjs');
const { byFamily } = require('./contract/route.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** A chat flicked past (scrolling the sidebar, switching through tabs) starts nothing. */
const SETTLE_MS = 1500;
/** Starts are spaced at least this far apart, so opening several windows starts their CLIs one by one. */
const STAGGER_MS = 1000;

/**
 * @param {object} o
 * @param {Record<string, { warm: (chatId: string, current: () => boolean) => Promise<unknown> } | undefined>} o.hooks by harness family
 * @param {(chatId: string) => string | null | undefined} o.kindOf the chat's current harness kind
 * @param {(chatId: string) => boolean} o.shown whether a window shows the chat now
 * @param {() => boolean} [o.enabled]
 * @param {number} [o.settleMs]
 * @param {number} [o.staggerMs]
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [o.timers]
 */
function createWarmOnOpen({
  hooks,
  kindOf,
  shown,
  enabled = () => true,
  settleMs = SETTLE_MS,
  staggerMs = STAGGER_MS,
  timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
}) {
  /** chatId -> its settle timer */
  const settling = new Map();
  /** @type {string[]} */
  const queue = [];
  let draining = false;
  let stopped = false;
  /** The chat is still worth warming: a window shows it, and the app is not quitting. */
  const current = (chatId) => !stopped && shown(chatId);

  const wait = (ms) => new Promise((r) => timers.setTimeout(r, ms));

  async function warmOne(chatId) {
    let hook;
    try {
      hook = byFamily(hooks, kindOf(chatId) ?? '');
    } catch (error) {
      // a chat the controller no longer knows has nothing to warm
      noteIgnored('read the harness of a chat to warm', error);
      return;
    }
    // the hook asks again after each wait: a chat left, or a quit, meanwhile starts nothing
    if (hook) await hook.warm(chatId, () => current(chatId)).catch((error) => noteIgnored('warm a chat opened in a window', error));
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const chatId = /** @type {string} */ (queue.shift());
        // still in view: a chat left while it waited its turn starts nothing
        if (!current(chatId)) continue;
        await warmOne(chatId);
        if (queue.length) await wait(staggerMs);
      }
    } finally {
      draining = false;
    }
  }

  return {
    /** A window shows the chat (app:viewing). */
    viewed(/** @type {string} */ chatId) {
      if (stopped || !chatId || !enabled() || settling.has(chatId)) return;
      const timer = timers.setTimeout(() => {
        settling.delete(chatId);
        if (!current(chatId) || queue.includes(chatId)) return;
        queue.push(chatId);
        void drain();
      }, settleMs);
      timer?.unref?.();
      settling.set(chatId, timer);
    },
    /** Quitting: nothing pending starts, nor a warm under way. */
    stop() {
      stopped = true;
      for (const t of settling.values()) timers.clearTimeout(t);
      settling.clear();
      queue.length = 0;
    },
  };
}

module.exports = { createWarmOnOpen, SETTLE_MS, STAGGER_MS };
