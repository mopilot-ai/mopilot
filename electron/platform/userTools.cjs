// Finding a harness's CLI from a GUI app the way the user's terminal would, its version, and whether the terminal runs
// that same file: the one API every detector uses (Codex, Claude Code, every ACP harness) and that install and update
// build on. Folders: userDirs.cjs; versions: toolVersion.cjs; the login shell's PATH: env.cjs. Windows keeps winbin.cjs
// for its folders; PATH there is this process's.
//
//   resolveTool(names, { manual, extra })  → { path, source, offPath, terminal } | null   the binary to run
//   toolCandidates(names, extra, allPath)  → string[]                                    every place it may be
//   toolVersion(bin, { env, parse })       → Promise<string | null>                      (toolVersion.cjs)
//   fileVersion(bin)                       → string | null                               without spawning
//   pathStatus(bin, names)                 → { offPath, terminal }
//   searchDirs()                           → string[]                                    the user-tool folders
//   forgetVersion(bin)                                                                   after an install or update
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const shellEnv = require('./env.cjs');
const { userToolDirs, defaultUserDirs, forgetUserDirs } = require('./userDirs.cjs');
const { toolVersion, fileVersion, forgetVersion, stampOf } = require('./toolVersion.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** The file a path's links lead to, case-folded on Windows, for telling two paths to one binary apart from two binaries. */
function fileKey(p, platform = process.platform) {
  let real = p;
  try {
    real = fs.realpathSync(p);
  } catch (error) {
    noteIgnored('resolve a CLI path', error, ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES']);
  }
  return platform === 'win32' ? real.toLowerCase() : real;
}

/** The variables that move version managers' folders (env.cjs; an env module without them reads this process's). */
const dirVars = () => shellEnv.dirVars?.() ?? process.env;

/** A CLI shipped inside a desktop app (ChatGPT.app's codex, Claude desktop's claude-code): never meant to be on PATH. */
const APP_BUNDLED = /[\\/][^\\/]+\.app[\\/]Contents[\\/]|[\\/]Claude[\\/]claude-code[\\/]/;

/** Every user-tool folder that exists, each installed Node version's too: where a CLI no PATH reaches is looked for. */
const searchDirs = () => defaultUserDirs(dirVars(), Date.now(), true);

/**
 * Whether the terminal runs `bin` for these names. `terminal` is what the login shell's PATH finds first (null: none);
 * `offPath` is true when that is not the same file as `bin`. Both false/null when the login shell's PATH is unknown,
 * since a terminal that can't be asked can't be said to differ.
 * @param {string | null | undefined} bin
 * @param {string[]} names
 * @param {{ loginPath?: string | null }} [o] the PATH to check against (tests); default the login shell's
 * @returns {{ offPath: boolean, terminal: string | null }}
 */
function pathStatus(bin, names, o = {}) {
  const login = o.loginPath !== undefined ? o.loginPath : (shellEnv.loginPath?.() ?? null);
  // nothing to compare: no binary, a bare name left to PATH, a CLI an app ships inside itself, or no login shell
  if (!bin || !path.isAbsolute(bin) || APP_BUNDLED.test(bin) || login == null) return { offPath: false, terminal: null };
  let terminal = null;
  for (const n of names) {
    terminal = shellEnv.which(n, login);
    if (terminal) break;
  }
  return { offPath: !terminal || fileKey(terminal) !== fileKey(bin), terminal };
}

/** @typedef {{ offPath?: true, terminal?: string | null }} OffPathFields */
/**
 * @typedef {{ path: string, version: string | null, via?: string, from?: string } & OffPathFields} CliCandidate one
 *   installed copy of a CLI, with how it was installed (harness/installMethod.cjs installSource)
 */
/**
 * The status as optional fields: nothing when the terminal runs the same file, so an unchanged answer stays the same.
 * @param {string | null | undefined} bin
 * @param {string[]} names
 * @param {{ loginPath?: string | null }} [o]
 * @returns {OffPathFields}
 */
function offPathFields(bin, names, o) {
  const s = pathStatus(bin, names, o);
  return s.offPath ? { offPath: true, terminal: s.terminal } : {};
}

/**
 * Every place a CLI named one of `names` may be, most likely first, not checked for existence: what the child PATH runs
 * (the login shell's, then the user-tool folders), every user-tool folder including each installed Node version, then
 * the harness's own `extra` paths (app bundles, its installer's folder).
 * @param {string[]} names
 * @param {string[]} [extra] full paths
 * @param {boolean} [allPath] include copies shadowed on PATH
 */
function toolCandidates(names, extra = [], allPath = false) {
  if (allPath && process.platform === 'win32') {
    const { windowsCandidates } = require('./winbin.cjs');
    return [...new Set([...names.flatMap((n) => windowsCandidates(n, process.env)), ...extra])];
  }
  const dirs = userToolDirs({ vars: dirVars(), everyNode: true, keep: () => true });
  const onPath = allPath ? names.flatMap((n) => shellEnv.whichAll(n)) : names.map((n) => shellEnv.which(n));
  return [...new Set([...onPath, ...dirs.flatMap((d) => names.map((n) => path.join(d, n))), ...extra].filter(Boolean))];
}

/** Whether an automatic candidate points to an executable file, including a symlink to one. */
function runnableTool(bin) {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return fs.statSync(bin).isFile();
  } catch (error) {
    noteIgnored('look for an installed CLI', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return false;
  }
}

/** Read installed versions together. Re-read a replaced copy once and discard snapshots from files that changed again. */
async function versionedToolCopies(paths, versionOf) {
  const stamp = (bin) => stampOf(fileKey(bin));
  const read = async (bin) => ({ path: bin, stamp: stamp(bin), version: await versionOf(bin) });
  const copies = await Promise.all(paths.map(read));
  const current = await Promise.all(
    copies.map((copy) => (runnableTool(copy.path) && copy.stamp !== stamp(copy.path) ? read(copy.path) : copy)),
  );
  return current
    .filter((copy) => runnableTool(copy.path) && copy.stamp === stamp(copy.path))
    .map(({ path, version }) => ({ path, version }));
}

/**
 * The binary to run: the user's own path while it exists, else the first of `names` on the child PATH, else the first in
 * a user-tool folder (every Node version too) or `extra`. With whether the terminal runs it (pathStatus).
 * @param {string[]} names
 * @param {{ manual?: string | null, extra?: string[], exists?: (p: string) => boolean }} [o]
 * @returns {{ path: string, source: 'manual' | 'path' | 'known', offPath: boolean, terminal: string | null } | null}
 */
function resolveTool(names, { manual, extra = [], exists = fs.existsSync } = {}) {
  const found = (p, source) => ({ path: p, source, ...pathStatus(p, names) });
  if (manual && exists(manual)) return found(manual, 'manual');
  for (const n of names) {
    const p = shellEnv.which(n);
    if (p) return found(p, 'path');
  }
  for (const p of [...searchDirs().flatMap((d) => names.map((n) => path.join(d, n))), ...extra]) if (exists(p)) return found(p, 'known');
  return null;
}

/** Look at the folders and ask `bin`'s version again (after an install or update; no `bin`: every binary). */
function forgetTool(bin) {
  forgetUserDirs();
  forgetVersion(bin);
}

module.exports = {
  resolveTool,
  toolCandidates,
  runnableTool,
  versionedToolCopies,
  searchDirs,
  pathStatus,
  offPathFields,
  toolVersion,
  fileVersion,
  forgetVersion,
  forgetTool,
  fileKey,
};
