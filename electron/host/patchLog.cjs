// A bounded log of each chat's session patches (rev order), so a subscriber that fell behind replays exactly the patches it missed.

const { noteIgnored } = require('../ignored.cjs');

const KEEP = 200;

class PatchLog {
  /** @param {number} [keep] patches kept per chat */
  constructor(keep = KEEP) {
    this.keep = keep;
    /** @type {Map<string, { rev: number, patch: object }[]>} */
    this.byChat = new Map();
    /** @type {Set<(p: { chatId: string, rev: number, patch: object }) => void>} */
    this.listeners = new Set();
  }
  /** Records one `{chatId, rev, patch}` the session store published and tells the listeners. @param {{ chatId: string, rev: number, patch: object }} p */
  record(p) {
    const list = this.byChat.get(p.chatId) ?? [];
    list.push({ rev: p.rev, patch: p.patch });
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    this.byChat.set(p.chatId, list);
    // a listener's failure must not keep the patch from the windows that publish it
    for (const fn of [...this.listeners]) {
      try {
        fn(p);
      } catch (error) {
        noteIgnored('tell a Host subscriber about a session patch', error);
      }
    }
  }
  /** Calls `fn` for every later patch; returns the function that stops it. @param {(p: { chatId: string, rev: number, patch: object }) => void} fn */
  listen(fn) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  /** Lets a chat's log go when the chat is removed. @param {string} chatId */
  forget(chatId) {
    this.byChat.delete(chatId);
  }
  /**
   * The patches after `fromRev` up to `uptoRev`, or null when the log no longer holds all of them (the caller then
   * takes the snapshot alone).
   * @param {string} chatId @param {number} fromRev @param {number} uptoRev
   */
  since(chatId, fromRev, uptoRev) {
    if (fromRev > uptoRev) return null;
    if (fromRev === uptoRev) return [];
    const missed = (this.byChat.get(chatId) ?? []).filter((p) => p.rev > fromRev && p.rev <= uptoRev);
    return missed.length === uptoRev - fromRev ? missed.map((p) => ({ chatId, ...p })) : null;
  }
}

module.exports = { PatchLog, KEEP };
