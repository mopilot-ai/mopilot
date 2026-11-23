// Keeping the computer awake for a chat (request_keep_awake), on every harness: one OS power-save blocker shared by the
// chats that hold it, each hold ending when its turn finishes ("turn_end"), when the chat has been idle a while
// ("session_idle"), when the chat is stopped, crashes, is deleted or archived, when the hold's cap passes, or at quit.

/** How long a "session_idle" hold outlasts the chat's last turn. */
const IDLE_MS = 10 * 60_000;
/** No hold lasts longer than this, whatever the chat does (a missed end event can't keep the machine awake for good). */
const MAX_HOLD_MS = 12 * 60 * 60_000;

class KeepAwake {
  /**
   * @param {object} o
   * @param {{ start(type: string): number, stop(id: number): void } | null} o.blocker Electron's powerSaveBlocker; null where there is none
   * @param {(fn: () => void, ms: number) => any} [o.setTimer]
   * @param {(timer: any) => void} [o.clearTimer]
   * @param {number} [o.idleMs]
   * @param {number} [o.maxMs]
   */
  constructor({ blocker, setTimer = setTimeout, clearTimer = clearTimeout, idleMs = IDLE_MS, maxMs = MAX_HOLD_MS }) {
    this.blocker = blocker;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    /** @type {Map<string, { until: string, idle: any, cap: any }>} */
    this.holds = new Map();
    /** @type {number | null} the OS blocker's id while any chat holds */
    this.blockerId = null;
    /** @type {Set<string>} chats whose user allowed holding, for the rest of the session */
    this.approved = new Set();
  }

  get available() {
    return !!this.blocker;
  }

  isHeld(/** @type {string} */ chatId) {
    return this.holds.has(chatId);
  }

  /**
   * Holds the computer awake for `chatId` until its turn ends or it goes idle.
   * @returns {'held' | 'replaced' | 'unavailable'} replaced: the chat held already and its boundary changed
   */
  hold(/** @type {string} */ chatId, /** @type {string} */ until) {
    if (!this.blocker) return 'unavailable';
    const had = this.holds.get(chatId);
    if (had) this.#clear(had);
    this.holds.set(chatId, { until, idle: null, cap: this.setTimer(() => this.release(chatId), this.maxMs) });
    if (this.blockerId === null) this.blockerId = this.blocker.start('prevent-app-suspension');
    return had ? 'replaced' : 'held';
  }

  /** A turn of `chatId` began: a "session_idle" hold stops counting down. */
  turnStarted(/** @type {string} */ chatId) {
    const h = this.holds.get(chatId);
    if (!h?.idle) return;
    this.clearTimer(h.idle);
    h.idle = null;
  }

  /** A turn of `chatId` ended: "turn_end" lets go, "session_idle" starts counting down. */
  turnFinished(/** @type {string} */ chatId) {
    const h = this.holds.get(chatId);
    if (!h) return;
    if (h.until === 'turn_end') {
      this.release(chatId);
      return;
    }
    if (h.idle) this.clearTimer(h.idle);
    h.idle = this.setTimer(() => this.release(chatId), this.idleMs);
  }

  /** Lets go of `chatId`'s hold (stopped, crashed, deleted, archived, expired); the OS blocker stops with the last one. */
  release(/** @type {string} */ chatId) {
    const h = this.holds.get(chatId);
    if (!h) return;
    this.#clear(h);
    this.holds.delete(chatId);
    if (this.holds.size || this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    this.blocker?.stop(id);
  }

  /** The chat is gone (deleted): its hold and its approval end. */
  forget(/** @type {string} */ chatId) {
    this.release(chatId);
    this.approved.delete(chatId);
  }

  /** Every hold ends (the app quits). */
  releaseAll() {
    for (const chatId of [...this.holds.keys()]) this.release(chatId);
  }

  #clear(/** @type {{ idle: any, cap: any }} */ h) {
    if (h.idle) this.clearTimer(h.idle);
    this.clearTimer(h.cap);
  }
}

module.exports = { KeepAwake, IDLE_MS, MAX_HOLD_MS };
