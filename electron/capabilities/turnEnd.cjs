// A chat's turn ended, on any harness (finished, interrupted, stopped, or the harness went away): the
// host tools let go of what the turn held - the in-app browser's turn tabs and pending waits, the
// desktop lock, held keys and buttons, the overlay. turnLedger is main's one entry point for it: every
// report of an end (the session going idle or crashed, a Codex turn/completed, a crash) goes through it,
// and each turn of a chat is let go once. Stop and a crash also abort the chat's running tool calls.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {Array<(chatId: string) => unknown>} steps each idempotent; a failing step doesn't stop the others
 * @returns {(chatId: string | null | undefined) => Promise<void>}
 */
function hostTurnEnd(steps) {
  const running = new Map();
  return (chatId) => {
    if (!chatId) return Promise.resolve();
    const inflight = running.get(chatId);
    if (inflight) return inflight;
    const run = Promise.allSettled(steps.map((step) => Promise.resolve().then(() => step(chatId))))
      .then(() => {
        /* each step settles on its own; callers only wait for all to finish */
      })
      .finally(() => running.delete(chatId));
    running.set(chatId, run);
    return run;
  };
}

/**
 * The chat whose turn a Codex app-server message ended, or null. Read after the chat controller saw
 * the message: a turn/completed it didn't end (a chat no window opened, a turn it didn't track) still
 * lets go, but never while a turn is still running for the chat (a late completion of an older turn).
 * @param {any} msg
 * @param {{ chatOf: (threadId: string) => string, running: (chatId: string) => boolean }} o
 */
function codexTurnEndedChat(msg, { chatOf, running }) {
  if (!msg || msg.method !== 'turn/completed') return null;
  const threadId = msg.params && msg.params.threadId;
  if (!threadId) return null;
  try {
    const chatId = chatOf(threadId) || null;
    return chatId && !running(chatId) ? chatId : null;
  } catch {
    return null;
  }
}

/**
 * The chat whose turn a SessionStore patch ended (it went idle, or crashed), or null. Any harness: the
 * in-app browser's turn tabs close on it, since ChatController.onFinished is taken over by PeerRuntime.
 * @param {any} p a session:patch payload ({ chatId, patch })
 */
function patchTurnEndedChat(p) {
  const turn = p && p.patch && p.patch.turn;
  if (turn !== 'idle' && turn !== 'crashed') return null;
  return typeof p.chatId === 'string' && p.chatId ? p.chatId : null;
}

/**
 * Main's turn-end wiring, for every harness (electron/app/sessions.cjs). Reports come from the session
 * patches (a turn going running begins it; idle or crashed ends it), the Codex app-server's messages
 * (turn/started begins one the controller may not track; a turn/completed it didn't end still ends
 * one) and the ChatController's hooks (`hooks`: a crash, a finished turn, a Stop). A turn is let go
 * once however many of them report its end, and a crash once more even after the turn went idle (work
 * that outlived the turn, such as a background agent's, held something). An end reported while an
 * earlier one is still letting go runs after it, unless a newer turn began meanwhile (its own end lets
 * go). A chat the sessions don't track is forgotten once let go. `retire`: an end retires the turn's `(chat, turn)`
 * tokens at once, before anything is let go, so its executors refuse what the turn still sends (./contract/turnTokens.cjs):
 * a Codex turn/completed only its thread's (thread), the chat's own turn ending the chat's (thread null), and a crash
 * every thread's (`retireAll`); see threadTurns for a Codex thread's. `ownerOf`: the chat a Codex thread's calls are
 * charged to (a sub-agent's: its parent's; default chatOf); `rootOf`: the thread at the top of its spawn chain;
 * `threadOf`: the Codex thread whose turn is the chat's own, or null (Claude Code, ACP: the chat has one turn).
 * `ridden`: whether a Codex thread's current turn has a call that did not name its thread (threadTurns; default: yes).
 * @param {{ steps: Array<(chatId: string) => unknown>,
 *           abortChat: (chatId: string, why: 'quit' | 'stopped', segmentId?: string) => unknown,
 *           retire?: (chatId: string, thread: string | null) => unknown,
 *           retireAll?: (chatId: string) => unknown,
 *           ownerOf?: (threadId: string) => string,
 *           rootOf?: (threadId: string) => string,
 *           threadOf?: (chatId: string) => string | null,
 *           ridden?: (chatId: string, thread: string) => boolean,
 *           chatOf: (threadId: string) => string,
 *           running: (chatId: string) => boolean,
 *           tracked: (chatId: string) => boolean }} o
 */
