// Reads a Chromium-family profile: bookmarks (JSON), history, cookies and saved passwords (SQLite copies), with cookie values and passwords decrypted by the caller's key.
const path = require('node:path');
const { decryptValue } = require('../../../../shared/chromiumCrypto.cjs');
const { ImportError } = require('./errors.cjs');
const { withDatabase, readTextFile } = require('./snapshot.cjs');
const { noteIgnored } = require('../../../ignored.cjs');

/** Milliseconds from 1601-01-01 (Chromium's epoch) to 1970-01-01. */
const EPOCH_DELTA_MS = 11644473600000;
const MAX_LIFETIME_S = 400 * 24 * 60 * 60;
const HTTP = /^https?:\/\//i;
const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };
const ROOT_FOLDERS = [
  ['bookmark_bar', 'Bookmarks bar'],
  ['other', 'Other bookmarks'],
  ['synced', 'Mobile bookmarks'],
];

/**
 * Milliseconds since the Unix epoch for a Chromium time (microseconds since 1601, a number or numeric string);
 * null when it is absent, zero or not a number.
 * @param {number | string | bigint | null | undefined} us
 * @returns {number | null}
 */
function chromiumTime(us) {
  let n;
  try {
    n = BigInt(us ?? 0);
  } catch {
    return null;
  }
  return n > 0n ? Number(n / 1000n) - EPOCH_DELTA_MS : null;
}

/**
 * Bookmark files a profile can hold: `Bookmarks` (local, or synced) and `AccountBookmarks` (kept by Chrome for an
 * account that is signed in without sync; such a profile may have no `Bookmarks` file at all).
 */
const BOOKMARK_FILES = ['Bookmarks', 'AccountBookmarks'];

/**
 * @typedef {{ title: string, url: string, folderPath: string[], addedAt: number | null }} Bookmark
 * @param {string} text
 * @param {Bookmark[]} out
 */
function parseBookmarks(text, out) {
  const walk = (node, folderPath) => {
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      if (child?.type === 'url') {
        if (typeof child.url === 'string' && HTTP.test(child.url)) {
          out.push({
            title: typeof child.name === 'string' ? child.name : '',
            url: child.url,
            folderPath,
            addedAt: chromiumTime(child.date_added),
          });
        }
      } else if (child?.type === 'folder') {
        walk(child, [...folderPath, typeof child.name === 'string' ? child.name : '']);
      }
    }
  };
  try {
    const roots = JSON.parse(text)?.roots;
    for (const [key, label] of ROOT_FOLDERS) walk(roots?.[key], [label]);
  } catch (error) {
    noteIgnored('parse browser bookmarks', error);
    throw new ImportError('read_failed', 'The bookmarks file could not be read.');
  }
}

/**
 * The profile's local and account bookmarks together (the bookmark store drops one saved in both, by url and folder).
 * A profile with neither file has no bookmarks (Chromium writes one only once a bookmark exists), so that is an empty list.
 * @param {string} profilePath
 * @param {{ fs?: typeof import('../../../platform/ports/fs.cjs').fs }} [o]
 * @returns {Promise<Bookmark[]>}
 */
async function readBookmarks(profilePath, o = {}) {
  /** @type {Bookmark[]} */
  const all = [];
  for (const name of BOOKMARK_FILES) {
    let text;
    try {
      text = await readTextFile(path.join(profilePath, name), o);
    } catch (error) {
      if (error.code === 'missing') continue;
      throw error;
    }
    parseBookmarks(text, all);
  }
  return all;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table */
function columnsOf(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name)),
  );
}

/**
 * @typedef {{ url: string, title: string, visitCount: number, typedCount: number, lastVisit: number }} Visit
 * @param {string} profilePath
 * @param {{ limit?: number, fs?: typeof import('../../../platform/ports/fs.cjs').fs, tmpRoot?: string }} [o]
 * @returns {Promise<Visit[]>}
 */
