// A basic (ACP) chat's harness events as thread items, translated once in main (docs/architecture/rust-core.md §6 step 4:
// translation in one place, not in each window): one AcpTranslator (the core's, core/crates/translate) per native session
// for every window, its Codex-shaped notifications sent to the windows on acp:items, and the history read the same way.
const { AcpTranslator, openHistory, settleHistory, historyPage, releaseHistory, keepHistory } = require('./acpTranslator.cjs');
const { AcpTokenUsage } = require('../../../shared/acpTokenUsage.mjs');
const { TEXT_METHODS } = require('../../../shared/streamDelta.mjs');
const { noteIgnored } = require('../../ignored.cjs');

/** Events a session's retired segment still sends after a switch: they belong to it, never to the chat's current turn. */
const LIVE = new Set(['turnStart', 'update', 'turnEnd', 'steered', 'providerError', 'unattended']);
/** How long work with no prompt running may go quiet before its turn closes (an unattended burst main cancelled). */
const STRAY_MS = 1500;
/** How many sessions keep a translator here: a chat closed for good says nothing here, so past this the oldest idle one goes. */
const MAX_TRANSLATORS = 256;
/** How long a read is held for its next page, and how many sessions' at once: a long chat's turns are hundreds of megabytes. */
const KEEP_MS = 60_000;
const MAX_HELD = 8;

/** @typedef {(chatId: string, key: string, method: string, params: Record<string, unknown>) => void} ItemEmit */

class AcpItems {
  /**
   * @param {{ chatOf: (key: string) => string, nativeOf: (chatId: string) => string | null | undefined,
   *   cwdOf: (key: string) => string | null | undefined, emit: ItemEmit,
   *   timers?: { set: typeof setTimeout, clear: typeof clearTimeout }, flush?: (chatId: string) => void }} o
   *   flush: send on what the stream batcher still holds of a chat
   */
  constructor({ chatOf, nativeOf, cwdOf, emit, timers = { set: setTimeout, clear: clearTimeout }, flush = () => undefined }) {
    this.o = { chatOf, nativeOf, cwdOf, emit, timers, flush };
    /** @type {Map<string, { chatId: string, translator: InstanceType<typeof AcpTranslator> }>} */
    this.entries = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.strays = new Map();
    this.usage = new AcpTokenUsage();
    /** what each read of a session running now has heard of it since it began: all but streamed text, each item as it last was, where it first came @type {Map<string, Set<Map<string, [string, any]>>>} */
    this.hearing = new Map();
    /** the sessions a turn is being followed from its transcript for, with what is to go on after it @type {Map<string, (() => void)[]>} */
    this.following = new Map();
    /** the last of those to begin, for whoever has to wait on it */
    this.followed = Promise.resolve();
    /** the read each session's older pages come from @type {Map<string, { id: number, timer: ReturnType<typeof setTimeout> }>} */
    this.held = new Map();
  }

  /**
   * The translation for main's late-bound services: the controller maps sessions to chats (each to itself before it
   * exists), and the ACP host knows each session's folder.
   * @param {{ controller?: { chatOf(key: string): string | undefined, nativeOf(chatId: string): string | undefined } | null,
   *   acpHost?: { chats?: Map<string, { cwd?: string | null }> } | null }} live
   * @param {ItemEmit} emit
   * @param {(chatId: string) => void} [flush]
   */
  static of(live, emit, flush) {
    return new AcpItems({
      flush,
      chatOf: (key) => live.controller?.chatOf(key) ?? key,
      nativeOf: (chatId) => live.controller?.nativeOf(chatId),
      cwdOf: (key) => live.acpHost?.chats?.get(key)?.cwd,
      emit,
    });
  }

  /** The session's translator while it still reports under the chat that owns it. */
  get(key) {
    const entry = this.entries.get(key);
    if (entry && entry.chatId !== this.o.chatOf(key)) {
      this.drop(key);
      return undefined;
    }
    return entry?.translator;
  }

  /** What a translator says goes to the windows, and into any read of its session under way. */
  say(chatId, key, method, params) {
    for (const heard of this.hearing.get(key) ?? []) {
      if (TEXT_METHODS.has(method)) continue;
      const name = params.item ? `item:${params.turnId}:${JSON.stringify(params.item.id)}` : `${method}:${heard.size}`;
      heard.set(name, [method, params]);
    }
    this.o.emit(chatId, key, method, params);
  }

  /** The session is gone, or has another owner: its translator goes with it. */
  drop(key) {
    this.clearStray(key);
    this.entries.get(key)?.translator.close();
    this.entries.delete(key);
  }

  ensure(key) {
    const existing = this.get(key);
    if (existing) return existing;
    const chatId = this.o.chatOf(key);
    const translator = new AcpTranslator(chatId, this.o.cwdOf(key) ?? '', (method, params) => this.say(chatId, key, method, params));
    this.entries.set(key, { chatId, translator });
    if (this.entries.size > MAX_TRANSLATORS) this.dropIdle(key);
    return translator;
  }

