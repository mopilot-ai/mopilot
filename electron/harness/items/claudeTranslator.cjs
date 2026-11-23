// Claude Code translation as main calls it: the translator is the Rust core's (core/crates/translate/src/claude), one per native
// session, and this holds its id, mirrors its turn and hands on what it says. Claude Code stays on its SDK, so a message
// reaches this as an object and goes across as JSON. An event's call is synchronous (`dispatchSync`), so what a translator
// emits is in order and out before the caller does anything else, as it was when the translator ran here.
const crypto = require('node:crypto');
const { core, requiredCore } = require('../../platform/core.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** @typedef {(method: string, params: any) => void} Emit */

/**
 * The reply of a translate route. The app does not run without the core (`coreProblem`, electron/platform/core.cjs).
 * @param {string} route @param {string} payload
 */
const translate = (route, payload) => requiredCore(core()).dispatchSync(route, Buffer.from(payload));

/**
 * `agent/items` with its list as the bytes the core wrote: a long sub-agent's whole transcript comes with each of its messages, and
 * only the window reads it, so this thread doesn't parse it.
 * @param {{ itemsAt: [number, number] }} params @param {Buffer} tail
 */
function placed({ itemsAt: [from, to], ...params }, tail) {
  return { ...params, items: tail.subarray(from, to) };
}

/** One thread's translator: one turn is one prompt through to its `result`. */
class ClaudeTranslator {
  /** @type {any} the turn running, or null */
  turnId = null;
  interrupted = false;
  /** its id in the core: opened with the first event, and again after a close */
  id = /** @type {number | null} */ (null);

  /**
   * @param {string} threadId @param {string} cwd @param {Emit} emit
   * @param {{ children?: boolean, sourceIds?: boolean }} [o] `children: false` when nothing shows a sub-agent's transcript: it isn't said at all
   */
  constructor(threadId, cwd, emit, { children = true, sourceIds = false } = {}) {
    this.threadId = threadId;
    this.folder = cwd;
    this.emit = emit;
    this.children = children;
    this.sourceIds = sourceIds;
  }

  /** The folder its tool items name: a turn that began before its CLI started (a resumed chat) learns it late. */
  get cwd() {
    return this.folder;
  }

  set cwd(cwd) {
    this.folder = cwd;
    if (this.id !== null) this.event('cwd', { cwd });
  }

  /** The core's id for this translator. */
  opened() {
    this.id ??= Number(
      String(
        translate(
          'translate.claudeOpen',
          JSON.stringify({
            threadId: this.threadId,
            cwd: this.folder,
            auto: crypto.randomUUID(),
            children: this.children,
            sourceIds: this.sourceIds,
          }),
        ),
      ),
    );
    return this.id;
  }

  /**
   * One event, with a message's JSON as a line after it. A failure costs the event and not the session, and whatever the event
   * said before it failed goes out as usual.
   * @param {string} op @param {Record<string, unknown>} [fields] @param {string} [message]
   */
  event(op, fields, message) {
    let reply;
    let tail;
    try {
      const head = JSON.stringify({ ...fields, id: this.opened(), now: Date.now(), op });
      const bytes = translate('translate.claudeEvent', message === undefined ? head : `${head}\n${message}`);
      const end = bytes.indexOf(10);
      reply = JSON.parse(String(bytes.subarray(0, end)));
      tail = bytes.subarray(end + 1);
    } catch (error) {
      noteIgnored('translate a Claude Code event', error);
      return;
    }
    this.turnId = reply.turnId;
    this.interrupted = reply.interrupted;
    for (const [method, params] of reply.emits) this.emit(method, method === 'agent/items' ? placed(params, tail) : params);
    if (reply.thrown) noteIgnored('translate a Claude Code event', new Error(reply.thrown));
  }

  /** @param {unknown} message one of the SDK's messages */
  onMessage(message) {
    let line;
    try {
      line = JSON.stringify(message);
    } catch (error) {
      noteIgnored('read a Claude Code event', error);
      return;
    }
    this.event('message', undefined, line);
  }

  /** @param {unknown} turnId @param {unknown} [user] */
  beginTurn(turnId, user) {
    this.event('begin', { turnId, user });
  }

  /** @param {string} status @param {unknown} [error] */
  endTurn(status, error) {
    this.event('end', { status, error });
  }

  /** A message injected into the running turn; its own `result` follows the current one. */
  addSteer() {
    this.event('steer');
  }

  /** A steer that never reached Claude. */
  dropSteer() {
    this.event('dropSteer');
  }

  /** After an interrupt the CLI drops queued prompts, so the next `result` ends the turn. */
  markInterrupted() {
    this.event('interrupt');
  }

  /** The session went: the core lets its state go, and a later event would start this translator afresh. */
  close() {
    if (this.id === null) return;
    translate('translate.claudeClose', String(this.id));
    this.id = null;
    this.turnId = null;
    this.interrupted = false;
  }
}

module.exports = { ClaudeTranslator };