function turnLedger({
  steps,
  abortChat,
  retire = () => undefined,
  retireAll = () => undefined,
  chatOf,
  ownerOf = chatOf,
  rootOf = (id) => id,
  threadOf = () => null,
  ridden = () => true,
  running,
  tracked,
}) {
  const threads = threadTurns({ retire, ownerOf, rootOf, ridden });
  const release = hostTurnEnd(steps);
  /** @typedef {{ turn: number, ended: number, crashed: number, pending: number, last: Promise<void> }} Entry */
  /** @type {Map<string, Entry>} */
  const chats = new Map();
  const of = (/** @type {string} */ chatId) => {
    let c = chats.get(chatId);
    if (!c) chats.set(chatId, (c = { turn: 0, ended: -1, crashed: -1, pending: 0, last: Promise.resolve() }));
    return c;
  };
  /** A turn of the chat started: its end lets go again. */
  const begin = (/** @type {string | null | undefined} */ chatId) => {
    if (chatId) of(chatId).turn++;
  };
  /** Lets go for the chat's current turn after any run in flight; dropped when a newer turn began meanwhile. */
  const run = (/** @type {string} */ chatId, /** @type {Entry} */ c) => {
    const turn = c.turn;
    const started = c.pending++ ? c.last.then(() => (c.turn === turn ? release(chatId) : undefined)) : release(chatId);
    // never rejects: a run nobody awaits must not end the process with an unhandled rejection
    const last = started
      .then(() => {
        if (c.last === last && c.ended === c.turn && !tracked(chatId)) chats.delete(chatId);
      })
      .catch((error) => noteIgnored("forget a chat's let-go turn", error))
      .finally(() => {
        c.pending--;
      });
    c.last = last;
    return last;
  };
  /**
   * The one entry point: the chat's turn ended. Resolves once what it held is let go. `own`: false when a Codex
   * thread's end already retired its own tokens (codexMessage).
   */
  const end = (/** @type {string | null | undefined} */ chatId, own = true) => {
    if (!chatId) return Promise.resolve();
    const c = of(chatId);
    if (c.ended === c.turn) return c.last;
    c.ended = c.turn;
    if (own) {
      const thread = threadOf(chatId);
      if (thread) threads.completed(thread, null, chatId);
      else retire(chatId, null);
    }
    return run(chatId, c);
  };
  /** The chat's harness quit: lets go once for the current turn, even when the turn had already ended. */
  const crash = (/** @type {string} */ chatId) => {
    const c = of(chatId);
    if (c.crashed === c.turn) return c.last;
    c.crashed = c.ended = c.turn;
    retireAll(chatId);
    threads.forget(chatId);
    return run(chatId, c);
  };
  return {
    begin,
    end,
    /** How many chats the ledger remembers (it stays bounded by the chats the sessions track). */
    chatsHeld: () => chats.size,
    /** How many Codex threads it remembers running a turn (forgotten when the turn ends, on Stop or a crash). */
    threadsHeld: () => threads.size(),
    /** A SessionStore patch (session:patch payload). */
    sessionPatch(/** @type {any} */ p) {
      const ended = patchTurnEndedChat(p);
      if (ended) return void (p.patch.turn === 'crashed' ? crash(ended) : end(ended));
      if (p?.patch?.turn && typeof p.chatId === 'string') begin(p.chatId);
    },
    /** A Codex app-server message, after the ChatController saw it. */
    codexMessage(/** @type {any} */ msg) {
      if (msg?.method === 'turn/started' && msg.params?.threadId) {
        threads.started(msg.params.threadId, msg.params.turn?.id);
        try {
          begin(chatOf(msg.params.threadId));
        } catch (error) {
          // a thread no chat owns: no turn of a chat begins
          noteIgnored('begin the turn of a Codex thread no chat owns', error);
        }
        return;
      }
      if (msg?.method === 'turn/completed' && msg.params?.threadId) threads.completed(msg.params.threadId, msg.params.turn?.id);
      const ended = codexTurnEndedChat(msg, { chatOf, running });
      if (ended) end(ended, false);
    },
    /** The ChatController's hooks (onCrash, onFinished, onInterrupt). */
    hooks: {
      /** The chat's harness quit: its running calls end as aborted, and what the turn held is let go. */
      onCrash: (/** @type {string} */ chatId) => {
        abortChat(chatId, 'quit');
        threads.forget(chatId);
        return crash(chatId);
      },
      onFinished: (/** @type {{ chatId: string }} */ e) => end(e.chatId),
      /**
       * A Stop on a harness whose channel can't cancel each call itself: the chat's running calls stop now. With a
       * segment (an ACP session that isn't the chat's current one, or one that worked with no prompt), only its calls.
       */
      onInterrupt: (/** @type {string} */ chatId, /** @type {string | undefined} */ segmentId) => {
        if (segmentId) return void abortChat(chatId, 'stopped', segmentId);
        abortChat(chatId, 'stopped');
        threads.forget(chatId);
      },
    },
  };
}

