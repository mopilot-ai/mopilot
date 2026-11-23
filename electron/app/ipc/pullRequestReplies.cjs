// IPC and main's store for the sidebar PR badges' saved replies (<userData>/pull-request-replies.json): each chat's few
// replies that bear on a pull request, kept by the history version they were read at, so a launch reads no unchanged
// chat's whole history again for its badge. Bounded, written a few seconds after a change and in full at quit.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { readJsonRecord, writeAtomic, writeAtomicAsync } = require('../../platform/fsutil.cjs');
const { addHook } = require('../../session/hookChain.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** The whole file's budget: the chats shown least recently go first. */
const MAX_BYTES = 4 * 1024 * 1024;
/** A chat whose PR replies are longer than this is read from its history each launch rather than kept. */
const MAX_ENTRY_BYTES = 64 * 1024;
/** How long after a change the file is written (a sidebar filling saves many chats: one write for all of them). */
const WRITE_MS = 3000;
const MAX_KEY = 512;

const validKey = (/** @type {unknown} */ s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_KEY;

/**
 * Reply turns as the badge reads them (src/lib/responsePullRequest.ts pullRequestReplies): completed, each item's type,
 * text and phase only, plus the turn's completion time. Null when they are not that shape.
 * @param {unknown} replies
 */
function cleanReplies(replies) {
  if (!Array.isArray(replies)) return null;
  const out = [];
  for (const turn of replies) {
    if (turn?.status !== 'completed' || !Array.isArray(turn.items)) return null;
    const items = [];
    for (const item of turn.items) {
      if (typeof item?.type !== 'string' || (item.text !== undefined && typeof item.text !== 'string')) return null;
      items.push({ type: item.type, text: item.text, phase: typeof item.phase === 'string' ? item.phase : null });
    }
    const { completedAt } = turn;
    out.push({ status: 'completed', items, ...(typeof completedAt === 'number' && Number.isFinite(completedAt) ? { completedAt } : {}) });
  }
  return out;
}

/** @typedef {{ version: string, replies: NonNullable<ReturnType<typeof cleanReplies>>, bytes: number }} Entry */

class SavedReplies {
  /**
   * @param {object} o
   * @param {() => string} o.file read when the store first loads or writes: main sets userData after making this
   * @param {{ readFile?: typeof readJsonRecord, write?: typeof writeAtomic, writeAsync?: typeof writeAtomicAsync, setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout }} [o.io]
   */
  constructor(o) {
    this.file = o.file;
    this.readFile = o.io?.readFile ?? readJsonRecord;
    this.write = o.io?.write ?? writeAtomic;
    this.writeAsync = o.io?.writeAsync ?? writeAtomicAsync;
    this.setTimer = o.io?.setTimer ?? setTimeout;
    this.clearTimer = o.io?.clearTimer ?? clearTimeout;
    /** Counts the writes started: a quit flush or a newer write outdates one still on its way. */
    this.seq = 0;
    /** @type {Map<string, Entry>} the chat shown least recently first; loaded on first use */
    this.map = new Map();
    this.loadedOnce = false;
    this.total = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
  }

  /** @returns {Map<string, Entry>} */
  loaded() {
    if (this.loadedOnce) return this.map;
    this.loadedOnce = true;
    const saved = this.readFile(this.file(), null);
    const chats = saved?.v === 1 && saved.chats && typeof saved.chats === 'object' ? saved.chats : {};
    for (const [id, e] of Object.entries(chats)) if (validKey(id) && validKey(e?.version)) this.keep(id, e.version, e.replies);
    return this.map;
  }

  /**
   * Holds the chat's replies in memory as its newest entry; false when they are not kept (not replies, or too long).
   * @param {string} id @param {string} version @param {unknown} replies
   */
  keep(id, version, replies) {
    this.drop(id);
    const clean = cleanReplies(replies);
    const bytes = clean ? Buffer.byteLength(JSON.stringify(clean)) + version.length : Infinity;
    if (!clean || bytes > MAX_ENTRY_BYTES) return false;
    this.map.set(id, { version, replies: clean, bytes });
    this.total += bytes;
    while (this.total > MAX_BYTES) this.drop(/** @type {string} */ (this.map.keys().next().value));
    return true;
  }

  /** @param {string} id */
  drop(id) {
    const e = this.map.get(id);
    if (!e) return false;
    this.map.delete(id);
    this.total -= e.bytes;
    return true;
  }

  /**
   * The chat's replies saved at this version, or null; a chat asked for is kept longest.
   * @param {string} id @param {string} version
   */
  get(id, version) {
    const map = this.loaded();
    const e = map.get(id);
    if (!e || e.version !== version) return null;
    map.delete(id);
    map.set(id, e);
    return e.replies;
  }

  /**
   * Saves the chat's replies read at this version, in place of any it had; whether they were kept.
   * @param {string} id @param {string} version @param {unknown} replies
   */
  put(id, version, replies) {
    const had = this.loaded().has(id);
    const kept = this.keep(id, version, replies);
    if (kept || had) this.schedule();
    return kept;
  }

  /** A deleted chat's replies go from memory and the file. @param {string} id */
  forget(id) {
    this.loaded();
    if (this.drop(id)) this.schedule();
  }

  schedule() {
    this.timer ??= this.setTimer(() => this.save(), WRITE_MS);
  }

  /** The timer fired: the file is written without holding up the main thread. */
  save() {
    this.timer = null;
    const n = ++this.seq;
    this.writeAsync(this.file(), this.bytes(), () => n === this.seq).catch((error) => {
      // a launch without the file reads the histories again
      noteIgnored("save the PR badges' replies", error);
    });
  }

  bytes() {
    const chats = Object.fromEntries([...this.map].map(([id, e]) => [id, { version: e.version, replies: e.replies }]));
    return JSON.stringify({ v: 1, chats });
  }

  /** Write what changed now (at quit): a write still on its way is outdated by it. */
  flush() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.seq++;
    try {
      this.write(this.file(), this.bytes(), fs);
    } catch (error) {
      noteIgnored("save the PR badges' replies", error);
    }
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; chats.cjs (registered before this,
 *   in name order) sets live.chatDeletion
 * @param {SavedReplies} [store]
 */
function register(
  ipcMain,
  deps,
  store = new SavedReplies({ file: () => path.join(deps.app.getPath('userData'), 'pull-request-replies.json') }),
) {
  const { app, live } = deps;
  ipcMain.handle('pullRequests:savedReplies', (_e, id, version) => (validKey(id) && validKey(version) ? store.get(id, version) : null));
  ipcMain.handle(
    'pullRequests:saveReplies',
    (_e, id, version, replies) => validKey(id) && validKey(version) && store.put(id, version, replies),
  );
  if (!live.chatDeletion) throw new Error('ipc/pullRequestReplies registers after ipc/chats, which makes the chat deletion');
  addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string }} */ receipt) => store.forget(receipt.chatId));
  app.on('will-quit', () => store.flush());
  return store;
}

module.exports = { register, SavedReplies, cleanReplies, MAX_BYTES, MAX_ENTRY_BYTES, WRITE_MS };
