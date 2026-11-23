// MoMo's index of its past chats (#2999 P1, the episodic memory layer): one chunk per question and answer of a MoMo chat (the main chat, earlier main chats, routine runs; never a coding chat), in an in-memory SQLite FTS5 table whose terms are memoryFacts.cjs words() (Chinese, Japanese and Korean as character pairs), saved sealed at rest (<momo dir>/history/index.sqlite.enc, platform/sealedFile.cjs) in an owner-only folder. A chunk's search aliases (aliases.cjs, written later by historyAliases.cjs) are matched with its words but never returned. Without encryption it is kept for this run only, never written in plain text; a saved index that can't be opened (another key) turns it off and is never written over. search() ranks by bm25, a routine run's chunk below the user's own chats, then newer first.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { SealedFile } = require('../platform/sealedFile.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { words } = require('./memoryFacts.cjs');

/** How long after a change the index is saved. */
const SAVE_MS = 2000;
/** A routine run's chunk counts this much of a chunk from the user's own chats. */
const ROUTINE_WEIGHT = 0.5;
/** The most chunks bm25 hands to the final ranking. */
const CANDIDATES = 50;
/** The longest text kept for one side of a chunk. */
const MAX_SIDE = 4000;

/**
 * @typedef {'main' | 'previous' | 'routine'} ChatKind which MoMo chat a chunk came from
 * @typedef {{ chatId: string, turnId: string, at: number, harness: string, kind: ChatKind, user: string, assistant: string }} Chunk
 * @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage
 */

const KINDS = new Set(['main', 'previous', 'routine']);
const side = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.trim().slice(0, MAX_SIDE) : '');