/**
 * The turns of a chat's Codex threads, for their `(chat, turn)` tokens (./contract/turnTokens.cjs). Each thread's calls keep
 * their own thread's turn, so a thread's turn ending retires that thread's calls only: one sub-agent's end never stops
 * the parent's or another sub-agent's calls, and the parent's end stops its own leftover calls but never its
 * sub-agents'. A call names the thread it came from in Codex's turn metadata (codexConfig.cjs turnThreadOf), so a
 * sub-agent that shares its parent's tool session still has its calls on its own turn. A call that names no thread
 * rides on its session's thread, and may be a sharing sub-agent's (`ridden`, ./contract/turnTokens.cjs): the turn of a spawn
 * group's root thread that such a call rode on is retired only once no thread of its group runs a turn any more
 * (degraded: the root's own leftover calls stay current that long, or until Stop). Once no thread of the chat runs a
 * turn, the whole chat's tokens go (and the per-thread turns with them). A late end of an older turn of a thread
 * retires nothing; Stop and a crash retire the whole chat elsewhere and forget its threads here.
 * @param {{ retire: (chatId: string, thread: string | null) => unknown, ownerOf: (threadId: string) => string,
 *           rootOf: (threadId: string) => string, ridden: (chatId: string, thread: string) => boolean }} o
 */
function threadTurns({ retire, ownerOf, rootOf, ridden }) {
  /** @type {Map<string, string | true>} thread -> the turn it runs (true: its id is not known) */
  const running = new Map();
  /** The thread's chat (given, or ownerOf) and spawn group, or null for a thread no chat owns (no tokens). */
  const place = (/** @type {string} */ thread, /** @type {string | null} */ chat = null) => {
    try {
      return { chat: chat ?? ownerOf(thread), root: rootOf(thread) };
    } catch (error) {
      noteIgnored('find the chat of a Codex thread', error);
      return null;
    }
  };
  return {
    started(/** @type {string} */ thread, /** @type {unknown} */ turnId) {
      running.set(thread, typeof turnId === 'string' ? turnId : true);
    },
    /**
     * The thread's turn ended. turnId: the one that completed (undefined: not known); null for the chat's own end,
     * which names no turn: it leaves a turn Codex reported started and not completed (a late end of an older turn
     * must not refuse the new one's calls; that turn's own turn/completed retires it). chat: the chat it is the own
     * thread of.
     */
    completed(/** @type {string} */ thread, /** @type {unknown} */ turnId = undefined, /** @type {string | null} */ chat = null) {
      const now = running.get(thread);
      if (typeof now === 'string' && (turnId === null || (typeof turnId === 'string' && turnId !== now))) return;
      running.delete(thread);
      const at = place(thread, chat);
      if (!at) return;
      /** the spawn groups of the chat's threads still running a turn */
      const groups = new Set();
      for (const t of running.keys()) {
        const p = place(t);
        if (p?.chat === at.chat) groups.add(p.root);
      }
      // no thread of the chat runs a turn: every token of the chat goes, which also keeps the per-thread turns bounded
      if (!groups.size) return void retire(at.chat, null);
      if (thread !== at.root) retire(at.chat, thread);
      // the root's turn goes once its group is idle, or at its own end when every call on it named its thread
      if (!groups.has(at.root) || (thread === at.root && !ridden(at.chat, thread))) retire(at.chat, at.root);
    },
    /** Stop or a crash retired the chat's every thread: none of them runs a turn now. */
    forget(/** @type {string} */ chatId) {
      // and a thread no chat owns is dropped with it: it has no tokens
      for (const t of [...running.keys()]) if ((place(t)?.chat ?? chatId) === chatId) running.delete(t);
    },
    /** How many threads run a turn now (stays bounded by the running ones). */
    size: () => running.size,
  };
}

module.exports = { hostTurnEnd, turnLedger, threadTurns, codexTurnEndedChat, patchTurnEndedChat };
