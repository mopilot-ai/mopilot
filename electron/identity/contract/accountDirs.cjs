// Where an added Claude Code login's config folder is: the CLAUDE_CONFIG_DIR it signed in with, kept across moves.
//
// On macOS the CLI names a login's keychain item after a hash of the literal CLAUDE_CONFIG_DIR string, and it does
// not resolve links (CLI 2.1.302), so that string, not the folder, is what finds the login. Each account record keeps
// it as `configDir`. When the folder moved with MoPilot's data folder (the Sage Codex rename, a moved or copied
// profile), a link at the recorded path reaches the moved folder, so the hash still matches; elsewhere the CLI's
// .credentials.json moved with the folder and the link reaches it too. MoPilot never copies, stores or refreshes the
// credential; the CLI owns all credential access and refresh.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { readJsonRecord, writePrivate } = require('../../platform/fsutil.cjs');
const { isAccountState, accountConfigDir } = require('./accountState.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * Locks the CLI takes in its config folder around its own login: token refresh and credential writes (a folder made
 * with mkdir, and its owner record). Never shared: a link to ~/.claude's makes the login wait on another login's lock,
 * and one left dangling once that lock is released can never be taken, so the token is never refreshed (#1582).
 */
const isLockEntry = (name) => /\.lock(\.owner)?$|^\.storage-write/.test(name);

/**
 * Remove a link; a junction to a folder (Windows) is removed as a folder. The folder it points at stays.
 * @param {string} link @param {Pick<typeof fs, 'unlinkSync' | 'rmdirSync'>} [f]
 */
function removeLink(link, f = fs) {
  try {
    f.unlinkSync(link);
  } catch (error) {
    if (!['EPERM', 'EISDIR'].includes(/** @type {any} */ (error)?.code)) throw error;
    f.rmdirSync(link);
  }
}

/**
 * ~/.claude folders each account keeps as its own instead of a link. The CLI lets a session write its own plan file
 * without asking only when the plans folder is not a link: it checks the file's resolved path against the folder's
 * unresolved one (CLI 2.1.306), so a link to ~/.claude/plans turned every plan into an Edit card (#1933).
 */
const OWN_FOLDERS = ['plans'];

/**
 * Make a link an earlier version left at an own folder a real folder again, holding a copy of what it reached, so
 * the plans of chats already run on this account stay at the paths their plan cards name (a chat resumed on another
 * login gets its plan back from the CLI's own recovery). The copy is made beside the link and moved into place, so
 * a copy that fails leaves the link to be tried again at the next start.
 * @param {string} dir @param {Pick<typeof fs, 'lstatSync' | 'realpathSync' | 'unlinkSync' | 'rmdirSync' | 'mkdirSync' | 'cpSync' | 'renameSync' | 'rmSync'>} [f]
 */
function ownFolders(dir, f = fs) {
  for (const n of OWN_FOLDERS) {
    const link = path.join(dir, n);
    const copy = `${link}.own`;
    try {
      if (!f.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
      /** @type {string | null} */
      let target = null;
      try {
        target = f.realpathSync(link);
      } catch (error) {
        // a dangling link reaches nothing to copy
        noteIgnored("resolve a Claude Code account's old shared link", error, ['ENOENT']);
      }
      f.rmSync(copy, { recursive: true, force: true });
      if (target) f.cpSync(target, copy, { recursive: true });
      else f.mkdirSync(copy, { mode: 0o700 });
      removeLink(link, f);
      try {
        f.renameSync(copy, link);
      } catch (error) {
        // a CLI on this account made the folder meanwhile: what it wrote stays, the copies join it
        noteIgnored(`move the Claude Code account's own ${n} folder into place`, error, ['ENOTEMPTY', 'EEXIST']);
        f.cpSync(copy, link, { recursive: true, force: false });
      }
    } catch (error) {
      noteIgnored(`make the Claude Code account's ${n} folder its own`, error);
    } finally {
      f.rmSync(copy, { recursive: true, force: true });
    }
  }
}

/**
 * Remove links to lock entries an earlier version made in an account folder; the CLI's own locks there stay. Best
 * effort: the CLI takes and releases its locks meanwhile, and a link left is tried again at the next start.
 * @param {string} dir @param {Pick<typeof fs, 'readdirSync' | 'lstatSync' | 'unlinkSync' | 'rmdirSync'>} [f]
 */
function unlinkLocks(dir, f = fs) {
  let names = [];
  try {
    names = f.readdirSync(dir).filter(isLockEntry);
  } catch (error) {
    // a folder not made yet has nothing to clean
    noteIgnored('list a Claude Code account folder for lock links', error, ['ENOENT']);
  }
  for (const n of names) {
    const link = path.join(dir, n);
    try {
      if (!f.lstatSync(link).isSymbolicLink()) continue;
      removeLink(link, f);
    } catch (error) {
      // released by the CLI since the folder was listed (ENOENT), or not removable: the CLI then waits on it as before
      noteIgnored("remove a lock link from a Claude Code account's folder", error, ['ENOENT']);
    }
  }
}

/**
 * Link a shared ~/.claude entry (or a moved account folder) into place. Windows only lets admins (or Developer
 * Mode) make symlinks, so folders become junctions and files hard links there.
 */
function linkShared(target, link, platform = process.platform) {
  if (platform !== 'win32') return fs.symlinkSync(target, link);
  if (fs.statSync(target).isDirectory()) return fs.symlinkSync(target, link, 'junction');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch {
    fs.linkSync(target, link);
  }
}
/** A link already points at `target` (junctions read back as absolute paths, any case, maybe a trailing \). */
function linksTo(link, target, platform = process.platform) {
  const got = fs.readlinkSync(link);
  if (platform !== 'win32') return got === target;
  const norm = (p) =>
    path
      .resolve(p.replace(/^\\\\\?\\|^\\\?\?\\/, ''))
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return norm(got) === norm(target);
}

/**
 * A record saved before configDir existed (or with one that isn't this account's folder) is adopted at its folder
 * here, unconfirmed until a read there says signed in: the path its login was made with is not recorded anywhere.
 */
function adoptConfigDir(a, root) {
  if (accountConfigDir(a.configDir, a.id)) return;
  a.configDir = path.join(root, a.id);
  a.unconfirmed = true;
}

/**
 * The folder to run an account with: its recorded path, made to exist again when it is gone, as a link to the
 * folder that moved along with userData (`local`), or else an empty folder the CLI fills (on macOS the keychain item
 * is keyed by the path either way). When the recorded path can't be made (its parent is a file, or an old home
 * folder that is gone), the local folder, with `moved` set: its login was made at another path.
 */
function placeConfigDir(configDir, local) {
  if (fs.existsSync(configDir)) return { dir: configDir, moved: false };
  try {
    fs.mkdirSync(path.dirname(configDir), { recursive: true, mode: 0o700 });
    // a link left behind by a folder that was deleted since is replaced
    if (fs.lstatSync(configDir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(configDir);
    if (configDir !== local && fs.existsSync(local)) linkShared(local, configDir);
    else fs.mkdirSync(configDir, { mode: 0o700 });
    return { dir: configDir, moved: false };
  } catch (error) {
    noteIgnored("keep a Claude Code login's config folder at the path it signed in with", error);
    return { dir: local, moved: true };
  }
}

/** Delete a removed account's own files; the shared entries are links, unlinked first so removal never reaches ~/.claude. */
function clearFolder(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    // the folder may already be gone (ENOENT), and then there is nothing to delete
    noteIgnored("list a removed Claude Code account's folder", error, ['ENOENT']);
    return;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch (error) {
      // an entry gone meanwhile (the sign-out still cleaning up) is no link left behind
      if (/** @type {any} */ (error)?.code === 'ENOENT') continue;
      // a link that is still there leaves the whole folder in place
      noteIgnored("unlink a removed Claude Code account's shared entries", error);
      return;
    }
  }
  // a leftover folder is unused
  fs.rm(dir, { recursive: true, force: true }, (error) => error && noteIgnored('delete a removed Claude Code account', error));
}

/**
 * Delete what a removed account holds in this profile: its folder here, and the link at its recorded path when that
 * folder moved. A recorded path that is a real folder belongs to another profile (the original of a copied profile,
 * or an old one a cross-volume move left behind) and is left alone.
 */
function deleteAccountFolders(configDir, local) {
  if (configDir && configDir !== local && fs.lstatSync(configDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    try {
      fs.unlinkSync(configDir);
    } catch (error) {
      noteIgnored("unlink a removed Claude Code account's moved folder", error);
    }
  }
  clearFolder(local);
}

/**
 * The profile moved from `from` (migrate.cjs): every login it holds was made under the old profile, so record
 * that path as its config folder. Returns how many records it pinned; a file it can't read is left alone.
 */
function pinConfigDirs(userData, from) {
  const file = path.join(userData, 'claude-accounts.json');
  const state = readJsonRecord(file, null);
  if (!state || !isAccountState(state) || !state.accounts) return 0;
  let pinned = 0;
  for (const a of state.accounts) {
    if (accountConfigDir(a.configDir, a.id)) continue;
    a.configDir = path.join(from, 'claude-accounts', a.id);
    pinned++;
  }
  if (pinned) writePrivate(file, JSON.stringify(state, null, 2));
  return pinned;
}

/**
 * What main saw of each login (identity/contract/loginMarks.cjs: a limit, a lapse, how much is left), kept in a JSON file so a
 * restart still knows which login was out of usage. An unreadable or foreign file is no marks, and a failed write only
 * loses this save: the marks stay in memory.
 * @param {string} file
 */
function fileMarksStore(file) {
  return {
    load: () => readJsonRecord(file),
    save: (marks) => {
      try {
        writePrivate(file, JSON.stringify(marks));
      } catch (error) {
        noteIgnored('save the Claude login marks', error);
      }
    },
  };
}

module.exports = {
  fileMarksStore,
  isLockEntry,
  unlinkLocks,
  OWN_FOLDERS,
  ownFolders,
  linkShared,
  linksTo,
  adoptConfigDir,
  placeConfigDir,
  deleteAccountFolders,
  pinConfigDirs,
};
