// Owner-only files in MoPilot's data folder (#2144): the folder is registered at startup (keepPrivate), writes through electron/platform/fsutil.cjs under it create files 0600 and folders 0700 and take group and other access off a file they replace, mkdirPrivate makes a folder only the user can open, and tightenTree takes group and other access off what an earlier version left there.
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
/** Chromium's own folders in the profile: it makes them owner-only itself, and they hold many files. */
const CHROMIUM = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'Shared Dictionary',
  'blob_storage',
  'Crashpad',
  'Partitions',
  'Session Storage',
  'Local Storage',
  'IndexedDB',
  'Service Worker',
  'WebStorage',
]);
/** Folders whose sub-folders are a harness's own home (Codex's CODEX_HOME, Claude Code's config folder): each is made owner-only, not what the harness writes inside it. */
const HARNESS_HOMES = new Set(['accounts', 'claude-accounts', 'claude-cli-login', 'claude-login-check']);

/** @type {Set<string>} */
const roots = new Set();

/** Keep what fsutil writes under `root` owner-only from now on. */
function keepPrivate(/** @type {string} */ root) {
  roots.add(path.resolve(root));
}

/** Whether `p` is under a folder kept private. */
function isPrivatePath(/** @type {string} */ p) {
  const abs = path.resolve(p);
  for (const r of roots) if (abs === r || abs.startsWith(r + path.sep)) return true;
  return false;
}

/** `mode` without group and other access, keeping the user's own bits (an executable stays one). */
const ownerOnly = (/** @type {number} */ mode) => mode & PRIVATE_DIR;

/**
 * Makes `dir` (and the folders above it it creates) open to the user only. One already there loses group and other
 * access and keeps the user's own bits (a folder they made read-only stays so); a link is left alone.
 */
function mkdirPrivate(/** @type {string} */ dir, fileFs = fs) {
  fileFs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  const st = fileFs.lstatSync(dir);
  if (!st.isSymbolicLink() && st.mode & 0o077) fileFs.chmodSync(dir, ownerOnly(st.mode));
}

/**
 * Takes group and other access off everything under `root` an earlier version (or another writer) left open: folders
 * 0700 and files without group/other bits, never following a link. Chromium's folders are left alone, and a harness's
 * home is made owner-only without going through what the harness keeps in it. Runs in the background; returns how
 * many entries it changed. A failure on one entry is recorded and the rest go on.
 * @param {string} root
 * @returns {Promise<number>}
 */
async function tightenTree(root, fsp = fs.promises, platform = process.platform) {
  let changed = 0;
  // Windows keeps a profile per user with its own access lists, and reports every file as 0666: nothing to take away
  if (platform === 'win32') return changed;
  const tighten = async (/** @type {string} */ p, /** @type {import('node:fs').Stats} */ st) => {
    const want = ownerOnly(st.mode);
    if ((st.mode & 0o777) === want) return;
    await fsp.chmod(p, want);
    changed++;
  };
  /** @param {string} dir @param {'all' | 'homes'} depth 'homes': each entry made private, none gone into */
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      noteIgnored('list a data folder to make it private', error, ['ENOENT']);
      return;
    }
    for (const e of entries) {
      if (dir === root && CHROMIUM.has(e.name)) continue;
      const p = path.join(dir, e.name);
      try {
        // decided by lstat, not the entry: a network volume may not say the entry's type, and a link is never followed
        const st = await fsp.lstat(p);
        if (!st.isFile() && !st.isDirectory()) continue;
        await tighten(p, st);
        if (!st.isDirectory() || depth === 'homes') continue;
        await walk(p, dir === root && HARNESS_HOMES.has(e.name) ? 'homes' : 'all');
      } catch (error) {
        // gone meanwhile (ENOENT): nothing left to protect
        noteIgnored('make a data file private', error, ['ENOENT']);
      }
    }
  };
  try {
    await tighten(root, await fsp.lstat(root));
  } catch (error) {
    noteIgnored('make the data folder private', error, ['ENOENT']);
    return changed;
  }
  await walk(root, 'all');
  return changed;
}

module.exports = { PRIVATE_FILE, PRIVATE_DIR, keepPrivate, isPrivatePath, mkdirPrivate, ownerOnly, tightenTree };
