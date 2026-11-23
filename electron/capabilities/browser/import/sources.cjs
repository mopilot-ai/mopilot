// Which browsers can be imported from on this machine: their data folders, profiles (Chromium family) and whether macOS lets us read them (Safari).
const { fs: nodeFs } = require('../../../platform/ports/fs.cjs');
const nodeOs = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../../../ignored.cjs');
const { CHROMIUM_BROWSERS } = require('../chromiumBrowsers.cjs');

/** @typedef {{ id: string, name: string, path: string }} Profile */
/** @typedef {{ id: string, name: string, kind: 'chromium' | 'safari', root: string, keychainService: string | null, status: 'ready' | 'needs_full_disk_access' | 'not_installed' | 'unsupported', profiles: Profile[] }} Source */

/**
 * The Chromium-family browsers MoPilot imports from (those with a Safe Storage keychain item), in display
 * order; `dir` is under ~/Library/Application Support.
 */
const CHROMIUM = CHROMIUM_BROWSERS.filter((b) => b.service).map((b) => ({ id: b.id, name: b.name, dir: b.mac, service: b.service }));

const PROFILE_DIR = /^(Default|Profile \d+)$/;
/** Highest "Profile n" looked for when the folder can't be listed. */
const MAX_PROBED_PROFILE = 50;

/** macOS refused the read: since macOS 27 another app's data folder needs Full Disk Access, though stat still works. */
function isBlocked(error) {
  const code = /** @type {any} */ (error)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/** A profile id names one child folder, never its root or parent. @param {string} id */
function isProfileName(id) {
  return id !== '' && id !== '.' && id !== '..' && id === path.basename(id);
}

/** Default first, then "Profile n" by number. */
function profileRank(id) {
  const m = /^Profile (\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

/** @param {Profile} a @param {Profile} b */
function compareProfiles(a, b) {
  return profileRank(a.id) - profileRank(b.id);
}

/** @param {typeof import('node:fs')} fs @param {string} dir */
function isDirectory(fs, dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    noteIgnored('check a browser profile folder', error, ['ENOENT', 'ENOTDIR']);
    return false;
  }
}

/**
 * Profile names Chromium keeps in Local State, as [directory, display name]; null when unreadable or empty.
 * @param {typeof import('node:fs')} fs
 * @param {string} root
 * @returns {[string, string][] | null}
 */
function localStateProfiles(fs, root) {
  try {
    const info = JSON.parse(String(fs.readFileSync(path.join(root, 'Local State'), 'utf8')))?.profile?.info_cache;
    const entries = Object.entries(info && typeof info === 'object' ? info : {});
    return entries.length ? entries.map(([key, v]) => [key, String(v?.name || v?.gaia_name || key)]) : null;
  } catch (error) {
    if (isBlocked(error)) throw error;
    noteIgnored('read the browser profile list', error, ['ENOENT']);
    return null;
  }
}

/**
 * Existing profile directories, from Local State or, without it, by name. Throws when macOS blocks reading the folder.
 * @param {typeof import('node:fs')} fs
 * @param {string} root
 * @returns {Profile[]}
 */
function listProfiles(fs, root) {
  /** @type {[string, string][] | null} */
  let named = localStateProfiles(fs, root);
  if (!named) {
    try {
      named = fs
        .readdirSync(root)
        .filter((n) => PROFILE_DIR.test(n))
        .map((n) => [n, n]);
    } catch (error) {
      if (isBlocked(error)) throw error;
      noteIgnored('list browser profile folders', error, ['ENOENT', 'ENOTDIR']);
      named = [];
    }
  }
  return named
    .filter(([id]) => isProfileName(id) && isDirectory(fs, path.join(root, id)))
    .map(([id, name]) => ({ id, name, path: path.join(root, id) }))
    .sort(compareProfiles);
}

/**
 * Profile folders found by name when the browser's folder can't be read (stat still works there): Default and Profile 1…n.
 * @param {typeof import('node:fs')} fs
 * @param {string} root
 * @returns {Profile[]}
 */
function probeProfiles(fs, root) {
  const ids = ['Default', ...Array.from({ length: MAX_PROBED_PROFILE }, (_, i) => `Profile ${i + 1}`)];
  return ids.filter((id) => isDirectory(fs, path.join(root, id))).map((id) => ({ id, name: id, path: path.join(root, id) }));
}

/**
 * A Chromium-family browser's status and profiles on macOS.
 * @param {typeof import('node:fs')} fs
 * @param {string} root
 * @returns {{ status: 'ready' | 'needs_full_disk_access' | 'not_installed', profiles: Profile[] }}
 */
function chromiumStatus(fs, root) {
  // a data folder with no profile is not a browser to import from: other apps create it to register a native
  // messaging host (`NativeMessagingHosts`) whether or not that browser was ever installed
  if (!isDirectory(fs, root)) return { status: 'not_installed', profiles: [] };
  try {
    const profiles = listProfiles(fs, root);
    return profiles.length ? { status: 'ready', profiles } : { status: 'not_installed', profiles: [] };
  } catch {
    // listProfiles throws only when macOS blocks the folder: find the profiles by name and ask for Full Disk Access
    const profiles = probeProfiles(fs, root);
    return profiles.length ? { status: 'needs_full_disk_access', profiles } : { status: 'not_installed', profiles: [] };
  }
}

/**
 * @param {typeof import('node:fs')} fs
 * @param {string} root
 * @returns {'ready' | 'needs_full_disk_access' | 'not_installed'}
 */
function safariStatus(fs, root) {
  try {
    fs.statSync(root);
    fs.readdirSync(root);
    fs.accessSync(path.join(root, 'History.db'), nodeFs.constants.R_OK);
    return 'ready';
  } catch (error) {
    return isBlocked(error) ? 'needs_full_disk_access' : 'not_installed';
  }
}

/**
 * Every supported source with its status and profiles, in a fixed order.
 * @param {{ home?: string, platform?: string, fs?: typeof import('node:fs') }} [o]
 * @returns {Source[]}
 */
function listSources({ home = nodeOs.homedir(), platform = process.platform, fs = nodeFs } = {}) {
  const mac = platform === 'darwin';
  const support = path.join(home, 'Library', 'Application Support');
  /** @type {Source[]} */
  const out = CHROMIUM.map((b) => {
    const root = path.join(support, b.dir);
    /** @type {Source} */
    const s = { id: b.id, name: b.name, kind: 'chromium', root, keychainService: b.service, status: 'unsupported', profiles: [] };
    return mac ? { ...s, ...chromiumStatus(fs, root) } : s;
  });
  const safariRoot = path.join(home, 'Library', 'Safari');
  /** @type {Source} */
  const safari = {
    id: 'safari',
    name: 'Safari',
    kind: 'safari',
    root: safariRoot,
    keychainService: null,
    status: 'unsupported',
    profiles: [],
  };
  if (mac) {
    safari.status = safariStatus(fs, safariRoot);
    safari.profiles = [{ id: 'Safari', name: 'Safari', path: safariRoot }];
  }
  out.push(safari);
  return out;
}

module.exports = { listSources };