/** The FTS5 query for `query`: each of its words() as a quoted term, any of them; '' when it has none. */
function matchOf(/** @type {unknown} */ query) {
  const terms = [...new Set(words(String(query ?? '')))];
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

class HistoryIndex {
  /**
   * @param {{ dir: string, safeStorage?: SafeStorage | null, saveMs?: number, open?: (file: string) => any }} o
   *   dir: the index's own folder (<momo dir>/history); open: opens a database (node:sqlite), for tests
   */
  constructor({ dir, safeStorage = null, saveMs = SAVE_MS, open }) {
    this.dir = dir;
    this.saveMs = saveMs;
    this.open = open ?? ((/** @type {string} */ f) => new (require('node:sqlite').DatabaseSync)(f));
    this.sealed = new SealedFile({
      file: path.join(dir, 'index.sqlite.enc'),
      keyFile: path.join(dir, 'index.key'),
      safeStorage,
      what: "MoMo's index of its chats",
    });
    /** @type {any | null | false} false once opening failed: the index is off for this run */
    this.db = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    this.dirty = false;
  }

  #handle() {
    if (this.db !== null) return this.db || null;
    try {
      // a saved index that can't be opened (another key, damage) throws: the index is off, and its file is left alone
      const saved = this.sealed.read();
      const db = this.open(':memory:');
      if (saved) db.deserialize(saved);
      db.exec(
        `CREATE TABLE IF NOT EXISTS chunks (
           id INTEGER PRIMARY KEY,
           chat_id TEXT NOT NULL,
           turn_id TEXT NOT NULL,
           at INTEGER NOT NULL,
           harness TEXT NOT NULL,
           kind TEXT NOT NULL,
           user TEXT NOT NULL,
           assistant TEXT NOT NULL,
           UNIQUE (chat_id, turn_id)
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(body);
         CREATE TABLE IF NOT EXISTS aliases (id INTEGER PRIMARY KEY, text TEXT NOT NULL);`,
      );
      this.db = db;
    } catch (error) {
      noteIgnored("open MoMo's index of its chats", error);
      this.db = false;
    }
    return this.db || null;
  }

  /** Whether the index works this run. */
  available() {
    return this.#handle() !== null;
  }

  /** The turns of `chatId` already in the index. @returns {Set<string>} */
  indexedTurns(/** @type {string} */ chatId) {
    const db = this.#handle();
    if (!db) return new Set();
    return new Set(
      db
        .prepare('SELECT turn_id FROM chunks WHERE chat_id = ?')
        .all(chatId)
        .map((/** @type {any} */ r) => r.turn_id),
    );
  }

  /**
   * Adds the chunks not in the index yet (a chat and turn already there is left as it is); returns how many were added.
   * @param {Chunk[]} chunks
   */
  add(chunks) {
    const db = this.#handle();
    if (!db) return 0;
    const insert = db.prepare(
      'INSERT OR IGNORE INTO chunks (chat_id, turn_id, at, harness, kind, user, assistant) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const term = db.prepare('INSERT INTO terms (rowid, body) VALUES (?, ?)');
    let added = 0;
    for (const c of chunks) {
      const user = side(c.user);
      const assistant = side(c.assistant);
      if (!c.chatId || !c.turnId || (!user && !assistant)) continue;
      const kind = KINDS.has(c.kind) ? c.kind : 'main';
      const r = insert.run(c.chatId, c.turnId, Math.floor(c.at) || 0, String(c.harness ?? ''), kind, user, assistant);
      if (!r.changes) continue;
      term.run(r.lastInsertRowid, words(`${user}\n${assistant}`).join(' '));
      added++;
    }
    if (added) this.#changed();
    return added;
  }

  /**
   * The newest chunks with no aliases yet (none written, none tried), for the aliases' writer.
   * @param {number} limit
   * @returns {{ chatId: string, turnId: string, user: string, assistant: string }[]}
   */
  needingAliases(limit) {
    const db = this.#handle();
    if (!db) return [];
    return db
      .prepare(
        `SELECT c.chat_id, c.turn_id, c.user, c.assistant FROM chunks c LEFT JOIN aliases a ON a.id = c.id
          WHERE a.id IS NULL ORDER BY c.at DESC, c.id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit)))
      .map((/** @type {any} */ r) => ({ chatId: r.chat_id, turnId: r.turn_id, user: r.user, assistant: r.assistant }));
  }

  /**
   * Sets each chunk's aliases ('' marks one tried with none to add) and matches them with its words from now on; a chunk
   * no longer in the index (its chat was deleted, or Reset) is skipped. Returns how many were set.
   * @param {{ chatId: string, turnId: string, aliases: string }[]} list
   */
  setAliases(list) {
    const db = this.#handle();
    if (!db) return 0;
    const find = db.prepare('SELECT id, user, assistant FROM chunks WHERE chat_id = ? AND turn_id = ?');
    const put = db.prepare('INSERT OR REPLACE INTO aliases (id, text) VALUES (?, ?)');
    const drop = db.prepare('DELETE FROM terms WHERE rowid = ?');
    const term = db.prepare('INSERT INTO terms (rowid, body) VALUES (?, ?)');
    let set = 0;
    for (const a of list) {
      const row = /** @type {any} */ (find.get(a.chatId, a.turnId));
      if (!row) continue;
      const text = typeof a.aliases === 'string' ? a.aliases : '';
      put.run(row.id, text);
      drop.run(row.id);
      term.run(row.id, words(`${row.user}\n${row.assistant}\n${text}`).join(' '));
      set++;
    }
    if (set) this.#changed();
    return set;
  }

  /** Takes a chat out of the index (it was deleted). */
  removeChat(/** @type {string} */ chatId) {
    const db = this.#handle();
    if (!db) return;
    const ids = db.prepare('SELECT id FROM chunks WHERE chat_id = ?').all(chatId);
    if (!ids.length) return;
    const drop = db.prepare('DELETE FROM terms WHERE rowid = ?');
    const unalias = db.prepare('DELETE FROM aliases WHERE id = ?');
    for (const r of ids) {
      drop.run(r.id);
      unalias.run(r.id);
    }
    db.prepare('DELETE FROM chunks WHERE chat_id = ?').run(chatId);
    this.#changed();
  }

  /**
   * The chunks that share words with `query`, the best first: bm25, a routine run's chunk weighted below the user's own
   * chats, then newer. Nothing for a query with no words.
   * @param {unknown} query
   * @param {{ limit?: number, excludeChat?: string }} [o] excludeChat: the asking chat, whose turns it already has
   * @returns {Chunk[]}
   */
  search(query, { limit = 5, excludeChat } = {}) {
    const db = this.#handle();
    const match = matchOf(query);
    if (!db || !match) return [];
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 5;
    const rows = db
      .prepare(
        `SELECT c.chat_id, c.turn_id, c.at, c.harness, c.kind, c.user, c.assistant, bm25(terms) AS rank
           FROM terms JOIN chunks c ON c.id = terms.rowid
          WHERE terms MATCH ? ORDER BY rank LIMIT ${CANDIDATES}`,
      )
      .all(match)
      .filter((/** @type {any} */ r) => r.chat_id !== excludeChat)
      .map((/** @type {any} */ r) => ({ r, score: -r.rank * (r.kind === 'routine' ? ROUTINE_WEIGHT : 1) }));
    rows.sort((a, b) => b.score - a.score || b.r.at - a.r.at);
    return rows.slice(0, n).map(({ r }) => ({
      chatId: r.chat_id,
      turnId: r.turn_id,
      at: r.at,
      harness: r.harness,
      kind: r.kind,
      user: r.user,
      assistant: r.assistant,
    }));
  }

  /**
   * The newest chunks of the chats named, newest first, at most `limit` (Everything in MoMo's rail, A2): null when the index can't be read now.
   * @param {string[]} chatIds @param {number} limit
   * @returns {{ chatId: string, turnId: string, at: number, user: string, assistant: string }[] | null}
   */
  recent(chatIds, limit) {
    const db = this.#handle();
    if (!db) return null;
    if (!chatIds.length) return [];
    return db
      .prepare(
        `SELECT chat_id, turn_id, at, user, assistant FROM chunks
          WHERE chat_id IN (${chatIds.map(() => '?').join(',')}) ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(...chatIds, limit)
      .map((/** @type {any} */ r) => ({ chatId: r.chat_id, turnId: r.turn_id, at: r.at, user: r.user, assistant: r.assistant }));
  }

  /** How many chunks the index holds. */
  count() {
    const db = this.#handle();
    return db ? db.prepare('SELECT count(*) AS n FROM chunks').get().n : 0;
  }

  #changed() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.saveMs);
    this.timer.unref?.();
  }

  /** Saves the index sealed now when it changed; without encryption it stays in memory. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.db || !this.sealed.available()) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      this.sealed.write(this.db.serialize());
      this.dirty = false;
    } catch (error) {
      noteIgnored("save MoMo's index of its chats", error);
    }
  }

  /** Reset MoMo: the index is emptied and its folder deleted; it is made again on the next change. */
  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.db) this.db.close();
    this.db = null;
    this.dirty = false;
    this.sealed = new SealedFile({
      file: this.sealed.file,
      keyFile: this.sealed.keyFile,
      safeStorage: this.sealed.safe,
      what: this.sealed.what,
    });
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

module.exports = { HistoryIndex, matchOf, ROUTINE_WEIGHT, MAX_SIDE };
