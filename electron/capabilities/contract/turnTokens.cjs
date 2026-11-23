// The `(chat, turn)` token every computer-use and browser-use action carries to its executor (design D1, step 2):
// a call is issued its turn when it starts, and the token stays current until that turn ends, is Stopped or its
// harness quits (TurnLedger, ../turnEnd.cjs). A Claude Code or ACP chat has one turn at a time; each Codex thread of a
// chat (its own and each sub-agent's) has its own, so one thread's turn ending leaves the others' calls alone, while
// Stop or a crash retires every thread of the chat. A thread's turn is "ridden" while a call issued on it did not name
// its own thread (a Codex sub-agent sharing its parent's tool session, on a Codex that names none): retiring it might
// refuse another thread's call (../turnEnd.cjs threadTurns). The helper, Your Chrome, the in-app browser's action queue and the
// desktop and app locks refuse a token that is no longer current; locks are granted per token.
const { noteIgnored } = require('../../ignored.cjs');

/** @typedef {{ chat: string, thread?: string, turn: number }} TurnToken thread: the Codex thread, when turns are per thread */

class TurnTokens {
  constructor() {
    /** one counter for every chat and thread, so a retired turn number is never issued again */
    this.next = 0;
    /** @type {Map<string, number>} chat -> the turn of its calls with no thread, and the first turn of each thread */
    this.floors = new Map();
    /** @type {Map<string, Map<string, number>>} chat -> thread -> that thread's turn, once one of its turns ended */
    this.threads = new Map();
    /**
     * @type {Map<string, Set<string>>} chat -> the threads whose current turn has a call that did not name its own
     * thread: it may be another thread's (a sub-agent sharing the session), riding on this one's turn (ridden)
     */
    this.riders = new Map();
    /** @type {Set<(chat: string, turn: number, thread: string | null) => void>} */
    this.listeners = new Set();
  }

  /**
   * The current turn number of the chat (thread null) or of one of its threads.
   * @param {string} chat
   * @param {string | null} [thread]
   */
  turnOf(chat, thread = null) {
    const floor = this.floors.get(chat) ?? 0;
    return thread == null ? floor : (this.threads.get(chat)?.get(thread) ?? floor);
  }

  /**
   * The token for a call of the chat (or of one of its Codex threads) starting now; null without a chat. `named`:
   * false when the call did not name the thread it came from, so it is only known to have come over that thread's
   * tool session (ridden).
   * @param {string | null | undefined} chat
   * @param {string | null} [thread]
   * @param {{ named?: boolean }} [o]
   * @returns {TurnToken | null}
   */
  issue(chat, thread = null, { named = true } = {}) {
    if (!chat) return null;
    const turn = this.turnOf(chat, thread);
    if (thread == null) return { chat, turn };
    if (!named) {
      let riders = this.riders.get(chat);
      if (!riders) this.riders.set(chat, (riders = new Set()));
      riders.add(thread);
    }
    return { chat, thread, turn };
  }

  /**
   * Whether the thread's current turn has a call that did not name its thread: retiring that turn may refuse another
   * thread's call (a sub-agent sharing the thread's tool session).
   * @param {string} chat
   * @param {string} thread
   */
  ridden(chat, thread) {
    return this.riders.get(chat)?.has(thread) === true;
  }

  /**
   * Whether a token is still current. A call with no token (setup, Settings, a native Codex hold) is not
   * turn-scoped and always is.
   * @param {TurnToken | null | undefined} token
   */
  current(token) {
    return !token || this.turnOf(token.chat, token.thread ?? null) === token.turn;
  }

  /**
   * Every turn of the chat, on every thread, is over (Stop, a crash, a Claude Code or ACP turn's end): no token
   * issued for it so far is current. Listeners (the helper) hear the newest turn number retired, with no thread.
   * @param {string | null | undefined} chat
   */
  retire(chat) {
    if (!chat) return;
    const through = this.next;
    this.floors.set(chat, ++this.next);
    this.threads.delete(chat);
    this.riders.delete(chat);
    this.#tell(chat, through, null);
  }

  /**
   * One Codex thread's turn ended: that thread's tokens are no longer current; the chat's other threads keep theirs.
   * With no thread, the whole chat's (retire).
   * @param {string | null | undefined} chat
   * @param {string | null} [thread]
   */
  retireTurn(chat, thread = null) {
    if (!chat) return;
    if (thread == null) return this.retire(chat);
    const turn = this.turnOf(chat, thread);
    let threads = this.threads.get(chat);
    if (!threads) this.threads.set(chat, (threads = new Map()));
    threads.set(thread, ++this.next);
    // the thread's next turn starts with no call on it
    const riders = this.riders.get(chat);
    riders?.delete(thread);
    if (riders && !riders.size) this.riders.delete(chat);
    this.#tell(chat, turn, thread);
  }

  #tell(/** @type {string} */ chat, /** @type {number} */ turn, /** @type {string | null} */ thread) {
    for (const fn of this.listeners) {
      try {
        fn(chat, turn, thread);
      } catch (error) {
        // one listener's failure must not keep the turn current for the others
        noteIgnored('tell an executor a turn was retired', error);
      }
    }
  }

  /**
   * Calls `fn(chat, turn, thread)` when turns are retired: the chat's tokens up to `turn` (thread null), or that
   * thread's; returns a function that stops it.
   * @param {(chat: string, turn: number, thread: string | null) => void} fn
   */
  onRetire(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * What a turnThread rule (Registry.setTurnThread) answered for a call, as `{ thread, named }`: the thread whose turn
 * the call is kept on (null: the chat's), and whether the call itself named that thread. A bare thread id (a rule
 * that reads no call metadata) is only known to be the call's session, so it does not name the call's thread.
 * @param {string | null | undefined | { thread: string | null, named: boolean }} at
 * @returns {{ thread: string | null, named: boolean }}
 */
function callTurnThread(at) {
  if (at && typeof at === 'object') return { thread: at.thread ?? null, named: at.named === true };
  return { thread: at ?? null, named: false };
}

module.exports = { TurnTokens, callTurnThread };