  /** Let the oldest session with no turn running go, other than `key`, which has just come. An event would start it afresh. */
  dropIdle(key) {
    for (const [other, entry] of this.entries) {
      if (other !== key && !entry.translator.turnId) return this.drop(other);
    }
  }

  clearStray(key) {
    this.o.timers.clear(this.strays.get(key));
    this.strays.delete(key);
  }

  /** Work with no prompt running was cancelled: its turn closes once it goes quiet. */
  settleLater(key, tr) {
    this.clearStray(key);
    this.strays.set(
      key,
      this.o.timers.set(() => {
        this.strays.delete(key);
        if (this.get(key) === tr && tr.turnId?.startsWith('auto-')) tr.endTurn('cancelled', null);
      }, STRAY_MS),
    );
  }

  /** The usage report as the notification the context ring and the turn's tokens read. */
  report(chatId, key, tokenUsage) {
    if (!tokenUsage) return;
    this.o.emit(chatId, key, 'thread/tokenUsage/updated', {
      threadId: chatId,
      tokenUsageSource: { harness: `acp:${key.split(':')[1]}`, nativeId: key },
      tokenUsage,
    });
  }

  /**
   * One event from the ACP host, translated into the chat's items; what the windows still need to know of it besides,
   * added to the event they get: whether a turn was running when it ended (`running`) or its harness quit (`working`).
   * @param {any} e
   * @returns {{ running?: boolean, working?: boolean } | null}
   */
  onEvent(e) {
    const key = e?.key;
    if (typeof key !== 'string') return null;
    const chatId = this.o.chatOf(key);
    if (LIVE.has(e.kind) && this.o.nativeOf(chatId) !== key) return null;
    switch (e.kind) {
      case 'turnStart': {
        const tr = this.ensure(key);
        tr.beginTurn(e.turnId, e.user);
        if (e.partway) this.followed = this.followTranscript(key, chatId, e.turnId, e.partway);
        return null;
      }
      case 'update': {
        const tr = this.ensure(key);
        // context used, for the context ring
        if (e.update?.sessionUpdate === 'usage_update' && typeof e.update.used === 'number')
          this.report(chatId, key, this.usage.contextUsed(key, e.update.used, e.update.size));
        tr.onUpdate(e.update, e.turnId, e.replaces);
        if (e.turnId === null && tr.turnId) this.settleLater(key, tr);
        return null;
      }
      case 'steered': {
        // a message the agent took into the turn that is running (the Host's own `steered`): the same user item a steer into a This Mac chat leaves, in order in that turn
        const tr = this.get(key);
        if (tr?.turnId && e.user)
          this.o.emit(chatId, key, 'item/completed', { threadId: chatId, turnId: tr.turnId, item: { type: 'userMessage', ...e.user } });
        return null;
      }
      case 'turnEnd': {
        const tr = this.get(key);
        // a turn that already ended (a late or repeated end) offers nothing again
        const running = !!tr?.turnId;
        tr?.endTurn(e.stopReason, e.error ?? null, e.providerError ?? null);
        this.report(chatId, key, this.usage.turnUsage(key, e.turnId, e.usage));
        return { running };
      }
      case 'session':
        if (e.fresh) this.usage.forget(key);
        return null;
      case 'closed': {
        this.usage.forget(key);
        const tr = this.get(key);
        // ending the turn clears its id, so note first whether one was running
        const working = !!tr?.turnId;
        if (working) tr?.endTurn('error', e.error);
        this.drop(key);
        return { working };
      }
      default:
        return null;
    }
  }

  /**
   * A page of a native session's transcript as the chat's turns: `page`, JSON for the window to parse (`{ turns, olderCursor }`),
   * of the `limit` latest, or those before the cursor `before`, all of them with no limit; `ids`, those turns' ids; and the
   * running turn's id. A turn this session is running stays open, and its next items follow
   * on with the ids the live translator gives them, since it read the same records.
   *
   * A window replaces its turns with this, so it has to be the session as of now, however long the read took: the core
   * reads on one of its threads while events go on, what the session says from before the read began is heard here, and
   * `settleHistory` lays that over what was read, on this thread, in the step that decides what is still running. That
   * step costs what was said meanwhile, with the turns that touched, whatever the transcript's size.
   * @param {string} key @param {string} chatId @param {string} cwd
   * @param {() => Promise<{ file: string, extra: any[] }>} source
   * @param {{ limit?: number, before?: string | null }} [page]
   */
  async history(key, chatId, cwd, source, { limit = 0, before = null } = {}) {
    // what is queued behind a follow is in the file already, and would land on a page that has it
    const following = this.following.get(key);
    if (following) await new Promise((go) => following.push(() => go(undefined)));
    if (before) {
      const held = this.held.get(key);
      if (held) return { ...historyPage(held.id, { limit, before }), activeTurnId: this.runningOf(key, chatId) };
    }
    /** @type {Map<string, [string, any]>} */
    const heard = new Map();
    const reads = this.hearing.get(key) ?? new Set();
    this.hearing.set(key, reads.add(heard));
    try {
      const { id } = await openHistory(await source(), chatId, cwd, key);
      try {
        this.o.flush(chatId);
        const running = this.runningOf(key, chatId);
        const emits = [...heard.values()];
        const page = settleHistory(id, { live: running ?? false, emits, stream: this.get(key)?.id, limit, before });
        this.hold(key, id, page.older);
        return { ...page, activeTurnId: running };
      } catch (error) {
        // nothing else knows this read: the core's reads are few, and one left open stays open
        releaseHistory(id);
        throw error;
      }
    } finally {
      reads.delete(heard);
      if (!reads.size) this.hearing.delete(key);
    }
  }

