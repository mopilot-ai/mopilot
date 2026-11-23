// Directory browsing on the Host, bounded to declared roots (design/host/index.html, package 2.7): every path is resolved through symlinks before it is compared with a root.
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

/**
 * @param {{ roots?: string[], home?: string, fsp?: typeof fs.promises }} [o] `roots` default to the Host user's home
 */
export function createHostFs({ roots, home = os.homedir(), fsp = fs.promises } = {}) {
  const declared = roots && roots.length > 0 ? roots : [home];

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

  /** The real path of an existing `p`, or the reason it has none. */
  async function existingPath(/** @type {unknown} */ p) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0'))
      throw new HostRefusal('invalid_path', 'Pick a folder by its full path.');
    try {
      return await fsp.realpath(p);
    } catch {
      throw new HostRefusal('directory_missing', 'That folder does not exist on this host.');
    }
  }

  /** The real path of an existing folder; no root bound, for a chat's own working folder. */
  async function existingDirectory(/** @type {unknown} */ p) {
    const real = await existingPath(p);
    if (!(await fsp.stat(real)).isDirectory()) throw new HostRefusal('not_a_directory', 'That is not a folder.');
    return real;
  }

  /** The real path of an existing `p` that lies inside a root; refuses anything else with a structured reason. */
  async function resolve(/** @type {unknown} */ p) {
    const real = await existingPath(p);
    if (!(await realRoots()).some((r) => isInside(r, real)))
      throw new HostRefusal('outside_roots', 'That folder is outside what this host shares.');
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
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!hidden && e.name.startsWith('.')) continue;
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

  return { roots: realRoots, resolve, requireDirectory, existingDirectory, list };
}
