// Profile migrations: the one-time move from the pre-rebrand "Sage Codex" folder, and the data
// migrations under ./migrations that run in main before any window opens.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic, readJson, readJsonRecord, readStateFile } = require('../platform/fsutil.cjs');
const { mkdirPrivate, PRIVATE_FILE } = require('../platform/privateFiles.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { pinConfigDirs } = require('../identity/contract/accountDirs.cjs');
const { desktop } = require('../../shared/edition.json');

const APP_NAME = desktop.name;
// Keep profile paths and OS encryption identities stable across display-name changes.
const STORAGE_NAME = desktop.profile;
const LEGACY_NAMES = desktop.legacyProfiles;

/** The userData folder to use; env overrides win (SAGE_USER_DATA kept as an alias). */
function userDataDir(appData, env = process.env) {
  return env.MOPILOT_USER_DATA || env.SAGE_USER_DATA || path.join(appData, STORAGE_NAME);
}

/**
 * If the new profile doesn't exist yet and a legacy one does, move it over (copy if rename fails,
 * e.g. across volumes). Returns the legacy path it migrated from, or null.
 */
function migrateUserData(appData, target) {
  if (fs.existsSync(target)) return null;
  for (const name of LEGACY_NAMES) {
    const from = path.join(appData, name);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, target);
    } catch (renameError) {
      // another volume (EXDEV) can't take a rename: copy instead
      noteIgnored('move the old profile', renameError, ['EXDEV']);
      try {
        fs.cpSync(from, target, { recursive: true, preserveTimestamps: true });
      } catch (error) {
        // the old profile stays where it was, untouched
        noteIgnored('copy the old profile', error);
        return null;
      }
    }
    try {
      fs.writeFileSync(path.join(target, '.migrated-from'), from);
    } catch (error) {
      // the marker is informational; the migrated data is already in place
      noteIgnored('mark where the profile was moved from', error);
    }
    try {
      // added Claude Code logins are keyed by their folder's old path: keep running them there (identity/contract/accountDirs.cjs)
      pinConfigDirs(target, from);
    } catch (error) {
      // those logins then ask to be confirmed again
      noteIgnored("record the old profile's Claude Code login folders", error);
    }
    return from;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* data migrations                                                     */
/* ------------------------------------------------------------------ */
const MIGRATIONS = [require('./2026-10-threads-v2.cjs')];
const KEEP_BACKUPS = 3;
const BACKUP_MAX_AGE = 90 * 24 * 3600 * 1000;

const registryFile = (userData) => path.join(userData, 'migrations.json');
const lockFile = (userData) => path.join(userData, '.migrating');
const stamp = (now) =>
  new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

function readRegistry(userData) {
  const r = readJson(registryFile(userData), []);
  return Array.isArray(r) ? r : [];
}
function lastEntry(userData, id) {
  return (
    readRegistry(userData)
      .filter((e) => e && e.id === id)
      .pop() ?? null
  );
}
function record(userData, entry) {
  writeAtomic(registryFile(userData), JSON.stringify([...readRegistry(userData), entry], null, 2));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function listFiles(root, rel = '') {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    // a folder that isn't there (ENOENT, ENOTDIR) has nothing to back up; one that can't be listed fails the
    // backup, so the migration doesn't run on an incomplete one and is tried again at the next start
    if (['ENOENT', 'ENOTDIR'].includes(/** @type {any} */ (error)?.code)) return out;
    throw error;
  }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}
/** What a backup copies: ui-state.json and everything under threads/ (only those are walked). */
function backupSources(userData) {
  const ui = fs.statSync(path.join(userData, 'ui-state.json'), { throwIfNoEntry: false });
  return [...(ui?.isFile() ? ['ui-state.json'] : []), ...listFiles(userData, 'threads')].sort();
}
function bytes(userData, files) {
  return files.reduce((n, f) => n + fs.statSync(path.join(userData, f)).size, 0);
}

/** Copy ui-state.json and threads/ to backups/<label>-<UTC stamp>/ with a manifest; returns the folder. */
function backup(userData, label, now) {
  const dir = path.join(userData, 'backups', `${label}-${stamp(now)}`);
  const files = [];
  for (const f of backupSources(userData)) {
    const to = path.join(dir, f);
    mkdirPrivate(path.dirname(to));
    fs.copyFileSync(path.join(userData, f), to);
    // a copy of the user's chats is owner-only, whatever the original's mode was
    fs.chmodSync(to, PRIVATE_FILE);
    files.push({ path: f, size: fs.statSync(to).size, sha256: sha256(to) });
  }
  mkdirPrivate(dir);
  writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: now, files }, null, 2));
  if (!verifyBackup(dir)) throw new Error('backup did not verify');
  return dir;
}
/** Manifest file paths, or the explicit rollback root: links below either intended root cannot redirect restore. */
function migrationFile(root, relative, allowThreadRoot = false, replaceLeafLink = false) {
  if (typeof relative !== 'string') throw new Error('Invalid migration restore path');
  const parts = relative.split(/[\\/]/);
  if (
    (relative !== 'ui-state.json' && !(parts[0] === 'threads' && (parts.length > 1 || allowThreadRoot))) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid migration restore path');
  const base = fs.realpathSync(root);
  const file = path.join(base, relative);
  let current = base;
  for (const part of path.relative(base, file).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() && (!replaceLeafLink || current !== file))
      throw new Error('A migration restore path is redirected by a link');
  }
  return file;
}

