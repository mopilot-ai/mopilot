// ACP translation as main calls it: the translator is the Rust core's (core/crates/translate), one per native session, and this
// holds its id, mirrors its turn and hands on what it says. An event's call is synchronous (`dispatchSync`), so what a
// translator emits is in order and out before the caller does anything else, as it was when the translator ran here: a
// window's items go ahead of the `acp:event` they came from, and of the batcher's next flush. No route waits on JS or a disk.
const crypto = require('node:crypto');
const { core, requiredCore } = require('../../platform/core.cjs');
const { labeled } = require('../../perf/stalls.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { historySource } = require('../acp/audio.cjs');
const { stopErrorText } = require('../../../shared/acpStop.mjs');

/**
 * @typedef {(method: string, params: any) => void} Emit
 * @typedef {{ id: number, turnId: unknown }} Held a translator the core already holds: a replay's, going on live
 */

/**
 * The reply of a translate route. `payload` goes as it is, since a transcript's isn't one JSON value. The app does not run
 * without the core (`coreProblem`, electron/platform/core.cjs).
 * @param {string} route @param {string} payload
 */
const translate = (route, payload) => String(requiredCore(core()).dispatchSync(route, Buffer.from(payload)));

/** One thread's translator: one turn is one session/prompt through to its stop reason. */
class AcpTranslator {
  /** @type {any} the turn running, or null */
  turnId = null;
  /** its id in the core: opened with the first event, and again after a close */
  id = /** @type {number | null} */ (null);

  /** @param {string} threadId @param {string} cwd @param {Emit} emit @param {Held} [held] */
  constructor(threadId, cwd, emit, held = undefined) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.emit = emit;
    if (held) ({ id: this.id, turnId: this.turnId } = held);
  }

  /** The core's id for this translator. */
  opened() {
    this.id ??= Number(translate('translate.open', JSON.stringify({ threadId: this.threadId, cwd: this.cwd, auto: crypto.randomUUID() })));
    return this.id;
  }

  /**
   * One event. A failure costs the event and not the session: an adapter is a third party, what it sends can be anything,
   * and whatever the event said before it failed goes out as usual.
   * @param {Record<string, unknown>} event
   */
  event(event) {
    let reply;
    try {
      reply = JSON.parse(translate('translate.event', JSON.stringify({ ...event, id: this.opened(), now: Date.now() })));
    } catch (error) {
      noteIgnored('translate an ACP event', error);
      return;
    }
    this.turnId = reply.turnId;
    for (const [method, params] of reply.emits) this.emit(method, params);
    if (reply.thrown) noteIgnored('translate an ACP event', new Error(reply.thrown));
  }

  /** @param {unknown} turnId @param {unknown} [user] */
  beginTurn(turnId, user) {
    this.event({ op: 'begin', turnId, user });
  }

  /**
   * One session/update. `turnId` is main's turn for it (null outside a prompt); `replaces` is the text of the open message it
   * replaces.
   * @param {unknown} update @param {unknown} [turnId] @param {unknown} [replaces]
   */
  onUpdate(update, turnId, replaces) {
    this.event({ op: 'update', update, turnId, replaces });
  }

  /** @param {unknown} stopReason @param {unknown} error @param {unknown} [providerError] */
  endTurn(stopReason, error, providerError) {
    this.event({ op: 'end', stopReason, error: stopErrorText(error), providerError });
  }

  /** Go on live from where a replay ended: later updates go to `emit`, their ids numbered after the replayed ones. @param {Emit} emit */
  continueLive(emit) {
    this.emit = emit;
  }

  /** The session went: the core lets its state go, and a later event would start this translator afresh. */
  close() {
    if (this.id === null) return;
    translate('translate.close', String(this.id));
    this.id = null;
    this.turnId = null;
  }
}

/**
 * The first line of what `translate.replay` takes; each record follows as a line. A record the core can't read is that line alone.
 * @param {string} threadId @param {string} cwd @param {{ live?: boolean | string, keep?: unknown }} opts
 */
const replayHeader = (threadId, cwd, opts) =>
  JSON.stringify({ threadId, cwd, auto: crypto.randomUUID(), live: opts.live, keep: !!opts.keep });

const replayLine = (/** @type {unknown} */ record) => JSON.stringify(record);

/**
 * Replay a chat's transcript into turns, in the core, which folds them too, holding the JS thread throughout: for a caller
 * that can't let another event of the session pass meanwhile. `opts.live` says the last turn is still running (true, or its
 * id), and `opts.keep` is given a translator that goes on from where the transcript ends.
 * @param {any[]} records @param {string} threadId @param {string} cwd
 * @param {{ live?: boolean | string, keep?: (tr: AcpTranslator) => void }} [opts]
 * @returns {any[]}
 */
function buildAcpTurns(records, threadId, cwd, opts = {}) {
  return labeled('acp.buildTurns', () => {
    const payload = [replayHeader(threadId, cwd, opts), ...records.map(replayLine)].join('\n');
    const { turns, id, turnId } = JSON.parse(translate('translate.replay', payload));
    const quiet = () => {
      /* nothing is said until continueLive names where it goes */
    };
    if (id !== undefined) opts.keep?.(new AcpTranslator(threadId, cwd, quiet, { id, turnId }));
    return turns;
  });
}

