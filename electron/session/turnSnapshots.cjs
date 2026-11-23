// What a Claude Code or ACP turn changed in its folder, from Git snapshots (electron/session/turnChanges.cjs), as a Codex turn's
// adapter takes them: begun when the prompt goes out, read again after each tool call, taken once more when the turn ends.
// A shell command's edits count as much as an edit tool's. Windows get each diff (session:turnDiff), and a transcript
// read back gets the saved ones.
const { clock } = require('../platform/ports/clock.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { turnKey } = require('../../shared/turnKey.mjs');
const { addHook } = require('./hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { TurnChanges } = require('./turnChanges.cjs');
const { createTurnCheckpoints } = require('./turnCheckpoints.cjs');
const { TurnDiffStore } = require('../platform/turnDiffStore.cjs');
const { labeled } = require('../perf/stalls.cjs');

/** How long after a tool call ends the turn's diff so far is read: a burst of calls reads once. */
const LIVE_DELAY_MS = 1000;
/** The same wait for a chat no window shows: its live diff is read late, and only if someone has opened it by then. */
const HIDDEN_DELAY_MS = 8000;
/** How many live reads (each a handful of git spawns) run at once across all chats; the rest wait their turn. */
const MAX_LIVE_READS = 2;

/**
 * Main's one TurnChanges, for every harness's turns (the Codex adapter's and these), so turns in one folder see each
 * other; their diffs are kept in `dir` (the file keeps the name of its first user, Codex).
 * @param {string} dir
 */
function savedTurnChanges(dir) {
  // one file per chat, so a turn's end writes that chat's diffs and not every chat's; the old whole-store file is moved in
  const store = new TurnDiffStore(path.join(dir, 'turn-diffs'), path.join(dir, 'codex-turn-diffs.json'), noteIgnored, labeled);
  const changes = new TurnChanges(undefined, undefined, store);
  // each turn's start tree, kept so a rewind can bring the files back (turnCheckpoints.cjs)
  changes.checkpoints = createTurnCheckpoints({
    capture: (scope) => changes.capture(scope),
    busy: (cwd) => changes.busyAt(cwd),
    shareWith: (cwd) => changes.shareAt(cwd),
  });
  return changes;
}

/**
 * @typedef {{ key: string, turnId: string | null, timer: ReturnType<typeof setTimeout> | null, reading: boolean,
 *   again: boolean, shown: boolean, liveRead?: Promise<string | undefined> | null, sent: string | null }} Snapshot shown: a live diff went to windows; sent: its hash
 */

/** Per chat, the turn being snapshotted: its native session key and its live read. */
class TurnSnapshots {
  /**
   * @param {object} o
   * @param o.changes the TurnChanges the Codex adapter uses too: turns in one folder on any harness see each other
   * @param o.publish ({ chatId, turnId, diff }, live?) => void: to windows (a live one only to those showing the chat); diff null takes back a live one
   * @param o.state SessionStore: the chat's running turn, whose live diff a read is
   * @param [o.delayMs]
   * @param [o.hiddenDelayMs]
   * @param [o.maxReads] live reads at once, over every chat
   * @param [o.shows] (chatId) => boolean: whether a window shows the chat; without it every chat counts as shown
   * @param [o.followed] (chatId) => boolean: whether a paired phone follows the chat, which also makes its live diff worth reading
   */
  constructor(o) {
    this.changes = o.changes;
    this.publish = o.publish;
    this.state = o.state;
    this.delayMs = o.delayMs ?? LIVE_DELAY_MS;
    this.hiddenDelayMs = o.hiddenDelayMs ?? HIDDEN_DELAY_MS;
    this.maxReads = o.maxReads ?? MAX_LIVE_READS;
    this.shows = o.shows ?? (() => true);
    this.followed = o.followed ?? (() => false);
    /** @type {Set<(change: { chatId: string, turnId: string, live: boolean, removed: boolean }) => void>} */
    this.listeners = new Set();
    /** live reads running now, and the ones waiting for a place */
    this.active = 0;
    /** @type {(() => void)[]} */
    this.waiting = [];
    /** @type {Map<string, Snapshot>} */
    this.turns = new Map();
    /** native session key -> the folder its last prompt worked in */
    this.folders = new Map();
  }

  /** The ChatController's turn ends reach the snapshots: a finished turn's diff, and none for a crashed one. */
  attach(controller) {
    controller.turnSnapshots = this;
    addHook(controller, 'onFinished', (e) => {
      this.finished(e).catch((error) => noteIgnored("capture a turn's changes", error));
    });
    addHook(controller, 'onCrash', (chatId) => this.crashed(chatId));
  }

  /**
   * A prompt of the chat went out on its native session `key`, working in `cwd` (a steer that became the next turn names
   * none: the session's last folder). A turn whose folder is unknown is not snapshotted, so it can't void other folders'.
   * `turnId`: the turn's own id when the prompt names it (the controller may still know it as pending-<queue item>).
   */
  /** @param {string} chatId @param {string} key @param {string | undefined} cwd @param {string | null} [turnId] */
  begin(chatId, key, cwd, turnId = null) {
    this.retire(chatId);
    if (cwd) this.folders.set(key, cwd);
    cwd = this.folders.get(key);
    if (!cwd) return;
    this.turns.set(chatId, { key, turnId, timer: null, reading: false, again: false, shown: false, sent: null });
    // the prompt goes out alongside it: a tool call that starts before it is taken leaves the turn to its items
    this.changes.begin(key, cwd).catch((error) => noteIgnored("snapshot a turn's folder", error));
  }

  /** A tool call of the chat's turn on `key` started (it may write) or ended (the turn's diff so far is read soon). */
  tool(chatId, key, started) {
    // one between turns too (a background agent's): the last turn's final snapshot may still be taken
    if (started) return void this.changes.itemStarted(key, { type: 'toolCall' });
    const t = this.turns.get(chatId);
    if (t && t.key === key) this.schedule(chatId, t);
  }

  /** A Claude Code SDK message on `key`: its tool_use blocks start tool calls, a tool_result ends one. */
  claudeMessage(chatId, key, m) {
    const blocks = Array.isArray(m?.message?.content) ? m.message.content : [];
    if (m?.type === 'assistant' && blocks.some((b) => b?.type === 'tool_use')) this.tool(chatId, key, true);
    if (m?.type === 'user' && blocks.some((b) => b?.type === 'tool_result')) this.tool(chatId, key, false);
  }

  /** An ACP session/update on `key`: a tool_call starts one, a completed or failed one ends it. */
  acpUpdate(chatId, key, u) {
    if (u?.sessionUpdate !== 'tool_call' && u?.sessionUpdate !== 'tool_call_update') return;
    if (u.sessionUpdate === 'tool_call') this.tool(chatId, key, true);
    if (u.status === 'completed' || u.status === 'failed') this.tool(chatId, key, false);
  }

  /** @param {string} chatId @param {Snapshot} t */
  schedule(chatId, t) {
    if (t.reading) t.again = true;
    else if (!t.timer) {
      t.timer = clock.setTimeout(() => void this.read(chatId, t), this.watching(chatId) ? this.delayMs : this.hiddenDelayMs);
      t.timer.unref?.();
    }
  }

  /**
   * Tells the windows a turn's diff, and then whoever listens (a paired phone's review).
   * @param {{ chatId: string, turnId: string, diff: string | null }} d @param {boolean} [live]
   */
  emit(d, live) {
    try {
      this.publish(d, live);
    } catch (error) {
      // the windows' sink failing leaves the listeners their change
      noteIgnored("tell the windows a turn's diff", error);
    }
    for (const listener of this.listeners) {
      try {
        listener({ chatId: d.chatId, turnId: d.turnId, live: live === true, removed: d.diff === null });
      } catch (error) {
        noteIgnored("tell a listener about a turn's diff", error);
      }
    }
  }

  /** A listener for each diff the windows are told (a running turn's, a finished one's, or one taken back); returns how to stop. @param {(change: { chatId: string, turnId: string, live: boolean, removed: boolean }) => void} fn */
  onChange(fn) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Whether a window shows the chat, or a phone follows it (a failing lookup counts as shown: the diff is worth more than the git spawns). @param {string} chatId */
  watching(chatId) {
    try {
      return this.shows(chatId) || this.followed(chatId);
    } catch (error) {
      noteIgnored('read whether a window shows a chat', error);
      return true;
    }
  }

  /** Wait for one of the global live-read places. */
  async acquire() {
    if (this.active < this.maxReads) return void this.active++;
    // the place is handed over, not freed, so a waiter is never overtaken by a later read
    await new Promise((resolve) => this.waiting.push(() => resolve(undefined)));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * The turn's diff so far, to the windows that show the chat unless the turn ended meanwhile, no window shows the chat any
   * more (the next tool call reads again) or it is what they already have. At most `maxReads` run at once.
   * @param {string} chatId @param {Snapshot} t
   */
  async read(chatId, t) {
    t.timer = null;
    t.reading = true;
    let diff;
    try {
      await this.acquire();
      try {
        if (this.turns.get(chatId) === t && this.watching(chatId)) diff = await this.changes.peek(t.key);
      } finally {
        this.release();
      }
    } catch (error) {
      noteIgnored("read a running turn's changes", error);
    } finally {
      t.reading = false;
    }
    if (this.turns.get(chatId) !== t) return;
    const turnId = this.turnIdOf(chatId, t);
    if (diff !== undefined && turnId) {
      const hash = createHash('sha1').update(diff).digest('hex');
      if (hash !== t.sent) {
        t.sent = hash;
        t.shown = true;
        this.emit({ chatId, turnId, diff }, true);
      }
    }
    if (t.again) {
      t.again = false;
      this.schedule(chatId, t);
    }
  }

  /**
   * The chat's turn ended: its final snapshot, kept under the turn and sent to windows. One that can't say (it overlapped
   * another turn, it failed) takes back a live diff, so the turn reads from its items as it does read back.
   */
  async finished(e) {
    const t = this.turns.get(e.chatId);
    if (!t) return;
    this.retire(e.chatId);
    const turnId = t.turnId ?? e.turnId;
    const diff = await this.changes.finish(t.key, turnId ? turnKey(turnId) : undefined);
    if (!turnId) return;
    if (diff !== undefined) this.emit({ chatId: e.chatId, turnId, diff });
    else if (t.shown) this.emit({ chatId: e.chatId, turnId, diff: null });
  }

  /** The chat's harness went away mid-turn: no diff, the turn keeps what its items say. */
  crashed(chatId) {
    const t = this.turns.get(chatId);
    if (!t) return;
    this.retire(chatId);
    this.changes.abort(t.key);
    const turnId = this.turnIdOf(chatId, t);
    if (t.shown && turnId) this.emit({ chatId, turnId, diff: null });
  }

  /**
   * The chat's running turn and what it has changed so far, read now (a phone's review); undefined when no turn is
   * snapshotted, its snapshot can't say, or the turn ended or was replaced while it was read.
   * @param {string} chatId
   * @returns {Promise<{ turnId: string, diff: string } | undefined>}
   */
  async liveDiff(chatId) {
    const t = this.turns.get(chatId);
    if (!t) return undefined;
    // reads for one turn share a snapshot, and every read waits for a slot like the windows' own (`maxReads` at once)
    t.liveRead ??= this.peekLive(t).finally(() => {
      t.liveRead = null;
    });
    const diff = await t.liveRead;
    const turnId = this.turnIdOf(chatId, t);
    return diff === undefined || !turnId || this.turns.get(chatId) !== t ? undefined : { turnId, diff };
  }

  /** One snapshot read of the turn, once a slot is free. @param {Snapshot} t */
  async peekLive(t) {
    await this.acquire();
    try {
      return await this.changes.peek(t.key);
    } finally {
      this.release();
    }
  }

  /**
   * The turn's own id, else the one the controller knows it by (a Claude Code prompt that named no uuid).
   * @param {string} chatId @param {Snapshot} t
   */
  turnIdOf(chatId, t) {
    return t.turnId ?? (this.state.has(chatId) ? this.state.get(chatId).activeTurn?.id : null);
  }

  /** @param {string} chatId */
  retire(chatId) {
    const t = this.turns.get(chatId);
    if (t?.timer) clock.clearTimeout(t.timer);
    this.turns.delete(chatId);
  }

  /**
   * What each of these turns of `key` changed, by turn id, for those that saved any.
   * @param {string} key
   * @param {string[]} turnIds
   * @returns {Record<string, string>}
   */
  savedOf(key, turnIds) {
    /** @type {Record<string, string>} */
    const diffs = {};
    for (const id of turnIds) {
      const diff = this.changes.saved(key, turnKey(id));
      if (diff !== undefined) diffs[id] = diff;
    }
    return diffs;
  }

  /**
   * Turns read back from the transcript of `key`, with each one's saved diff.
   * @template {{ id: string }} T
   * @param {string} key
   * @param {T[]} turns
   * @returns {T[]}
   */
  restore(key, turns) {
    return turns.map((turn) => {
      const diff = this.changes.saved(key, turnKey(turn.id));
      return diff === undefined ? turn : { ...turn, diff };
    });
  }

  /**
   * What each of these turns changed in its folder, by turn id: a page of a Claude Code transcript's turns (claude:turns), which
   * goes to the window as bytes and has them laid on there.
   * @param {string} key @param {string[]} ids
   * @returns {Record<string, string>}
   */
  savedDiffs(key, ids) {
    /** @type {Record<string, string>} */
    const diffs = {};
    for (const id of ids) {
      const diff = this.changes.saved(key, turnKey(id));
      if (diff !== undefined) diffs[id] = diff;
    }
    return diffs;
  }
}

module.exports = { TurnSnapshots, savedTurnChanges, LIVE_DELAY_MS, HIDDEN_DELAY_MS, MAX_LIVE_READS };