async function readHistory(profilePath, { limit = 50000, ...o } = {}) {
  return withDatabase(
    path.join(profilePath, 'History'),
    (db) => {
      const hidden = columnsOf(db, 'urls').has('hidden') ? 'AND hidden = 0' : '';
      // the time is divided in SQL: a 2020s microsecond count is past what a JavaScript number holds exactly
      const rows = db
        .prepare(
          `SELECT url, title, visit_count, typed_count, CAST(last_visit_time / 1000 AS INTEGER) AS ms FROM urls
           WHERE (url LIKE 'http://%' OR url LIKE 'https://%') ${hidden} ORDER BY last_visit_time DESC LIMIT ?`,
        )
        .all(Math.max(0, Math.floor(limit)));
      return rows.map((r) => ({
        url: String(r.url),
        title: String(r.title ?? ''),
        visitCount: Number(r.visit_count),
        typedCount: Number(r.typed_count),
        lastVisit: Math.max(0, Number(r.ms) - EPOCH_DELTA_MS),
      }));
    },
    o,
  );
}

/** The cookie database's schema version (0 when it has no meta table). */
function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    return Number(row?.value) || 0;
  } catch (error) {
    noteIgnored('read the cookie database version', error);
    return 0;
  }
}

/**
 * @typedef {{ host: string, name: string, value: string, path: string, secure: boolean, httpOnly: boolean, sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict', expires: number, hostOnly: boolean }} Cookie
 * @param {string} profilePath
 * @param {Buffer | null | undefined} key
 * @param {{ now?: number, fs?: typeof import('../../../platform/ports/fs.cjs').fs, tmpRoot?: string }} [o]
 * @returns {Promise<{ cookies: Cookie[], stats: { total: number, imported: number, expired: number, session: number, partitioned: number, unsupported: number, undecryptable: number } }>}
 */
async function readCookies(profilePath, key, { now = Date.now(), ...o } = {}) {
  const read = (file) =>
    withDatabase(
      file,
      (db) => {
        const partition = columnsOf(db, 'cookies').has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key";
        // expiry is divided in SQL (seconds since 1601): the raw microsecond count can exceed a JavaScript number's exact range
        const rows = db
          .prepare(
            `SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS exp_s, expires_utc = 0 AS no_expiry,
                    is_secure, is_httponly, samesite, is_persistent, ${partition} FROM cookies`,
          )
          .all();
        return { rows, version: schemaVersion(db) };
      },
      o,
    );
  let data;
  try {
    data = await read(path.join(profilePath, 'Network', 'Cookies'));
  } catch (error) {
    if (error.code !== 'missing') throw error;
    data = await read(path.join(profilePath, 'Cookies'));
  }
  const nowS = now / 1000;
  const stats = { total: data.rows.length, imported: 0, expired: 0, session: 0, partitioned: 0, unsupported: 0, undecryptable: 0 };
  /** @type {Cookie[]} */
  const cookies = [];
  for (const r of data.rows) {
    if (r.top_frame_site_key) {
      stats.partitioned++;
      continue;
    }
    if (!r.is_persistent || r.no_expiry) {
      stats.session++;
      continue;
    }
    const expirySeconds = Number(r.exp_s) - EPOCH_DELTA_MS / 1000;
    if (expirySeconds <= nowS) {
      stats.expired++;
      continue;
    }
    const host = String(r.host_key);
    const blob = r.encrypted_value ? Buffer.from(r.encrypted_value) : Buffer.alloc(0);
    /** @type {string | null} */
    let value;
    if (blob.length === 0) {
      value = String(r.value);
    } else {
      const tag = blob.subarray(0, 3).toString('latin1');
      if (tag === 'v11' || tag === 'v20') {
        stats.unsupported++;
        continue;
      }
      value = key ? decryptValue(blob, key, host, data.version) : null;
      if (value === null) {
        stats.undecryptable++;
        continue;
      }
    }
    cookies.push({
      host,
      name: String(r.name),
      value,
      path: String(r.path),
      secure: Boolean(r.is_secure),
      httpOnly: Boolean(r.is_httponly),
      sameSite: SAME_SITE[Number(r.samesite)] ?? 'unspecified',
      expires: Math.min(Math.floor(expirySeconds), Math.floor(nowS) + MAX_LIFETIME_S),
      hostOnly: !host.startsWith('.'),
    });
    stats.imported++;
  }
  return { cookies, stats };
}