/**
 * The core reading a transcript's file on one of its threads: the read's id, for `settleHistory`, and the folder it read it
 * under. `auto` is the session's, so a turn with no prompt reads under one id every time.
 * @param {{ file: string, extra: any[], findCwd?: boolean, upTo?: number }} source @param {string} threadId @param {string} cwd @param {string} key
 * @returns {Promise<{ id: number, cwd: string | null }>}
 */
async function openHistory(source, threadId, cwd, key) {
  const header = JSON.stringify({ threadId, cwd, auto: key, ...source });
  /** @type {Buffer} */
  let reply;
  try {
    reply = await requiredCore(core()).dispatch('translate.read', Buffer.from(header));
  } catch (error) {
    noteIgnored("read a chat's transcript", error);
    throw new Error("This chat's history couldn't be read.");
  }
  const { id, unread, cwd: read } = JSON.parse(String(reply));
  // without the lines' text
  if (unread) noteIgnored("read a chat's transcript", `${unread} unreadable line${unread === 1 ? '' : 's'} skipped`);
  return { id, cwd: read };
}

/**
 * A page as the core gives it: a byte for whether there are older turns, a line of its turn ids, then its JSON, which goes
 * to the window unread.
 * @param {Buffer} reply
 */
function pageOf(reply) {
  const end = reply.indexOf(10);
  return { page: reply.subarray(end + 1), ids: JSON.parse(String(reply.subarray(1, end))), older: reply[0] === 49 };
}

/**
 * The first page of a read, with what its session said meanwhile: one step on this thread, so nothing can pass it.
 * @param {number} id @param {{ live: unknown, emits: any[], stream?: number | null, limit?: number, before?: string | null }} o
 */
const settleHistory = (id, { emits, ...o }) =>
  labeled('acp.buildTurns', () => {
    const lines = [JSON.stringify({ ...o, id }), ...emits.map((said) => JSON.stringify(said))];
    return pageOf(requiredCore(core()).dispatchSync('translate.settle', Buffer.from(lines.join('\n'))));
  });

/**
 * An older page of a read still held.
 * @param {number} id @param {{ limit?: number, before?: string | null }} o
 */
const historyPage = (id, o) =>
  labeled('acp.buildTurns', () => pageOf(requiredCore(core()).dispatchSync('translate.page', Buffer.from(JSON.stringify({ ...o, id })))));

/**
 * Every turn of a read, for a reader in main that has to have them as values. They come in slices of 4 MB, each
 * parsed in a tick of its own, so that the JS thread gives way between them however long the chat is.
 * @param {number} id @param {boolean | string} live
 * @returns {Promise<any[]>}
 */
async function historyTurns(id, live) {
  /** @type {any[]} */
  const turns = [];
  /** @type {[number, number] | null} */
  let at = [0, 0];
  let first = true;
  while (at) {
    await new Promise(setImmediate);
    const [turn, item] = at;
    const input = JSON.stringify({ id, turn, item, ...(first ? { live } : {}) });
    const { parts, next } = labeled('acp.buildTurns', () => JSON.parse(translate('translate.turns', input)));
    // a slice that stopped inside a turn goes on with it
    if (item > 0) for (const held of parts.shift().items) turns.at(-1).items.push(held);
    turns.push(...parts);
    at = next;
    first = false;
  }
  return turns;
}

/**
 * Every turn of a chat's transcript, read on a core thread, for a reader in main: its file's records never reach this
 * heap, and what it hands over crosses a slice at a time.
 * @param {any} host the ACP host (acp.cjs)
 * @param {string} key the chat's native session @param {string} threadId
 * @param {{ cwd?: string, find?: boolean, otherwise?: () => Promise<string | null | undefined>, live?: boolean | string }} [o]
 *   `find`: the folder the transcript names wins over `cwd`; `otherwise`: where to look when it names none and there is no `cwd`
 * @returns {Promise<{ turns: any[], cwd: string | null }>}
 */
async function readChatTurns(host, key, threadId, { cwd = '', find = false, otherwise, live = false } = {}) {
  const source = await historySource(host, key);
  let read = await openHistory({ ...source, findCwd: find }, threadId, cwd, key);
  if (!read.cwd && otherwise) {
    releaseHistory(read.id);
    read = await openHistory(source, threadId, (await otherwise()) ?? '', key);
  }
  try {
    return { turns: await historyTurns(read.id, live), cwd: read.cwd };
  } finally {
    releaseHistory(read.id);
  }
}

/**
 * The translator of the turn `turnId` a read found still running, going on from where its transcript ends; null when that
 * turn is over. The read goes with it.
 * @param {number} id @param {string} turnId @param {string} threadId @param {string} cwd @param {Emit} emit
 */
function keepHistory(id, turnId, threadId, cwd, emit) {
  const held = JSON.parse(translate('translate.keep', JSON.stringify({ id, live: turnId })));
  return held && new AcpTranslator(threadId, cwd, emit, held);
}

/** @param {number} id */
const releaseHistory = (id) => void translate('translate.release', String(id));

module.exports = { AcpTranslator, buildAcpTurns, openHistory, settleHistory, historyPage, releaseHistory, keepHistory, readChatTurns };