/** Every file the manifest lists is there with the same size and hash. */
function verifyBackup(dir) {
  const m = readJson(path.join(dir, 'manifest.json'));
  if (!m || !Array.isArray(m.files)) return false;
  try {
    return m.files.every((f) => {
      const file = migrationFile(dir, f.path);
      const info = fs.statSync(file);
      return info.isFile() && info.size === f.size && sha256(file) === f.sha256;
    });
  } catch {
    return false;
  }
}
/** Keep the newest KEEP_BACKUPS; older ones also go once they are past 90 days. */
function pruneBackups(userData, label, now) {
  const root = path.join(userData, 'backups');
  let names = [];
  try {
    names = fs
      .readdirSync(root)
      .filter((n) => n.startsWith(label + '-'))
      .sort();
  } catch {
    return;
  }
  names.forEach((n, i) => {
    const newest = i === names.length - 1;
    const created = readJson(path.join(root, n, 'manifest.json'))?.createdAt ?? 0;
    if (!newest && (i < names.length - KEEP_BACKUPS || now - created > BACKUP_MAX_AGE))
      fs.rmSync(path.join(root, n), { recursive: true, force: true });
  });
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

/**
 * Run one migration unless migrations.json says it already finished. Backs up first (a run that
 * crashed reuses the backup it took, named in the .migrating lock), writes a report with the
 * counts, and on a count mismatch rolls back and records the failure so it is not retried on its
 * own. Returns { id, result: 'done'|'ok'|'failed'|'deferred'|'newer'|'restored', ... }.
 */
function runMigration(m, userData, opts = {}) {
  const now = opts.now ?? Date.now();
  const prior = lastEntry(userData, m.id);
  if (prior && ['ok', 'failed', 'restored'].includes(prior.result))
    return { id: m.id, result: prior.result === 'ok' ? 'done' : prior.result, report: prior.report ?? null };
  const uiFile = path.join(userData, 'ui-state.json');
  const ui = readJsonRecord(uiFile, {});
  if (typeof ui.stateVersion === 'number' && ui.stateVersion > m.STATE_VERSION) return { id: m.id, result: 'newer' };

  const lock = readJson(lockFile(userData));
  let dir = lock && lock.id === m.id && typeof lock.backup === 'string' && verifyBackup(lock.backup) ? lock.backup : null;
  if (!dir) {
    const need = bytes(userData, backupSources(userData)) * 2;
    if ((opts.freeBytes ?? freeBytes)(userData) < need) return { id: m.id, result: 'deferred', reason: 'disk' };
    dir = backup(userData, 'pre-v2', now);
    pruneBackups(userData, 'pre-v2', now);
    writeAtomic(lockFile(userData), JSON.stringify({ id: m.id, pid: process.pid, at: now, backup: dir }));
  }

  const r = m.run({ userData, now, crashAfter: opts.crashAfter });
  const report = path.join(userData, 'migrations', `report-${stamp(now)}.json`);
  writeAtomic(
    report,
    JSON.stringify(
      {
        id: m.id,
        at: now,
        appVersion: opts.appVersion ?? null,
        backup: dir,
        ok: r.ok,
        before: r.before,
        after: r.after,
        failed: r.failed,
        written: r.written,
      },
      null,
      2,
    ),
  );
  if (!r.ok) m.rollback({ userData });
  else {
    if (m.migratePrefs) m.migratePrefs(userData, opts);
    const cur = readJsonRecord(uiFile);
    if (cur) writeAtomic(uiFile, JSON.stringify({ ...cur, stateVersion: m.STATE_VERSION }, null, 2));
  }
  // counts only (the migration report in telemetry reads them): chats written, left as they were, and not written
  const failedN = Array.isArray(r.failed) ? r.failed.length : 0;
  const written = Number(r.written) || 0;
  const counts = { migrated: written, skipped: Math.max(0, (Number(r.before?.chats) || 0) - written - failedN), failed: failedN };
  record(userData, { id: m.id, at: now, appVersion: opts.appVersion ?? null, backup: dir, result: r.ok ? 'ok' : 'failed', report, counts });
  fs.rmSync(lockFile(userData), { force: true });
  return { id: m.id, result: r.ok ? 'ok' : 'failed', report, before: r.before, after: r.after, counts };
}

/** All data migrations in order; the first one that doesn't finish stops the rest. */
function runMigrations(userData, opts = {}) {
  const out = [];
  for (const m of MIGRATIONS) {
    const r = runMigration(m, userData, opts);
    out.push(r);
    if (!['ok', 'done'].includes(r.result)) break;
  }
  return out;
}

/** The legacy keys of ui-state.json a restore puts back; prefs and the window's own keys stay as they are now. */
const LEGACY_UI_KEYS = ['pinned', 'unread', 'worktreeOf', 'claudeArchived', 'claudeChats', 'segments'];

/** What Settings shows for a migration: its last result, the report's counts and failed chats, and its backup. */
function migrationReport(userData, id = MIGRATIONS[0].id) {
  const e = lastEntry(userData, id);
  if (!e) return null;
  const report = typeof e.report === 'string' ? readJson(e.report, null) : null;
  return {
    id,
    result: e.result,
    at: e.at ?? null,
    appVersion: e.appVersion ?? null,
    report,
    backup: typeof e.backup === 'string' ? e.backup : null,
    backupOk: typeof e.backup === 'string' && verifyBackup(e.backup),
  };
}

/**
 * Put the pre-migration data back: the v2 files go, the backup's thread files and the legacy keys of
 * ui-state.json return, and the run is recorded as 'restored' so it is not tried again until Retry.
 * Returns the new entry, or null when there is no backup that still verifies.
 */
function restoreMigration(userData, id = MIGRATIONS[0].id, opts = {}) {
  const m = MIGRATIONS.find((x) => x.id === id);
  const e = lastEntry(userData, id);
  if (!m || !e || typeof e.backup !== 'string' || !verifyBackup(e.backup)) return null;
  const manifest = readJson(path.join(e.backup, 'manifest.json'));
  // Rollback owns threads even when the manifest has no thread rows. Resolve both intended roots once.
  const profileRoot = fs.realpathSync(userData);
  const backupRoot = fs.realpathSync(e.backup);
  const threads = migrationFile(profileRoot, 'threads', true);
  const threadInfo = fs.statSync(threads, { throwIfNoEntry: false });
  if (threadInfo && !threadInfo.isDirectory()) throw new Error('Invalid migration restore threads path');
  // Check every destination before rollback changes any current chat, including missing nested folders.
  const files = manifest.files.map((f) => {
    const target = migrationFile(profileRoot, f.path, false, true);
    const info = fs.statSync(target, { throwIfNoEntry: false });
    if (info && !info.isFile()) throw new Error('Invalid migration restore file path');
    return { ...f, source: migrationFile(backupRoot, f.path), target };
  });
  m.rollback({ userData: profileRoot });
  for (const f of files) {
    const to = f.target;
    if (f.path === 'ui-state.json') {
      const old = readJsonRecord(f.source, {});
      const cur = readStateFile(to, 'the app state (ui-state.json)', isJsonRecord) ?? {};
      const next = { ...cur };
      delete next.stateVersion;
      for (const k of LEGACY_UI_KEYS) if (k in old) next[k] = old[k];
      writeAtomic(to, JSON.stringify(next, null, 2), fs, fs.statSync(f.source).mode);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Replacement breaks a destination hard link instead of changing every alias of its inode.
      writeAtomic(to, fs.readFileSync(f.source), fs, fs.statSync(f.source).mode);
    }
  }
  fs.rmSync(lockFile(profileRoot), { force: true });
  const entry = {
    id,
    at: opts.now ?? Date.now(),
    appVersion: opts.appVersion ?? null,
    backup: e.backup,
    result: 'restored',
    report: e.report ?? null,
  };
  record(profileRoot, entry);
  return entry;
}

/** Settings' Retry after a failed run: forget the failure and run again. */
function retryMigration(userData, id, opts = {}) {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (!m) return null;
  writeAtomic(
    registryFile(userData),
    JSON.stringify(
      readRegistry(userData).filter((e) => e.id !== m.id),
      null,
      2,
    ),
  );
  return runMigration(m, userData, opts);
}

module.exports = {
  APP_NAME,
  STORAGE_NAME,
  userDataDir,
  migrateUserData,
  runMigrations,
  runMigration,
  retryMigration,
  migrationReport,
  restoreMigration,
  backup,
  verifyBackup,
  pruneBackups,
  readRegistry,
  lastEntry,
  record,
};
