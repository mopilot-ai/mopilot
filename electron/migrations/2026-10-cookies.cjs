// Built-in browser cookies across the rename and the EnableCookieEncryption fuse (D-83). Chromium encrypts
// a cookie with a key kept in the keychain item "<app name> Safe Storage", so cookies the pre-rebrand app
// wrote can't be read under MoPilot's own key and would be dropped. Once, before Chromium opens the
// cookie databases:
//   1. back the databases up, decrypt every cookie the old key can open, and store it as plaintext
//      (Chromium reads a plaintext cookie under either fuse setting);
//   2. after 'ready', set every cookie again through the session, so Chromium stores it encrypted with
//      this build's key; one Chromium won't take (expired, invalid) is removed rather than left in plain text;
//   3. at the next start after step 2 finished or ran out of tries, before Chromium opens them: delete any cookie
//      still plain, rewrite the databases (VACUUM) so no page of step 1's plaintext is left in their free space or
//      journal, and remove the backup. Between step 1 and that start, plaintext is on disk (accepted: one start).
// A cookie no old key opens stays as it was; the browser then shows a sign-in-again hint.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { mkdirPrivate, PRIVATE_FILE } = require('../platform/privateFiles.cjs');
const { deriveKey, decryptValue, encryptValue } = require('../../shared/chromiumCrypto.cjs');

const ID = 'cookies-v1';
/** Keychain items of the app names this profile was used under before MoPilot. */
const LEGACY_SERVICES = ['Codex Safe Storage', 'Sage Codex Safe Storage'];

/** Every cookie database in the profile: the default session's and each persistent partition's. */
function cookieDbs(userData) {
  const roots = [userData];
  try {
    for (const p of fs.readdirSync(path.join(userData, 'Partitions'))) roots.push(path.join(userData, 'Partitions', p));
  } catch (error) {
    // no Partitions folder (ENOENT): only the default session has cookies
    noteIgnored('list the browser partitions', error, ['ENOENT']);
  }
  const out = [];
  for (const r of roots) for (const f of [path.join(r, 'Cookies'), path.join(r, 'Network', 'Cookies')]) if (fs.existsSync(f)) out.push(f);
  return out;
}

const openDb = (file, readOnly = false) => new (require('node:sqlite').DatabaseSync)(file, { readOnly });

/** How many cookies the database keeps encrypted, and its schema version. */
function survey(file) {
  const db = openDb(file, true);
  try {
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0);
    // COUNT(*) always returns one row
    const count = (sql) => Number(/** @type {{ n: number }} */ (db.prepare(sql).get()).n);
    const encrypted = count('SELECT COUNT(*) AS n FROM cookies WHERE length(encrypted_value) > 0');
    const plain = count("SELECT COUNT(*) AS n FROM cookies WHERE length(encrypted_value) = 0 AND value != ''");
    return { version, encrypted, plain };
  } finally {
    db.close();
  }
}

/** Decrypt what `keys` open into the plaintext column. Returns {decrypted, failed}. */
function decryptDb(file, keys) {
  const db = openDb(file);
  try {
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0);
    const rows = db.prepare('SELECT rowid AS id, host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 0').all();
    const put = db.prepare("UPDATE cookies SET value = ?, encrypted_value = X'' WHERE rowid = ?");
    let decrypted = 0;
    let failed = 0;
    db.exec('BEGIN');
    for (const r of rows) {
      let value = null;
      for (const k of keys) if ((value = decryptValue(r.encrypted_value, k, r.host_key, version)) !== null) break;
      if (value === null) failed++;
      else {
        put.run(value, r.id);
        decrypted++;
      }
    }
    db.exec('COMMIT');
    return { decrypted, failed };
  } finally {
    db.close();
  }
}

