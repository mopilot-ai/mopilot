// What a harness says about a chat's usage windows, kept for the Chrome side panel's "approaching" banner. Claude Code: its rate_limit_event, kept
// per chat and per window in memory (it is not saved: after an app restart a chat shows none until its CLI reports again). Codex: nothing is kept here;
// the windows are the ones the account pool already holds for the login that serves the chat (identity/accounts/limits.cjs servingLogin: the
// relay's pin, or the login the app-server holds, and none while that cannot be told). A basic (ACP) harness's protocol carries no usage field: it
// hears nothing and warns of nothing. A warning is read when the panel reads the chat. Each family's reading is one entry of BY_FAMILY, so a family
// added later has to say what it does (an entry that hears nothing is an answer).
const { addGuard, addHook } = require('../session/hookChain.cjs');
const {
  claudeLimitReached,
  claudeLimitWarning,
  claudeWarningWindow,
  codexLimitReached,
  codexLimitWarning,
  warningHolds,
} = require('../../shared/chatSignals.mjs');

/** The most chats whose Claude warnings are kept: a warning is dropped at its reset, so only chats with a window open count. */
const MAX_CHATS = 200;

/** @typedef {import('../../shared/chatSignals.mjs').LimitWarning} LimitWarning */
/** @typedef {import('../../shared/chatSignals.mjs').LimitWindow} LimitWindow */
/** @typedef {import('../../shared/harnessKind.mjs').HarnessFamily} HarnessFamily */

class ChatSignals {
  /**
   * @param {{ now?: () => number, codexLimits?: (chatId: string) => { primary?: any, secondary?: any } | null }} [o]
   *   codexLimits: the usage windows of the login that serves a Codex chat, or null when that cannot be told
   */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    this.codexLimits = o.codexLimits ?? (() => null);
    /** @type {Map<string, { account: string | null, windows: Map<LimitWindow, LimitWarning> }>} chat id -> the login its events came from, and the warning each window last gave */
    this.claude = new Map();
    /** @type {Map<string, { window: LimitWindow | null, resetsAt: number | null }>} chat id -> the window Claude Code last rejected a request for */
    this.rejected = new Map();
    /** @type {Map<string, { at: number, ended: boolean }>} chat id -> the turn that stopped on the harness's usage limit (any harness), until the chat runs again */
    this.limited = new Map();
  }

  /** Follows the controller's limit, send and turn-end hooks beside the others': they say which chats stopped on a usage limit, on every harness. */
  follow(/** @type {any} */ controller) {
    addHook(controller, 'onLimit', (/** @type {string} */ chatId) => this.limitHit(chatId));
    addHook(controller, 'onFinished', (/** @type {{ chatId: string }} */ e) => this.turnEnded(e.chatId));
    addGuard(controller, 'beforeDispatch', (/** @type {{ chatId: string }} */ e) => this.limitCleared(e.chatId));
    return this;
  }

  /** The chat's running turn is ending on its harness's usage limit (ChatController.onLimit). */
  limitHit(/** @type {string} */ chatId) {
    // every harness reports a limit more than once: the turn's later reports are the same episode, which keeps its key (a dismissal belongs to it)
    if (this.limited.get(chatId)?.ended === false) return;
    this.limited.delete(chatId);
    this.limited.set(chatId, { at: this.now(), ended: false });
    for (const id of this.limited.keys()) if (this.limited.size > MAX_CHATS) this.limited.delete(id);
  }

  /** The chat is sent something: whatever limit stopped it no longer says where it is. */
  limitCleared(/** @type {string} */ chatId) {
    this.limited.delete(chatId);
  }

  /** A turn of the chat ended: the one the limit cut off ends once; the next one that ends has run since, so the limit is no longer where the chat stopped. */
  turnEnded(/** @type {string} */ chatId) {
    const mark = this.limited.get(chatId);
    if (!mark) return;
    if (mark.ended) this.limited.delete(chatId);
    else mark.ended = true;
  }

  /** `limitOf` as the field the chat's read carries: `{ limit }`, or nothing for a chat that did not stop on one. */
  limitField(/** @type {string} */ chatId, /** @type {HarnessFamily | null | undefined} */ family, /** @type {any} */ last) {
    const limit = this.limitOf(chatId, family, last);
    return limit ? { limit } : {};
  }

  /**
   * The usage limit the chat stopped on, for the harness it runs on now: null when it did not stop on one. `key` names the episode (a dismissal belongs to it);
   * the window and its reset are what the harness says of them, null when it says none (a basic harness gives neither). A chat the app was restarted on
   * has no mark: a limit note that ends its rows (`last`) says it did stop on one, with no window.
   * @param {string} chatId @param {HarnessFamily | null | undefined} family @param {{ id?: string, limit?: boolean } | undefined} last the chat's last row
   * @returns {{ key: string, window: LimitWindow | null, resetsAt: number | null } | null}
   */
  limitOf(chatId, family, last) {
    const none = { window: null, resetsAt: null };
    const mark = this.limited.get(chatId);
    if (mark) return { key: `limit-${mark.at}`, ...(BY_FAMILY[family ?? '']?.reached(this, chatId, this.now()) ?? none) };
    return last?.limit === true ? { key: String(last.id ?? 'limit-note'), ...none } : null;
  }

  /**
   * One raw event from the controller (ChatController.onLiveEvent), whatever chat is open in a panel.
   * @param {HarnessFamily} family @param {any} e @param {(key: string) => string} chatOf the chat a native session belongs to
   */
  event(family, e, chatOf) {
    BY_FAMILY[family]?.hear(this, e, chatOf);
  }

  /**
   * The warning a chat shows now, for the harness it runs on now (a chat that moved from one harness to another shows the new one's).
   * @param {string} chatId @param {HarnessFamily | null | undefined} family
   * @returns {LimitWarning | null}
   */
  warningOf(chatId, family) {
    const by = BY_FAMILY[family ?? ''];
    return by ? by.warning(this, chatId, this.now()) : null;
  }

  hearClaude(/** @type {any} */ e, /** @type {(key: string) => string} */ chatOf) {
    const m = e?.kind === 'message' ? e.msg : null;
    // a key or credits run says nothing about the login; a sub-agent's events are its own
    if (typeof e?.key !== 'string' || !e.key || m?.type !== 'rate_limit_event' || m.parent_tool_use_id || e.login === false) return;
    const chatId = chatOf(e.key);
    const now = this.now();
    // another login's process: what the first one said is not about this one
    let slot = this.claude.get(chatId);
    if (slot && typeof e.account === 'string' && slot.account !== null && slot.account !== e.account) slot = undefined;
    const windows = slot?.windows ?? new Map();
    const info = m.rate_limit_info;
    const window = claudeWarningWindow(info);
    const warning = claudeLimitWarning(info, now);
    // a window clears when its own event says allowed again or refused outright (that is the limit, not an approach to it), never for another window's
    if (window && !warning) windows.delete(window);
    // a window heard again is the latest heard (the order a tie is broken by)
    if (warning) windows.delete(warning.window), windows.set(warning.window, warning);
    // a refused request is the limit itself: its window and reset are kept for the banner; any other status says the chat is served again
    const reached = claudeLimitReached(info, now);
    this.rejected.delete(chatId);
    if (reached) this.rejected.set(chatId, reached);
    for (const id of this.rejected.keys()) if (this.rejected.size > MAX_CHATS) this.rejected.delete(id);
    this.claude.delete(chatId);
    if (windows.size) this.claude.set(chatId, { account: typeof e.account === 'string' ? e.account : (slot?.account ?? null), windows });
    // the oldest chat's warnings go first, and any whose window has reset
    for (const [id, s] of this.claude) if (!this.#held(s, now) || this.claude.size > MAX_CHATS) this.claude.delete(id);
  }

  /** Drops the windows of a chat's slot that have reset; whether any is left. */
  #held(/** @type {{ windows: Map<LimitWindow, LimitWarning> }} */ slot, /** @type {number} */ now) {
    for (const [window, w] of slot.windows) if (!warningHolds(w, now)) slot.windows.delete(window);
    return slot.windows.size > 0;
  }

  /** What the last rejected request of a Claude chat says of its window; none for a chat that was never rejected. */
  claudeReached(/** @type {string} */ chatId, /** @type {number} */ now) {
    const r = this.rejected.get(chatId);
    if (!r) return null;
    // a reset that has passed is no longer named
    return { window: r.window, resetsAt: r.resetsAt !== null && r.resetsAt > now ? r.resetsAt : null };
  }

  claudeWarning(/** @type {string} */ chatId, /** @type {number} */ now) {
    const slot = this.claude.get(chatId);
    if (!slot) return null;
    if (!this.#held(slot, now)) {
      this.claude.delete(chatId);
      return null;
    }
    // the window nearest its limit when two are close, the one heard last when they are as close
    return [...slot.windows.values()].reduce((a, b) => ((b.utilization ?? 0) >= (a.utilization ?? 0) ? b : a));
  }
}