  /** Keep read `id` of session `key` for its next page, if it has one. */
  hold(key, id, older) {
    this.release(key);
    if (!older) return releaseHistory(id);
    const timer = this.o.timers.set(() => this.release(key), KEEP_MS);
    /** @type {any} */ (timer).unref?.();
    this.held.set(key, { id, timer });
    if (this.held.size > MAX_HELD) this.release(/** @type {string} */ (this.held.keys().next().value));
  }

  /** Let go of the read held for session `key`. */
  release(key) {
    const held = this.held.get(key);
    if (!held) return;
    this.o.timers.clear(held.timer);
    this.held.delete(key);
    releaseHistory(held.id);
  }

  /** The turn `chatId`'s session `key` is running. @param {string} key @param {string} chatId */
  runningOf(key, chatId) {
    return this.o.nativeOf(chatId) === key ? (this.get(key)?.turnId ?? null) : null;
  }

  /**
   * A turn a machine kept running while this app was closed (`partway`: where its transcript is, which
   * electron/host/remoteChats.cjs has written out): what it did so far is only there, so the translator goes on from where
   * that ends and its next items don't reuse the ids the transcript gave out, whenever a window reads it. The core reads it
   * on one of its threads, however long the turn is, and what the session says to the windows meanwhile waits for it in
   * `following`, in order (`acpSender`), as a translator not there yet can't say it.
   * @param {string} key @param {string} chatId @param {string} turnId @param {{ file: string, extra: any[] }} source
   */
  async followTranscript(key, chatId, turnId, source) {
    /** @type {(() => void)[]} */
    const waiting = [];
    this.following.set(key, waiting);
    const cwd = this.o.cwdOf(key) ?? '';
    try {
      const { id } = await openHistory(source, chatId, cwd, key);
      const translator = keepHistory(id, turnId, chatId, cwd, (method, params) => this.say(chatId, key, method, params));
      if (translator) {
        this.entries.get(key)?.translator.close();
        this.entries.set(key, { chatId, translator });
      }
    } catch (error) {
      // the session goes on with the translator that began the turn
      noteIgnored("follow a turn from a chat's transcript", error);
    }
    this.following.delete(key);
    for (const go of waiting) {
      try {
        go();
      } catch (error) {
        noteIgnored("send on what waited for a chat's transcript", error);
      }
    }
  }
}

/**
 * How ACP events reach the windows (electron/app/windows.cjs): `send` passes each on, translating an event for every
 * window here first, its items going out before it and the event carrying what the windows still decide from it
 * (AcpItems.onEvent), never a transcript it carried for main (`partway`); `items` is the translation (main's acp:turns).
 * A delta the stream batcher sends again for the windows that have its chat in the background (`scope.background`,
 * electron/harness/coreBatcher.cjs) is the same delta, translated once already.
 * @param {Parameters<typeof AcpItems.of>[0]} live
 * @param {(channel: string, event: any, target?: any, scope?: any) => boolean} sendToWindows
 * @param {(chatId: string) => void} [flush] sends on what the stream batcher still holds of a chat
 */
function acpSender(live, sendToWindows, flush) {
  const items = AcpItems.of(live, (chatId, key, method, params) => sendToWindows('acp:items', { chatId, key, method, params }), flush);
  /** @param {any} event @param {any} [target] @param {any} [scope] @returns {boolean} */
  function send(event, target, scope) {
    const following = items.following.get(event?.key);
    if (following) return following.push(() => send(event, target, scope)) > 0;
    const known = target === undefined && !scope?.background ? items.onEvent(event) : null;
    const told = event?.partway ? { ...event, partway: undefined } : event;
    return sendToWindows('acp:event', known ? { ...told, ...known } : told, target, scope);
  }
  return { send, items };
}

module.exports = { AcpItems, acpSender, STRAY_MS };
