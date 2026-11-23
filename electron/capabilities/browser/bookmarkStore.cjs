// The built-in browser's bookmarks (userData/browser-bookmarks.json): the user's own and those imported from another browser (each under an "Imported from <Browser>" folder), with the search behind the address bar and the agent's bookmark search.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { displayText, displayNumber } = require('../../platform/storedDisplay.cjs');
const { readOwnedJsonStore } = require('./ownedJsonStore.cjs');
const { cleanPageUrl } = require('./pageUrl.cjs');
const { typedForm, IMPORT_PREFIX } = require('./historyStore.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { prefixCodePoints } = require('../../../shared/textPrefix.mjs');

/** Bookmarks kept; an import stops adding beyond this. */
const MAX_ITEMS = 20_000;

/** The folders of one bookmark, trimmed and bounded. */
const cleanFolders = (folders, limit = 12) =>
  (Array.isArray(folders) ? folders : [])
    .map((p) => prefixCodePoints(String(p ?? '').trim(), 100).trim())
    .filter(Boolean)
    .slice(0, limit);

/** Stored imports include a generated root beyond the twelve admitted source folders. */
const storedFolderLimit = (source) => (typeof source === 'string' && source.startsWith(IMPORT_PREFIX) ? 13 : 12);

const keyOf = (folderPath, url) => JSON.stringify([folderPath, url]);
const FIELDS = {
  id: (v) => typeof v === 'string' && !!v,
  title: (v) => typeof v === 'string' && prefixCodePoints(v, 300) === v,
  url: (v) => cleanPageUrl(v) !== null,
  folderPath: (v, item) =>
    Array.isArray(v) &&
    v.length <= storedFolderLimit(item.source) &&
    v.every((part) => typeof part === 'string' && !!part && part.trim() === part && prefixCodePoints(part, 100) === part),
  addedAt: (v) => typeof v === 'number' && Number.isFinite(v),
  source: (v) => typeof v === 'string' && !!v,
};
const validItems = (raw) =>
  Object.keys(raw).every((key) => key === 'version' || key === 'items') &&
  Array.isArray(raw.items) &&
  raw.items.every(
    (item) =>
      isJsonRecord(item) &&
      Object.hasOwn(item, 'url') &&
      Object.entries(item).every(([key, value]) => Object.hasOwn(FIELDS, key) && FIELDS[key](value, item)),
  );

class BookmarkStore {
  /**
   * @param {{ file: string, now?: () => number }} o
   *   file: the JSON file, read on first use
   */
  constructor({ file, now = Date.now }) {
    this.file = file;
    this.now = now;
    /** @type {{ id: string, title: string, url: string, folderPath: string[], addedAt: number, source: string }[] | null} */
    this.items = null;
    /** @type {Error | null} why the file on disk couldn't be read: nothing is written over it */
    this.unreadable = null;
    /** @type {Error | null} unknown format ownership survives even an explicit clear */
    this.formatError = null;
  }

  #all() {
    if (this.items) return this.items;
    // no file yet is a new profile; a damaged one shows as empty, but is never saved over (#commit), and a copy is kept
    const { data, error, formatError } = readOwnedJsonStore(this.file, 'browser bookmarks', validItems, true);
    this.formatError = formatError;
    /** @type {any[]} */
    const list = Array.isArray(data?.items) ? data.items : [];
    this.unreadable = error;
    const items = list
      .map((i) => ({
        id: displayText(i?.id) || crypto.randomUUID(),
        title: prefixCodePoints(displayText(i?.title), 300),
        url: cleanPageUrl(i?.url) ?? '',
        folderPath: cleanFolders(Array.isArray(i?.folderPath) ? i.folderPath.map(displayText) : [], storedFolderLimit(i?.source)),
        addedAt: displayNumber(i?.addedAt),
        source: typeof i?.source === 'string' && i.source ? i.source : 'local',
      }))
      .filter((i) => i.url);
    this.items = items;
    return items;
  }

  /** Writes the new list, and only once it is on disk does it become the list: a failed write leaves memory as the disk is. */
  #commit(next) {
    if (this.formatError) throw this.formatError;
    if (this.unreadable) throw new Error(`Couldn't read the saved bookmarks (${this.unreadable.message}), so they weren't changed`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify({ version: 1, items: next }));
    this.items = next;
  }

  /** Every bookmark. */
  list() {
    return this.#all().map((i) => ({ ...i, folderPath: [...i.folderPath] }));
  }

  /** The bookmarks of a page (any folder). */
  find(url) {
    const clean = cleanPageUrl(url);
    return clean ? this.#all().filter((i) => i.url === clean) : [];
  }

  /** The ☆ button: bookmarks a page that is not bookmarked, removes every bookmark of one that is. Returns whether it is bookmarked now. */
  toggle({ url, title = '' }) {
    const clean = cleanPageUrl(url);
    if (!clean) return { bookmarked: false, ok: false };
    const all = this.#all();
    const had = all.filter((i) => i.url === clean);
    if (had.length) {
      this.#commit(all.filter((i) => i.url !== clean));
      return { bookmarked: false, ok: true };
    }
    if (all.length >= MAX_ITEMS) return { bookmarked: false, ok: false };
    this.#commit([
      ...all,
      {
        id: crypto.randomUUID(),
        title: prefixCodePoints(String(title || clean), 300),
        url: clean,
        folderPath: [],
        addedAt: this.now(),
        source: 'local',
      },
    ]);
    return { bookmarked: true, ok: true };
  }

  /** Removes one bookmark by id. */
  remove(id) {
    const all = this.#all();
    const next = all.filter((i) => i.id !== id);
    if (next.length === all.length) return false;
    this.#commit(next);
    return true;
  }

  /** Bookmarks read from another browser, under "Imported from <name>"; one already in that folder is skipped. */
  importItems(items, name, source) {
    const all = this.#all();
    const counts = { imported: 0, skippedExisting: 0, skippedInvalid: 0 };
    const seen = new Set(all.map((i) => keyOf(i.folderPath, i.url)));
    const root = `Imported from ${name}`;
    const added = [];
    for (const b of items) {
      const url = cleanPageUrl(b?.url);
      if (!url) {
        counts.skippedInvalid++;
        continue;
      }
      const folderPath = cleanFolders([root, ...cleanFolders(b.folderPath)], 13);
      const key = keyOf(folderPath, url);
      if (seen.has(key)) {
        counts.skippedExisting++;
      } else if (all.length + added.length >= MAX_ITEMS) {
        counts.skippedInvalid++;
      } else {
        seen.add(key);
        added.push({
          id: crypto.randomUUID(),
          title: prefixCodePoints(String(b.title || url), 300),
          url,
          folderPath,
          addedAt: Number(b.addedAt) || this.now(),
          source: IMPORT_PREFIX + source,
        });
        counts.imported++;
      }
    }
    if (added.length) this.#commit([...all, ...added]);
    return counts;
  }

  /** Imported sources and how many bookmarks each brought: [{ source, count }]. */
  importedSources() {
    const by = new Map();
    for (const i of this.#all())
      if (i.source.startsWith(IMPORT_PREFIX))
        by.set(i.source.slice(IMPORT_PREFIX.length), (by.get(i.source.slice(IMPORT_PREFIX.length)) ?? 0) + 1);
    return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => ({ source, count }));
  }

  /** Deletes the bookmarks an import brought (one source, or all). Returns how many. */
  deleteImported(source) {
    const all = this.#all();
    const next = all.filter((i) => !(source ? i.source === IMPORT_PREFIX + source : i.source.startsWith(IMPORT_PREFIX)));
    const removed = all.length - next.length;
    if (removed) this.#commit(next);
    return removed;
  }

  /** Clear browsing data leaves bookmarks alone; this is for a user who removes them all. */
  clear() {
    // the user asked for none: a file that couldn't be read is cleared too (its copy is kept beside it)
    this.#all();
    this.unreadable = null;
    this.#commit([]);
  }

  /** Matching bookmarks, newest first: [{ id, url, title, folderPath, addedAt }]. A folder limits to its subtree (matched by name); distinctUrls counts each address once before the limit. */
  search({ query = '', folder = '', limit = 50, distinctUrls = false } = {}) {
    const text = typedForm(query);
    const inFolder = String(folder ?? '')
      .trim()
      .toLowerCase();
    const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
    const seen = new Set();
    return this.#all()
      .filter(
        (i) =>
          (!inFolder || i.folderPath.some((f) => f.toLowerCase() === inFolder)) &&
          (!text || typedForm(i.url).includes(text) || i.title.toLowerCase().includes(text)),
      )
      .sort((a, b) => b.addedAt - a.addedAt)
      .filter((i) => {
        if (!distinctUrls) return true;
        if (seen.has(i.url)) return false;
        seen.add(i.url);
        return true;
      })
      .slice(0, cap)
      .map(({ id, url, title, folderPath, addedAt }) => ({ id, url, title, folderPath: [...folderPath], addedAt }));
  }
}

module.exports = { BookmarkStore, MAX_ITEMS };
