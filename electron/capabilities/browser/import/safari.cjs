// Reads Safari's data on macOS: History.db (latest visit per URL), Bookmarks.plist (converted to XML with plutil, never modified) and Cookies.binarycookies.
const { fs } = require('../../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { proc: childProcess } = require('../../../platform/ports/proc.cjs');
const { ImportError, classify } = require('./errors.cjs');
const { withDatabase } = require('./snapshot.cjs');
const { parseBinaryCookies, MAC_EPOCH_OFFSET } = require('./binaryCookies.cjs');
const { parsePlistXml } = require('./plistXml.cjs');

/** Largest plist or cookie file read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Largest XML plutil may print: XML runs about 2.3 times a binary plist's size (base64 data, indentation). */
const MAX_XML_BYTES = 4 * MAX_FILE_BYTES;
const PLUTIL = '/usr/bin/plutil';
const MAX_FOLDER_DEPTH = 64;
/** @type {Record<string, string>} */
const FOLDER_TITLES = { BookmarksBar: 'Favorites', BookmarksMenu: 'Bookmarks Menu', 'com.apple.ReadingList': 'Reading List' };
const isWeb = (/** @type {string} */ url) => /^https?:\/\//i.test(url);

/** @typedef {{ title: string, url: string, folderPath: string[], addedAt: null }} Bookmark */

/** @param {string} [home] */
function safariPaths(home = os.homedir()) {
  const lib = path.join(home, 'Library');
  return {
    history: path.join(lib, 'Safari', 'History.db'),
    bookmarks: path.join(lib, 'Safari', 'Bookmarks.plist'),
    cookies: [
      path.join(lib, 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'),
      path.join(lib, 'Cookies', 'Cookies.binarycookies'),
    ],
  };
}

/**
 * Refuses a symlink or an oversized file; ENOENT/EPERM surface as the thrown error.
 * @param {typeof import('node:fs')} f
 * @param {string} file
 */
function checkFile(f, file) {
  const st = f.lstatSync(file);
  if (st.isSymbolicLink()) throw new ImportError('read_failed', 'Symlinked browser data files are not read.');
  if (st.size > MAX_FILE_BYTES) throw new ImportError('too_large', 'The browser data file is too large.');
}

/**
 * Web pages Safari visited, latest visit per page, most recent first.
 * @param {{ home?: string, limit?: number, fs?: typeof import('node:fs'), tmpRoot?: string }} [o]
 * @returns {Promise<{ url: string, title: string, visitCount: number, typedCount: number, lastVisit: number }[]>}
 */
async function readHistory({ home, limit = 50000, fs: f, tmpRoot } = {}) {
  const max = Math.max(1, Math.floor(Number(limit)) || 1);
  return withDatabase(
    safariPaths(home).history,
    (db) => {
      const rows = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT i.url AS url, i.visit_count AS visit_count, v.visit_time AS visit_time, v.title AS title
           FROM history_items i
           JOIN history_visits v ON v.id = (SELECT id FROM history_visits WHERE history_item = i.id ORDER BY visit_time DESC, id DESC LIMIT 1)
           WHERE i.url LIKE 'http://%' OR i.url LIKE 'https://%'
           ORDER BY v.visit_time DESC, i.id DESC
           LIMIT ?`,
          )
          .all(max)
      );
      return rows.map((r) => ({
        url: String(r.url),
        title: typeof r.title === 'string' ? r.title : '',
        visitCount: Number(r.visit_count) || 0,
        typedCount: 0,
        lastVisit: Math.round((Number(r.visit_time) + MAC_EPOCH_OFFSET) * 1000),
      }));
    },
    { fs: f, tmpRoot },
  );
}

/**
 * The XML property list plutil prints for `file`.
 * @param {Function} execFile
 * @param {string} file
 * @returns {Promise<string>}
 */
function runPlutil(execFile, file) {
  return new Promise((resolve, reject) => {
    execFile(
      PLUTIL,
      // XML, not JSON: a real Bookmarks.plist holds data and date values, which plutil cannot write as JSON
      ['-convert', 'xml1', '-o', '-', '--', file],
      { timeout: 30000, maxBuffer: MAX_XML_BYTES, encoding: 'utf8' },
      (/** @type {any} */ error, /** @type {any} */ stdout) => {
        if (error) reject(new ImportError('read_failed', `plutil could not read the bookmarks (${error.message}).`));
        else resolve(String(stdout));
      },
    );
  });
}

/**
 * Appends the bookmarks under `node` to `out`, depth first.
 * @param {any} node
 * @param {string[]} folder
 * @param {number} depth
 * @param {Bookmark[]} out
 */
function walk(node, folder, depth, out) {
  const children = Array.isArray(node.Children) ? node.Children : [];
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    if (child.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      const url = typeof child.URLString === 'string' ? child.URLString : '';
      if (!isWeb(url)) continue;
      const title = child.URIDictionary && typeof child.URIDictionary.title === 'string' ? child.URIDictionary.title : '';
      out.push({ title: title || url, url, folderPath: folder.slice(), addedAt: null });
    } else if (child.WebBookmarkType === 'WebBookmarkTypeList' && depth < MAX_FOLDER_DEPTH) {
      const raw = typeof child.Title === 'string' ? child.Title : '';
      const name = Object.hasOwn(FOLDER_TITLES, raw) ? FOLDER_TITLES[raw] : raw;
      walk(child, name ? [...folder, name] : folder, depth + 1, out);
    }
  }
}

/**
 * Safari bookmarks, favorites and reading list entries.
 * @param {{ home?: string, execFile?: Function, fs?: typeof import('node:fs') }} [o]
 * @returns {Promise<Bookmark[]>}
 */
async function readBookmarks({
  home,
  execFile = (/** @type {any[]} */ ...args) => /** @type {any} */ (childProcess.execFile)(...args),
  fs: f = fs,
} = {}) {
  const file = safariPaths(home).bookmarks;
  try {
    checkFile(f, file);
    // opening it now makes a Full Disk Access block show as EPERM (plutil would only print a message)
    f.closeSync(f.openSync(file, 'r'));
    const root = /** @type {any} */ (parsePlistXml(await runPlutil(execFile, file)));
    /** @type {Bookmark[]} */
    const out = [];
    walk(root && typeof root === 'object' ? root : {}, [], 0, out);
    return out;
  } catch (error) {
    throw classify(error);
  }
}

/**
 * Safari cookies from the first cookie file that exists; a blocked (EPERM/EACCES) file is reported, not skipped.
 * @param {{ home?: string, now?: number, fs?: typeof import('node:fs') }} [o]
 */
async function readCookies({ home, now, fs: f = fs } = {}) {
  for (const file of safariPaths(home).cookies) {
    try {
      checkFile(f, file);
      return parseBinaryCookies(f.readFileSync(file), { now });
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') continue;
      throw classify(error);
    }
  }
  throw new ImportError('missing', 'Safari has no cookie file.');
}

module.exports = { safariPaths, readHistory, readBookmarks, readCookies };