/** A legacy keychain password (macOS asks the user once to allow it); null when there is none or it is denied. */
function keychainPassword(service) {
  try {
    return proc
      .execFileSync('security', ['find-generic-password', '-w', '-s', service], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .replace(/\n$/, '');
  } catch {
    return null;
  }
}

/** Copy each database (and its journal) to backups/cookies-<stamp>/, keeping its path under userData. */
function backupDbs(userData, files, now) {
  const dir = path.join(
    userData,
    'backups',
    `cookies-${new Date(now)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z')}`,
  );
  for (const f of files)
    for (const suffix of ['', '-journal', '-wal']) {
      if (!fs.existsSync(f + suffix)) continue;
      const to = path.join(dir, path.relative(userData, f) + suffix);
      mkdirPrivate(path.dirname(to));
      fs.copyFileSync(f + suffix, to);
      // the cookies a sign-in rests on: owner-only, as Chromium keeps the databases themselves
      fs.chmodSync(to, PRIVATE_FILE);
    }
  return dir;
}

/**
 * Step 1, before Chromium opens the databases. Returns {result, decrypted, failed, reencrypt, backup}:
 * result 'none' (nothing encrypted), 'ok' (every cookie opened) or 'failed' (some only a re-login brings
 * back); reencrypt: plaintext cookies step 2 should store encrypted.
 */
function migrateCookies(userData, { now = Date.now(), password = keychainPassword, services = LEGACY_SERVICES } = {}) {
  const files = cookieDbs(userData);
  const found = files.map((f) => ({ f, s: survey(f) }));
  const encrypted = found.filter((x) => x.s.encrypted > 0);
  let decrypted = 0;
  let failed = 0;
  /** @type {string | null} */
  let backup = null;
  if (encrypted.length) {
    backup = backupDbs(
      userData,
      encrypted.map((x) => x.f),
      now,
    );
    // one keychain item at a time: each read may ask the user, so stop once every cookie is open
    let left = encrypted.map((x) => x.f);
    for (const s of services) {
      if (!left.length) break;
      const pw = password(s);
      if (!pw) continue;
      const key = deriveKey(pw);
      left = left.filter((f) => {
        const r = decryptDb(f, [key]);
        decrypted += r.decrypted;
        return r.failed > 0;
      });
    }
    failed = left.reduce((n, f) => n + survey(f).encrypted, 0);
  }
  const reencrypt = decrypted > 0 || found.some((x) => x.s.plain > 0);
  return { result: !encrypted.length ? 'none' : failed ? 'failed' : 'ok', decrypted, failed, reencrypt, backup };
}

/** A cookie as cookies.set takes it, from what cookies.get returned. */
function setDetails(c) {
  const host = String(c.domain ?? '').replace(/^\./, '');
  return {
    url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    ...(c.hostOnly ? {} : { domain: c.domain }),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.sameSite && { sameSite: c.sameSite }),
    ...(c.session || c.expirationDate == null ? {} : { expirationDate: c.expirationDate }),
  };
}

/** Step 2, after 'ready': set every cookie again so Chromium stores it with this build's key. */
async function reencryptSession(ses) {
  let n = 0;
  const all = await ses.cookies.get({});
  /** a refused cookie is removed by url and name, which would take a sibling with the same name and domain too */
  const shared = (c) => all.filter((o) => o.name === c.name && o.domain === c.domain).length > 1;
  for (const c of all) {
    const details = setDetails(c);
    try {
      await ses.cookies.set(details);
      n++;
    } catch (error) {
      // a cookie Chromium rejects (expired or invalid) is not counted, and goes: it was stored in plain text
      noteIgnored("store a browser cookie again under this build's key", error);
      // a partitioned cookie, or one sharing its name and domain with another, can't be removed alone: it stays
      if (c.partitionKey || shared(c)) continue;
      await ses.cookies
        .remove(details.url, details.name)
        .catch((removeError) => noteIgnored('remove a browser cookie left in plain text', removeError));
    }
  }
  await ses.cookies.flushStore();
  return n;
}

/**
 * Step 3, at the start after step 2 finished or ran out of tries: a cookie still stored in plain text (one Chromium
 * would not take again, or one step 2 never reached) is deleted, then every cookie database is rewritten (VACUUM,
 * journal truncated) so no freed page keeps a plaintext value, and the migration's backup goes. Returns how many
 * plain cookies were deleted.
 * @param {string} userData @param {string | null | undefined} backup the backup folder step 1 made
 */
function scrubDbs(userData, backup = null) {
  let deleted = 0;
  for (const f of cookieDbs(userData)) {
    const db = openDb(f);
    try {
      deleted += Number(db.prepare("DELETE FROM cookies WHERE length(encrypted_value) = 0 AND value != ''").run().changes);
      db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }
  // the backup holds the cookies under the old app's key: only ever removed from the app's own backups folder
  const backups = path.join(userData, 'backups');
  if (backup && path.dirname(path.resolve(backup)) === backups) fs.rmSync(backup, { recursive: true, force: true });
  return deleted;
}

module.exports = {
  id: ID,
  scrubDbs,
  LEGACY_SERVICES,
  deriveKey,
  decryptValue,
  encryptValue,
  cookieDbs,
  survey,
  decryptDb,
  migrateCookies,
  setDetails,
  reencryptSession,
};