/** Password databases a profile can hold: the local one and, for an account signed in without sync, the account's. */
const LOGIN_FILES = ['Login Data', 'Login Data For Account'];

/** The origin a saved login belongs to (http(s) only, from its signon realm, else its page), or null. */
function loginOrigin(realm, page) {
  for (const raw of [realm, page]) {
    // an empty column is not a URL: the next one is tried
    if (!URL.canParse(String(raw ?? ''))) continue;
    const u = new URL(String(raw));
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  }
  return null;
}

/**
 * The profile's saved passwords: { logins: [{ origin, username, password, usedAt }], stats }. Sites the user told
 * the browser never to save, federated sign-ins (no password), non-web realms and passwords this key can't open are
 * left out and counted. One login per origin and user name: the most recently used.
 * @param {string} profilePath
 * @param {Buffer | null | undefined} key
 * @param {{ fs?: typeof import('../../../platform/ports/fs.cjs').fs, tmpRoot?: string }} [o]
 */
async function readPasswords(profilePath, key, o = {}) {
  const stats = { total: 0, imported: 0, blocked: 0, federated: 0, invalid: 0, unsupported: 0, undecryptable: 0 };
  /** @type {Map<string, { origin: string, username: string, password: string, usedAt: number }>} */
  const by = new Map();
  let found = false;
  for (const name of LOGIN_FILES) {
    let rows;
    try {
      rows = await withDatabase(
        path.join(profilePath, name),
        (db) => {
          const cols = columnsOf(db, 'logins');
          const pick = (c, fallback) => (cols.has(c) ? c : `${fallback} AS ${c}`);
          return db
            .prepare(
              `SELECT origin_url, signon_realm, username_value, password_value, ${pick('blacklisted_by_user', 0)}, ${pick('federation_url', "''")},
                      CAST(${cols.has('date_last_used') ? 'date_last_used' : '0'} / 1000 AS INTEGER) AS used_ms,
                      CAST(${cols.has('date_created') ? 'date_created' : '0'} / 1000 AS INTEGER) AS created_ms
               FROM logins`,
            )
            .all();
        },
        o,
      );
    } catch (error) {
      if (error.code === 'missing') continue;
      throw error;
    }
    found = true;
    for (const r of rows) {
      stats.total++;
      if (Number(r.blacklisted_by_user)) {
        stats.blocked++;
        continue;
      }
      if (r.federation_url) {
        stats.federated++;
        continue;
      }
      const origin = loginOrigin(r.signon_realm, r.origin_url);
      const blob = r.password_value ? Buffer.from(r.password_value) : Buffer.alloc(0);
      if (!origin || !blob.length) {
        stats.invalid++;
        continue;
      }
      const tag = blob.subarray(0, 3).toString('latin1');
      if (tag === 'v11' || tag === 'v20') {
        stats.unsupported++;
        continue;
      }
      // passwords carry no host hash, whatever the database's version
      const password = key ? decryptValue(blob, key, '', 0) : null;
      if (!password) {
        stats.undecryptable++;
        continue;
      }
      const username = String(r.username_value ?? '');
      const usedAt = Math.max(Number(r.used_ms) || 0, Number(r.created_ms) || 0) - EPOCH_DELTA_MS;
      const k = `${origin}\u0000${username}`;
      const had = by.get(k);
      if (!had || usedAt > had.usedAt) by.set(k, { origin, username, password, usedAt: Math.max(0, usedAt) });
    }
  }
  if (!found) throw new ImportError('missing', 'The browser has no saved passwords file.');
  const logins = [...by.values()];
  stats.imported = logins.length;
  return { logins, stats };
}

module.exports = { chromiumTime, readBookmarks, readHistory, readCookies, readPasswords, loginOrigin };
