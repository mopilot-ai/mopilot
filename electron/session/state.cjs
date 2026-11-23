// SessionState: each chat's live state, owned by main (design principles[5]). Windows take a
// snapshot, then apply the patches main sends in rev order; a window that sees a gap in rev takes a
// new snapshot (src/store/session/sessionState.ts). Only main changes it: from harness events, from the
// ChatController (electron/session/controller.cjs), and from the few keys windows may set. The Rust core's session store
// (core/crates/session) decides each patch: which keys changed, what a turn's change implies and the revision; this class
// keeps the mirror every reader uses, the values exactly as given.
const { carryInputGuard } = require('./contract/inputGuard.cjs');
const { chatGoalStatus } = require('./goalStatus.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { randomInt } = require('node:crypto');
const { core, coreSyncCall } = require('../platform/core.cjs');
const { messageOf, noteIgnored } = require('../ignored.cjs');

/** A chat no one has touched yet. */
function emptySession() {
  return {
    rev: 0,
    /** idle | running | awaitingUser | crashed */
    turn: 'idle',
    /** the running turn: its id ('pending-…' until the harness names it) and whether a person started it */
    activeTurn: null,
    /** why the last turn ended with the harness gone */
    crashed: null,
    /** when the running turn last made progress, ms epoch (electron/session/turnProgress.cjs); null once it ends */
    progressAt: null,
    plan: false,
    permission: null,
    goal: null,
    /** messages waiting for the running turn to end, each with its full SendOptions */
    queue: [],
    /** native compaction gate; held queue rows retain their own waiting/retry reason */
    compaction: null,
    /** approvals and questions waiting for the user: {id, method, params} */
    approvals: [],
    /** ACP form questions, independent of approval and run-blocking state. */
    questions: [],
    /** the harness the next message switches to (src/harness/switch.ts) */
    pendingSwitch: null,
    /**
     * basic tier (ACP): what the harness declared for this session: modes {currentModeId,
     * availableModes}, configOptions, its command catalog (null until it pushes one), context usage
     */
    acp: null,
    /** what the chat's model takes in: 'image', 'text', or null when unknown (computer use sends both then) */
    modality: null,
    /** computer use in this chat: {app, state: 'active' | 'takeover' | 'waiting' | 'reading', read?}, or null */
    computer: null,
    /** background (app-scoped) control: {apps: [{bundleId, app, title, windowId, thumbnail, at, takenOver}]}, or null (appVisibility.cjs) */
    appControl: null,
    /**
     * Codex's own computer-use plugin releasing control after a turn (electron/capabilities/channels/
     * codexLifecycle.cjs): {phase: 'releasing' | 'failed', turnId, error}, or null. Never a takeover.
     */
    nativeCleanup: null,
    /**
     * Claude in Chrome's connection in the chat's Claude Code session (electron/harness/claude/chromeLink.cjs):
     * {connected, browser, installed, dropped, reconnectUrl, permissionsUrl}, or null when the session runs none.
     */
    chromeLink: null,
    /** who controls each surface on the chat's current segment: {key, iab, cu, bu} (electron/session/controllerPlan.cjs), or null until decided */
    controllerPlan: null,
    /** a Your Chrome call of the chat waits for the user to approve the connection in Chrome (electron/capabilities/browser/extension.cjs) */
    chromeApproval: false,
    /** the chat's last turn finished with browser steps it can keep as a routine (electron/app/routines.cjs, G4): {turnId, steps}, or null */
    routineOffer: null,
    /** background tasks the harness reports (Claude: background_tasks_changed and task_*) */
    tasks: [],
    /**
     * what the chat runs after its turn that only an adapter can list, as main last read it (Codex: its thread's
     * background commands and running sub-agents, electron/harness/codexBackgroundWork.cjs): {source, shells, agents}, or null
     */
    backgroundWork: null,
    /** Claude's ultracode as getSettings reports it: {on, available, probe}; null before a session ran */
    ultracode: null,
    /** Claude's Remote Control link as its session reports it: {state, url, error, wanted}; null before a session ran */
    remoteControl: null,
    /** another app is running a turn on the chat (electron/session/contract/reconcile.cjs) */
    runningElsewhere: false,
    /** the chat is a scheduled task's run: {unattended, computer (may it control apps), onApproval: 'wait' | 'skip'} */
    scheduled: null,
  };
}

/** Keys a window may set; the rest only main writes. */
const CLIENT_KEYS = new Set(['plan', 'permission', 'goal', 'pendingSwitch', 'modality', 'scheduled']);

/** Ids of the core's session stores, one per SessionStore in this process. */
/** A SessionStore that is collected closes its copy in the core; a close that fails is noted, as nothing waits on it. */
const closeInCore = new FinalizationRegistry((/** @type {{ addon: any, id: number }} */ held) => {
  try {
    coreSyncCall(held.addon, 'session.close', held.id);
  } catch (error) {
    noteIgnored("close a chat store's copy in the core", error);
  }
});

/**
 * A core session store for `owner`. The id is random: the core's stores are per process, and another copy of this module
 * (a worker, a test's fresh import) counts on its own.
 */
function openCoreStore(addon, owner) {
  const id = randomInt(1, 2 ** 48);
  coreSyncCall(addon, 'session.open', { id, empty: emptySession(), client: [...CLIENT_KEYS] });
  closeInCore.register(owner, { addon, id });
  return { addon, id };
}

class SessionStore {
  /**
   * @param {object} [opts]
   * @param [opts.publish] ({chatId, rev, patch}) => void, called once per change
   * @param {import('../platform/core.cjs').CoreAddon | null} [opts.addon] the Rust core (default: the one loaded)
   * @param {(chatId: string) => string | null | undefined} [opts.ownGoal] an adapter's own record of a chat's goal status (goalStatus.cjs)
   */
  constructor(opts = {}) {
    this.ownGoal = opts.ownGoal ?? (() => undefined);
    this.publish =
      opts.publish ??
      (() => {
        /* no publisher */
      });
    this.chats = new Map();
    /** Private approval lifetimes, keyed by live session objects so removed chats can be collected. */
    this.approvalTokens = new WeakMap();
    /** Local writer lifetimes survive turn completion, retiring reads that span an entire local turn. */
    this.writerTokens = new WeakMap();
    /** @type {{ addon: import('../platform/core.cjs').CoreAddon, id: number }} */
    this.core = openCoreStore(opts.addon === undefined ? core() : opts.addon, this);
  }
  /** The live state (read only outside this class). */
  get(chatId) {
    let s = this.chats.get(chatId);
    if (!s) {
      s = emptySession();
      this.chats.set(chatId, s);
    }
    return s;
  }
  /** The chat's goal status as main knows it: the adapter's own record, else this store's goal (for Codex a window's report, #2759). */
  goalStatus(chatId) {
    return chatGoalStatus(this.ownGoal(chatId), this.chats.has(chatId) ? this.get(chatId).goal : null);
  }

  has(chatId) {
    return this.chats.has(chatId);
  }
  localWriterToken(chatId) {
    const s = this.get(chatId);
    return this.writerTokens.get(s) ?? s;
  }
  markLocalWriter(chatId) {
    this.writerTokens.set(this.get(chatId), {});
  }
  /** An opaque token for this pending request's lifetime, including when a native id is reused. */
  approvalToken(chatId, id) {
    return this.approvalTokens.get(this.chats.get(chatId))?.get(id);
  }
  /** Whether the chat's turn runs (or waits for the user), on any harness; false for a chat the store doesn't track. */
  running(chatId) {
    const s = this.chats.get(chatId);
    return !!s && (s.turn === 'running' || s.turn === 'awaitingUser');
  }
  snapshot(chatId) {
    return structuredClone(this.chats.get(chatId) ?? emptySession());
  }
  all() {
    return [...this.chats.keys()];
  }
  /** Merge keys into a chat. Unchanged keys are dropped; a real change bumps rev and is published. */
  patch(chatId, partial) {
    if (typeof chatId !== 'string' || !chatId || !partial || typeof partial !== 'object') return false;
    return this.decide(chatId, partial, 'session.patch', (given) => ({ partial: given }));
  }
  /**
   * What the core answers on `route`. A failure throws, naming the route, and is the caller's: the mirror holds what the
   * core last decided, and no second copy of the rules could carry on from it.
   * @param {string} route @param {Record<string, unknown>} ask
   */
  ask(route, ask) {
    try {
      return coreSyncCall(this.core.addon, route, { id: this.core.id, ...ask });
    } catch (error) {
      throw new Error(`The Rust core did not answer ${route}: ${messageOf(error)}`, { cause: error });
    }
  }
  /**
   * A change the core decides on `route`, given `values` as main holds them: the mirror takes the changed ones as given
   * here, and those the core implied.
   * @param {string} chatId @param {Record<string, any>} values @param {string} route
   * @param {(given: Record<string, unknown>) => Record<string, unknown>} ask the route's payload beside the store and chat
   */
  decide(chatId, values, route, ask) {
    const s = this.get(chatId);
    /** @type {Record<string, unknown>} */
    const raw = {};
    for (const [k, v] of Object.entries(values)) raw[k] = v === undefined ? null : v;
    // copied before the core decides: a value that can't be copied fails here, before the core has taken it
    const given = structuredClone(raw);
    const reply = this.ask(route, { chat: chatId, now: clock.now(), ...ask(given) });
    if (!reply) return false;
    // Only main's mirror retains live input capabilities; core and published snapshots remain plain data.
    const originalQueue = raw.queue;
    if (Array.isArray(originalQueue) && Array.isArray(given.queue))
      given.queue = given.queue.map((item, i) => carryInputGuard(originalQueue[i], item));
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of reply.keys) out[k] = Object.hasOwn(reply.implied, k) ? reply.implied[k] : given[k];
    const turn = Object.hasOwn(out, 'turn') ? out.turn : (values.turn ?? s.turn);
    return this.apply(chatId, s, turn, out, reply.rev);
  }
  /**
   * A turn's own step (it starts, ends, or its harness quits; core/crates/session step_state), with `extra` keys set beside
   * it (the approvals that outlive the turn, the queue a refused start keeps); the step's values win.
   * @param {string} chatId @param {'start' | 'end' | 'crash'} name
   * @param {{ turnId?: string, human?: boolean, reason?: string | null }} [args] @param {Record<string, unknown>} [extra]
   */
  step(chatId, name, args = {}, extra = {}) {
    if (typeof chatId !== 'string' || !chatId) return false;
    const plain = { turnId: args.turnId ?? null, human: !!args.human, reason: args.reason ?? null };
    return this.decide(chatId, extra, 'session.step', (given) => ({ step: name, args: plain, extra: given }));
  }
  /** A decided change: approval and writer lifetimes, the mirror, the revision, and the patch windows apply. */
  apply(chatId, s, turn, out, rev) {
    if (turn === 'running' || turn === 'awaitingUser') this.markLocalWriter(chatId);
    if (Object.hasOwn(out, 'approvals')) {
      const previous = this.approvalTokens.get(s) ?? new Map();
      const ids = new Set(
        (Array.isArray(out.approvals) ? out.approvals : [])
          .map((a) => a?.id)
          .filter((id) => typeof id === 'string' || typeof id === 'number'),
      );
      const current = new Map();
      for (const id of ids) current.set(id, previous.get(id) ?? {});
      this.approvalTokens.set(s, current);
    }
    Object.assign(s, out);
    s.rev = rev;
    this.publish({ chatId, rev: s.rev, patch: structuredClone(out) });
    return true;
  }
  /**
   * The controller's drain: the first queued message, taken off the queue to be sent, when the chat's turn is not running,
   * the message waits on nothing and then `held()` (what only main knows: a folder change, a voice conversation, a
   * compaction, asked only once the rest allows it) says nothing holds the chat; else null (core/crates/session drainable,
   * drain).
   * @param {string} chatId @param {() => boolean} held
   */
  takeNext(chatId, held) {
    const s = this.chats.get(chatId);
    if (!s) return null;
    if (!this.ask('session.drainable', { chat: chatId }) || held()) return null;
    const reply = this.ask('session.drain', { chat: chatId, now: clock.now() });
    if (!reply) return null;
    const [next, ...rest] = s.queue;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of reply.keys)
      out[k] = k === 'queue' ? rest.map((item) => carryInputGuard(item, structuredClone(item))) : reply.implied[k];
    this.apply(chatId, s, s.turn, out, reply.rev);
    return next;
  }
  /**
   * Where queued message `itemId` goes back in the chat's queue when it didn't start: behind the messages put back first
   * in line before it (a stop that puts back a start and the steers behind it keeps the order they were sent), or ahead of
   * everything (`ahead`: the turn's own message). The caller inserts it at the index returned.
   * @param {string} chatId @param {unknown} itemId @param {boolean} [ahead]
   */
  putBack(chatId, itemId, ahead = false) {
    return this.ask('session.putBack', { chat: chatId, item: itemId, ahead });
  }
  /**
   * "Send now" on a queued message, in two phases (core/crates/session send_now): `admit` refuses a message from another
   * session (`peer`) while the turn runs and waits on the user, is switching harness, or can't take a steer; `route` says
   * whether it starts a turn, steers into the running one, or goes first in the queue. The capabilities are asked only
   * when the answer depends on them: `peerSteers()` (the peer's harness takes a steer), `steers()` (this harness does).
   * @param {string} chatId @param {'admit' | 'route'} phase
   * @param {{ peer?: boolean, peerSteers?: () => boolean, steers?: () => boolean }} [o]
   * @returns {'admit' | 'refuse' | 'start' | 'steer' | 'queueFirst'}
   */
  sendNowRoute(chatId, phase, o = {}) {
    const ask = { chat: chatId, phase, peer: !!o.peer };
    const answer = this.ask('session.sendNow', ask);
    if (answer !== 'ask') return answer;
    const flag = phase === 'admit' ? { peerSteers: !!o.peerSteers?.() } : { steers: !!o.steers?.() };
    return this.ask('session.sendNow', { ...ask, ...flag });
  }
  /** A window's patch: only the keys windows own. */
  clientPatch(chatId, partial) {
    if (!partial || typeof partial !== 'object') return false;
    const ok = {};
    for (const k of Object.keys(partial)) if (CLIENT_KEYS.has(k)) ok[k] = partial[k];
    return this.patch(chatId, ok);
  }
}

module.exports = { SessionStore, emptySession, CLIENT_KEYS };
