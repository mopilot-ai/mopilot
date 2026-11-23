// The built-in browser's own history, encrypted at rest (userData/browser-history.sqlite.enc, sealedFile.cjs; kept in memory while the app runs): pages visited in the shared profile, pages imported from another browser, the ranking behind the address bar's suggestions and the agent's history search.
const path = require('node:path');
const { prefixCodePoints } = require('../../../shared/textPrefix.mjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { mkdirPrivate } = require('../../platform/privateFiles.cjs');
const { SealedFile } = require('../../platform/sealedFile.cjs');

/** How long after a change the history is saved: a crash loses at most this much browsing (each save rewrites it whole). */
const SAVE_MS = 30_000;
const { cleanPageUrl } = require('./pageUrl.cjs');

const DAY = 86_400_000;
/** URLs kept; the least recently visited go first. */
const MAX_URLS = 50_000;
/** How many records are written between checks of the cap. */
const PRUNE_EVERY = 200;
const IMPORT_PREFIX = 'import:';

/** An address as the user types it, for matching: lower case, no scheme, no leading www. */
function typedForm(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

/** A LIKE pattern matching `text` anywhere, with the wildcard characters in it escaped. */
const likeAnywhere = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * How well a stored page matches typed text: 3 when the host starts with it, 2 when the address does, 1 when the
 * address or title contains it, 0 for no match. Empty text matches everything at 1.
 */
function matchRank(row, text) {
  if (!text) return 1;
  const shown = typedForm(row.url);
  if (shown.split('/')[0].startsWith(text)) return 3;
  if (shown.startsWith(text)) return 2;
  if (shown.includes(text) || String(row.title).toLowerCase().includes(text)) return 1;
  return 0;
}

class HistoryStore {
  /**
   * @param {{ file: string, now?: () => number, max?: number, open?: (file: string) => any,
   *           safeStorage?: import('../../platform/secretFile.cjs').SafeStorage | null, saveMs?: number }} o
   *   file: where an earlier version kept the database in plain text; the history is saved sealed beside it
   *   (`<file>.enc`, its key in browser-history.key), and the plain one is moved in and deleted on first use
   *   now: the clock (ms), for tests
   *   max: the cap on stored addresses
   *   open: opens a database (node:sqlite), for tests
   *   safeStorage: what the history is encrypted with; without its key history is kept for this run only
   *   saveMs: how long after a change it is saved
   */
  constructor({ file, now = Date.now, max = MAX_URLS, open, safeStorage = null, saveMs = SAVE_MS }) {
    this.file = file;
    this.now = now;
    this.max = max;
    this.open = open ?? ((f) => new (require('node:sqlite').DatabaseSync)(f));
    this.sealed = new SealedFile({
      file: `${file}.enc`,
      keyFile: path.join(path.dirname(file), 'browser-history.key'),
      safeStorage,
      what: 'the browser history',
    });
    this.saveMs = saveMs;
    /** @type {ReturnType<typeof setTimeout> | null} the save a change scheduled */
    this.saveTimer = null;
    /** changes not saved yet */
    this.dirty = false;
    /** closed at quit: what comes after is not recorded (it could not be saved) */
    this.closed = false;
    /** @type {import('node:sqlite').DatabaseSync | null | false} false once opening failed: history is then off for this run */
    this.db = null;
    this.writes = 0;
    /** the SQL function the search lowers with: JavaScript's once the database has it, else SQLite's (ASCII only) */
    this.lower = 'lower';
  }

  #handle() {
    if (this.closed) return null;
    if (this.db !== null) return this.db || null;
    try {
      mkdirPrivate(path.dirname(this.file));
      // a sealed history that can't be opened (another OS key) throws: history is off, and that file is never saved over
      const saved = this.sealed.read();
      // a plain one beside it too: a crash between saving it sealed and deleting it, or an older version that ran since
      const plain = this.#plainBytes();
      const db = this.open(':memory:');
      if (saved ?? plain) db.deserialize(/** @type {Buffer} */ (saved ?? plain));
      db.exec(
        `CREATE TABLE IF NOT EXISTS urls (
           url TEXT PRIMARY KEY,
           title TEXT NOT NULL DEFAULT '',
           visit_count INTEGER NOT NULL DEFAULT 0,
           typed_count INTEGER NOT NULL DEFAULT 0,
           last_visit INTEGER NOT NULL,
           source TEXT NOT NULL DEFAULT 'local'
         );
         CREATE INDEX IF NOT EXISTS urls_last_visit ON urls (last_visit)`,
      );
      // SQLite's lower() folds ASCII only ("Über" stays "Über"): search with JavaScript's, as typedForm lowers the query
      if (typeof db.function === 'function') {
        db.function('js_lower', { deterministic: true }, (s) => String(s).toLowerCase());
        this.lower = 'js_lower';
      }
      this.db = db;
      // an earlier version's plain database: moved in, saved sealed now, and deleted once that worked
      if (plain && (!saved || this.#mergePlain(db, plain))) {
        this.dirty = true;
        this.flush();
      }
    } catch (error) {
      // history is a convenience: a database that will not open turns it off instead of breaking browsing
      noteIgnored('open the browser history database', error);
      this.db = false;
    }
    return this.db || null;
  }

  /** The plain database an earlier version left, as bytes an in-memory database opens; null when there is none. */
  #plainBytes() {
    if (!fs.existsSync(this.file)) return null;
    const db = this.open(this.file);
    try {
      const bytes = Buffer.from(db.serialize());
      // it was in WAL mode, which a database in memory can't open: the header says rollback journal instead
      bytes[18] = 1;
      bytes[19] = 1;
      return bytes;
    } finally {
      db.close();
    }
  }

  /**
   * The visits a plain database holds beside the sealed one, merged in: a page in both keeps the most visits, its
   * latest visit and the title of that visit. False when it can't be read: it is then left where it is, and recorded.
   */
  #mergePlain(/** @type {import('node:sqlite').DatabaseSync} */ db, /** @type {Buffer} */ plain) {
    const other = this.open(':memory:');
    let merged = true;
    try {
      other.deserialize(plain);
      const put = db.prepare(
        `INSERT INTO urls (url, title, visit_count, typed_count, last_visit, source) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = CASE WHEN excluded.last_visit > last_visit AND excluded.title != '' THEN excluded.title ELSE title END,
           visit_count = MAX(visit_count, excluded.visit_count),
           typed_count = MAX(typed_count, excluded.typed_count),
           last_visit = MAX(last_visit, excluded.last_visit)`,
      );
      for (const r of other.prepare('SELECT url, title, visit_count, typed_count, last_visit, source FROM urls').all())
        put.run(r.url, r.title, r.visit_count, r.typed_count, r.last_visit, r.source);
    } catch (error) {
      noteIgnored('merge an older plain browser history', error);
      merged = false;
    }
    other.close();
    return merged;
  }

  /** A change to save: saved SAVE_MS later (several changes at once are one save). */
  #changed() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveMs);
    this.saveTimer.unref?.();
  }

  /**
   * Saves what changed, sealed, and deletes an earlier version's plain database once that worked. Without the OS key
   * nothing is written (history stays for this run), and the failure is recorded; the next change tries again.
   */
  flush() {
    if (!this.dirty || !this.db) return;
    try {
      this.sealed.write(this.db.serialize());
      this.dirty = false;
      for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) fs.rmSync(f, { force: true });
    } catch (error) {
      noteIgnored('save the browser history', error);
    }
  }

  /** Records a visit to a page of the shared profile. A page that is not plain http(s) is not kept. */
  record({ url, title = '', at = this.now(), typed = false }) {
    const clean = cleanPageUrl(url);
    const db = clean ? this.#handle() : null;
    if (!clean || !db) return false;
    db.prepare(
      `INSERT INTO urls (url, title, visit_count, typed_count, last_visit, source) VALUES (?, ?, 1, ?, ?, 'local')
       ON CONFLICT(url) DO UPDATE SET
         visit_count = visit_count + 1,
         typed_count = typed_count + excluded.typed_count,
         last_visit = MAX(last_visit, excluded.last_visit),
         title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
         source = 'local'`,
    ).run(clean, prefixCodePoints(String(title ?? ''), 300), typed ? 1 : 0, at);
    if (++this.writes % PRUNE_EVERY === 0) this.#prune(db);
    this.#changed();
    return true;
  }

  /** The page's title arrived after its visit was recorded. */
  setTitle(url, title) {
    const clean = cleanPageUrl(url);
    const db = clean && title ? this.#handle() : null;
    if (!clean || !db) return;
    db.prepare('UPDATE urls SET title = ? WHERE url = ?').run(prefixCodePoints(String(title), 300), clean);
    this.#changed();
  }

  #prune(db) {
    db.prepare('DELETE FROM urls WHERE url IN (SELECT url FROM urls ORDER BY last_visit DESC LIMIT -1 OFFSET ?)').run(this.max);
  }

  /** Matching pages for typed text, best first: [{ url, title, lastVisit, visitCount }]. */
  search({ query = '', since = 0, limit = 20 } = {}) {
    const db = this.#handle();
    if (!db) return [];
    const text = typedForm(query);
    const cap = Math.max(1, Math.min(Number(limit) || 20, 100));
    // Rank every match before limiting: a frequency-only candidate cap can drop the best host match.
    const rows = text
      ? db
          .prepare(
            `SELECT url, title, visit_count, typed_count, last_visit FROM urls
             WHERE last_visit >= ? AND (${this.lower}(url) LIKE ? ESCAPE '\\' OR ${this.lower}(title) LIKE ? ESCAPE '\\')
             ORDER BY (visit_count + 3 * typed_count) DESC, last_visit DESC`,
          )
          .all(since, likeAnywhere(text), likeAnywhere(text))
      : db
          .prepare(
            'SELECT url, title, visit_count, typed_count, last_visit FROM urls WHERE last_visit >= ? ORDER BY last_visit DESC LIMIT ?',
          )
          .all(since, cap);
    const now = this.now();
    return rows
      .map((r) => {
        const rank = matchRank(r, text);
        const frecency = Number(r.visit_count) + 3 * Number(r.typed_count);
        const ageDays = Math.max(0, (now - Number(r.last_visit)) / DAY);
        return { r, rank, score: frecency / (1 + ageDays / 30) };
      })
      .filter((x) => x.rank > 0)
      .sort((a, b) => (text ? b.rank - a.rank || b.score - a.score : Number(b.r.last_visit) - Number(a.r.last_visit)))
      .slice(0, cap)
      .map(({ r }) => ({ url: String(r.url), title: String(r.title), lastVisit: Number(r.last_visit), visitCount: Number(r.visit_count) }));
  }

  /** Visits read from another browser: pages not already here are added (marked with their source), the rest are left as they are. */
  importVisits(visits, source) {
    const db = this.#handle();
    const counts = { imported: 0, skippedExisting: 0, skippedInvalid: 0 };
    if (!db) return { ...counts, skippedInvalid: visits.length };
    const find = db.prepare('SELECT 1 AS found FROM urls WHERE url = ?');
    const add = db.prepare(`INSERT INTO urls (url, title, visit_count, typed_count, last_visit, source) VALUES (?, ?, ?, ?, ?, ?)`);
    const now = this.now();
    db.exec('BEGIN');
    try {
      for (const v of visits) {
        const url = cleanPageUrl(v?.url);
        const last = Number(v?.lastVisit);
        if (!url || !Number.isFinite(last) || last <= 0 || last > now + DAY) {
          counts.skippedInvalid++;
        } else if (find.get(url)) {
          counts.skippedExisting++;
        } else {
          add.run(
            url,
            prefixCodePoints(String(v.title ?? ''), 300),
            Math.max(1, Number(v.visitCount) || 1),
            Math.max(0, Number(v.typedCount) || 0),
            last,
            IMPORT_PREFIX + source,
          );
          counts.imported++;
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.#prune(db);
    this.#changed();
    return counts;
  }

  /** Imported sources and how many pages each brought: [{ source, count }]. */
  importedSources() {
    const db = this.#handle();
    if (!db) return [];
    return db
      .prepare(
        `SELECT substr(source, ${IMPORT_PREFIX.length + 1}) AS source, COUNT(*) AS count FROM urls WHERE source LIKE 'import:%' GROUP BY source ORDER BY source`,
      )
      .all()
      .map((r) => ({ source: String(r.source), count: Number(r.count) }));
  }

  /** Deletes the pages that only came from an import (one source, or all). Returns how many. */
  deleteImported(source) {
    const db = this.#handle();
    if (!db) return 0;
    const run = source
      ? db.prepare('DELETE FROM urls WHERE source = ?').run(IMPORT_PREFIX + source)
      : db.prepare(`DELETE FROM urls WHERE source LIKE 'import:%'`).run();
    this.#changed();
    return Number(run.changes);
  }

  /** Removes one page, as Shift+Delete on a suggestion does. */
  remove(url) {
    const db = this.#handle();
    const clean = cleanPageUrl(url);
    if (!db || !clean) return;
    db.prepare('DELETE FROM urls WHERE url = ?').run(clean);
    this.#changed();
  }

  /** Clear browsing data: everything. */
  clear() {
    const db = this.#handle();
    if (!db) {
      // a history that can't be opened (another OS key, damage) is cleared by removing it: the next use starts afresh
      if (this.db === false) {
        for (const f of [this.sealed.file, this.sealed.keyFile]) fs.rmSync(f, { force: true });
        this.db = null;
        this.sealed.dataKey = null;
      }
      return;
    }
    // saved now, with the freed pages gone: cleared pages must not come back after a crash, nor stay in the file
    db.exec('DELETE FROM urls; VACUUM');
    this.dirty = true;
    this.flush();
  }

  /** How many pages are stored. */
  count() {
    const db = this.#handle();
    return db ? Number(/** @type {{ n: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM urls').get()).n) : 0;
  }

  /** Saves what is left and closes (the app is quitting). */
  close() {
    clearTimeout(/** @type {any} */ (this.saveTimer));
    this.saveTimer = null;
    this.flush();
    this.closed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        noteIgnored('close the browser history database', error);
      }
    }
    this.db = null;
  }
}

module.exports = { HistoryStore, typedForm, matchRank, MAX_URLS, IMPORT_PREFIX };