/**
 * What each family does with the controller's events and with a chat's read. A basic (ACP) harness has no usage-window signal in its
 * protocol: it hears nothing and warns of nothing, and the panel shows no "approaching" banner for its chats. Codex's windows are the
 * account pool's, read through `codexLimits`, so it hears nothing here either.
 * `reached` is the window the harness says the chat's limit is about and its reset, for a chat that stopped on one: Claude's last rejected request, Codex's used-up window of the
 * serving login; a basic harness names neither (the banner says only that the limit is reached).
 * @type {Record<HarnessFamily, {
 *   hear: (s: ChatSignals, e: any, chatOf: (key: string) => string) => void,
 *   warning: (s: ChatSignals, chatId: string, now: number) => LimitWarning | null,
 *   reached: (s: ChatSignals, chatId: string, now: number) => { window: LimitWindow | null, resetsAt: number | null } | null,
 * }>}
 */
const BY_FAMILY = Object.assign(Object.create(null), {
  claude: {
    hear: (s, e, chatOf) => s.hearClaude(e, chatOf),
    warning: (s, chatId, now) => s.claudeWarning(chatId, now),
    reached: (s, chatId, now) => s.claudeReached(chatId, now),
  },
  codex: {
    hear: () => undefined,
    warning: (s, chatId, now) => codexLimitWarning(s.codexLimits(chatId), now),
    reached: (s, chatId, now) => codexLimitReached(s.codexLimits(chatId), now),
  },
  acp: { hear: () => undefined, warning: () => null, reached: () => null },
});

module.exports = { ChatSignals, MAX_CHATS };
