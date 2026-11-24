// Directory browsing on the Host, bounded to declared roots (design/host/index.html, package 2.7): every path is resolved through symlinks before it is compared with a root, and a path inside one of the Host's own folders (`denied`) is refused whether or not it exists. A hard link made INSIDE the roots to one of the Host's own files is a second name for the same file and cannot be told by a real-path check (making one needs a shell, which is what the sandbox of #5617 is for).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A structured refusal the app can show: `code` says why, the message is safe to display. */
export class HostRefusal extends Error {
  /** @param {'outside_roots' | 'directory_missing' | 'not_a_directory' | 'invalid_path' | 'clone_failed' | 'worktree_failed' | string} code the carry's codes (shared/host/codeCarry.mjs) too @param {string} message @param {object} [details] what a client may show or act on, sent with the refusal */
  constructor(code, message, details) {
    super(message);
    this.name = 'HostRefusal';
    this.code = code;
    if (details) this.details = details;
  }
}

/** Whether `child` is `root` or below it; compared by path segment, so `/home/ab` is not inside `/home/a`. */
export function isInside(/** @type {string} */ root, /** @type {string} */ child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Whether paths compare without regard to case here: the file systems of macOS and Windows are, by default. */
const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';
/** @param {string} p */
const fold = (p) => (FOLDS_CASE ? p.toLowerCase() : p);

/**
 * @param {{ roots?: string[], home?: string, fsp?: typeof fs.promises, denied?: string[] }} [o] `roots` default to the Host user's home; `denied`: folders no request may name, list, read or run a chat in, whatever the roots say (the Host's own data and config folders, its socket's folder, the places a login item or unit lives): judged by real path, so a link, a `..` or another spelling of the case does not reach them
 */
export function createHostFs({ roots, home = os.homedir(), fsp = fs.promises, denied = [] } = {}) {
  const declared = roots && roots.length > 0 ? roots : [home];

  /** The folders refused, as real paths where they exist (a link in their place is followed) and as written where they do not. */
  async function deniedReal() {
    const out = [];
    for (const d of denied) {
      try {
        out.push(await fsp.realpath(d));
      } catch {
        // one that does not exist yet is refused where it will be
        out.push(path.resolve(d));
      }
    }
    return out;
  }

  /** Refuses a real path that lies in a denied folder, in the words of a path outside the roots (it says nothing of what is there). @param {string} real */
  async function refuseDenied(real) {
    if ((await deniedReal()).some((d) => isInside(fold(d), fold(real))))
      throw new HostRefusal('outside_roots', 'That folder is outside what this host shares.');
  }

  /**
   * The names, relative to the real folder `dir`, of the denied folders below it: what a listing or a search of `dir` leaves out.
   * @param {string} dir
   */
  async function deniedUnder(dir) {
    const out = [];
    for (const d of await deniedReal()) if (d !== dir && isInside(fold(dir), fold(d))) out.push(path.relative(dir, d));
    return out;
  }

  /** The declared roots that exist, as real paths: a root that is itself a symlink bounds by its target. */
  async function realRoots() {
    const real = [];
    for (const r of declared) {
      try {
        real.push(await fsp.realpath(r));
      } catch {
        // a root that does not exist bounds nothing
      }
    }
    return real;
  }

  /**
   * Where `p` is by real path, whether or not it exists: a path that is not there is placed where it would be (the real path of its nearest existing parent, then the rest of its name), so a check of where it is can come before the answer that it is missing, and a missing name tells nothing a present one does not.
   * @param {unknown} p @returns {Promise<{ real: string, exists: boolean }>}
   */
  async function placeOf(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0'))
      throw new HostRefusal('invalid_path', 'Pick a folder by its full path.');
    try {
      return { real: await fsp.realpath(p), exists: true };
    } catch {
      let parent = path.resolve(p);
      let rest = '';
      // up to the nearest folder that is there (the root always is)
      for (;;) {
        rest = path.join(path.basename(parent), rest);
        parent = path.dirname(parent);
        try {
          return { real: path.join(await fsp.realpath(parent), rest), exists: false };
        } catch {
          // keep going up
        }
      }
    }
  }

  const missing = () => new HostRefusal('directory_missing', 'That folder does not exist on this host.');

  /** The real path of an existing folder; no root bound, for a chat's own working folder (the Host's own folders are still refused, whether or not the name exists). */
  async function existingDirectory(/** @type {unknown} */ p) {
    const { real, exists } = await placeOf(p);
    await refuseDenied(real);
    if (!exists) throw missing();
    if (!(await fsp.stat(real)).isDirectory()) throw new HostRefusal('not_a_directory', 'That is not a folder.');
    return real;
  }

  /** The real path of an existing `p` that lies inside a root; refuses anything else with a structured reason, the Host's own folders and anything outside the roots before it says a name is missing. */
  async function resolve(/** @type {unknown} */ p) {
    const { real, exists } = await placeOf(p);
    await refuseDenied(real);
    if (!(await realRoots()).some((r) => isInside(r, real)))
      throw new HostRefusal('outside_roots', 'That folder is outside what this host shares.');
    if (!exists) throw missing();
    return real;
  }

  /** The real path of an existing folder inside a root; refuses a file. */
  async function requireDirectory(/** @type {unknown} */ p) {
    const real = await resolve(p);
    if (!(await fsp.stat(real)).isDirectory()) throw new HostRefusal('not_a_directory', 'That is not a folder.');
    return real;
  }

  /**
   * The folders in `p`, for the picker; without a path, those of the first root that exists. A link that leaves the roots is left out, as is anything unreadable.
   * @param {{ path?: unknown, hidden?: boolean }} q
   */
  async function list({ path: p, hidden = false }) {
    const rs = await realRoots();
    const dir = await requireDirectory(p ?? rs[0]);
    const entries = [];
    const hiddenBelow = (await deniedUnder(dir)).map(fold);
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!hidden && e.name.startsWith('.')) continue;
      if (hiddenBelow.includes(fold(e.name))) continue;
      const full = path.join(dir, e.name);
      let real = full;
      try {
        if (e.isSymbolicLink()) real = await fsp.realpath(full);
        if (!rs.some((r) => isInside(r, real)) || !(await fsp.stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      const git = await fsp.stat(path.join(real, '.git')).then(
        () => true,
        () => false,
      );
      entries.push({ name: e.name, path: real, git });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: dir, roots: rs, entries };
  }

  return { roots: realRoots, resolve, requireDirectory, existingDirectory, list, deniedUnder, refuseDenied };
}

/**
 * The folders no request to the Host may name (`denied` above): its own data and config folders and its socket's, which hold the token the CLI proves itself with, the pairing and the keys, and the places where a login item or unit that would start something at the next sign-in lives. A client that may read files is never given these.
 * @param {{ dataDir: string, configDir: string, socketPath: string }} paths @param {string} [home]
 */
export const hostFolders = ({ dataDir, configDir, socketPath }, home = os.homedir()) => [
  dataDir,
  configDir,
  path.dirname(socketPath),
  path.join(home, 'Library', 'LaunchAgents'),
  path.join(home, '.config', 'systemd', 'user'),
  // the pinned runtime (`current/`) and the update staging (`incoming/`) the installer keeps
  path.join(home, '.mopilot-host'),
];
