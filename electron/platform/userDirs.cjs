// The folders a user's command-line tools are installed in, one list for every harness detector and for child
// processes' PATH: npm's prefixes, nvm's and fnm's default Node, volta, mise and asdf shims, bun, pnpm,
// ~/.local/bin, Homebrew and cargo. A login shell that is fish, slow or non-interactive may not export them, and an
// app opened from the Dock never has them. Only folders that exist are listed. Windows: winbin.cjs finds CLIs there.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nvmBins, fnmBins, nodeBins, isDir } = require('./nodeManagers.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** The variables that move a manager's folder; read from the login shell's environment and this process's. */
const DIR_VARS = [
  'NVM_DIR',
  'FNM_DIR',
  'VOLTA_HOME',
  'BUN_INSTALL',
  'PNPM_HOME',
  'MISE_DATA_DIR',
  'ASDF_DATA_DIR',
  'NPM_CONFIG_PREFIX',
  'npm_config_prefix',
  'XDG_DATA_HOME',
];
/** How long a computed list is reused before the folders are looked at again (installs and nvm switches show up). */
const TTL_MS = 60_000;

/** `v` when it is an absolute path, else `fallback`. */
const abs = (v, fallback) => (v && path.isAbsolute(v) ? v : fallback);

/** The bin folder of the npm prefix NPM_CONFIG_PREFIX or ~/.npmrc names; null when neither names one. */
function npmPrefixBin(home, vars) {
  const fromEnv = vars.NPM_CONFIG_PREFIX || vars.npm_config_prefix;
  if (fromEnv && path.isAbsolute(fromEnv)) return path.join(fromEnv, 'bin');
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.npmrc'), 'utf8');
  } catch (error) {
    noteIgnored("read npm's prefix from ~/.npmrc", error, ['ENOENT', 'ENOTDIR', 'EISDIR']);
    return null;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*prefix\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1].trim().replace(/^["']|["']$/g, '');
    if (v.startsWith('~/')) v = path.join(home, v.slice(2));
    if (path.isAbsolute(v)) return path.join(v, 'bin');
  }
  return null;
}

/**
 * The user-tool folders that exist, in the order a terminal would reach them. With `everyNode`, every Node version nvm,
 * fnm and mise keep (newest first) comes after, for finding a CLI no PATH reaches; without it only the default ones,
 * which is what a child process's PATH gets. `keep` decides which folders are listed (default: those that exist).
 * @param {{ home?: string, vars?: Record<string, string | undefined>, everyNode?: boolean, platform?: string, keep?: (dir: string) => boolean }} [o]
 * @returns {string[]}
 */
function userToolDirs({ home = os.homedir(), vars = process.env, everyNode = false, platform = process.platform, keep = isDir } = {}) {
  if (platform === 'win32' || !home) return [];
  const data = abs(vars.XDG_DATA_HOME, path.join(home, '.local', 'share'));
  const mise = abs(vars.MISE_DATA_DIR, path.join(data, 'mise'));
  const fnmDirs = [
    ...new Set([abs(vars.FNM_DIR, ''), path.join(data, 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm')].filter(Boolean)),
  ];
  const nvm = nvmBins(abs(vars.NVM_DIR, path.join(home, '.nvm')));
  const fnm = fnmDirs.map(fnmBins);
  const list = [
    nvm.def,
    ...fnm.map((f) => f.def),
    path.join(abs(vars.VOLTA_HOME, path.join(home, '.volta')), 'bin'),
    path.join(mise, 'shims'),
    path.join(abs(vars.ASDF_DATA_DIR, path.join(home, '.asdf')), 'shims'),
    path.join(abs(vars.BUN_INSTALL, path.join(home, '.bun')), 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    npmPrefixBin(home, vars),
    abs(vars.PNPM_HOME, path.join(home, 'Library', 'pnpm')),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.cargo', 'bin'),
  ];
  if (everyNode) list.push(...nvm.all, ...fnm.flatMap((f) => f.all), ...nodeBins(path.join(mise, 'installs', 'node')));
  return [...new Set(list.filter((d) => d && keep(d)))];
}

/** @type {Map<string, { at: number, dirs: string[] }>} by home, platform, everyNode and DIR_VARS */
const cache = new Map();
/**
 * userToolDirs() for this home, reused for TTL_MS for the same variables: childEnv asks on every spawn, and every ACP
 * harness not on PATH asks (with everyNode) each time its row is listed.
 * @param {Record<string, string | undefined>} [vars]
 */
function defaultUserDirs(vars = process.env, now = Date.now(), everyNode = false) {
  const home = os.homedir();
  const key = JSON.stringify([home, process.platform, everyNode, ...DIR_VARS.map((k) => vars[k] ?? null)]);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.dirs;
  // a handful of homes and variable sets at most: one that changed leaves its old entries behind
  if (cache.size >= 8) cache.clear();
  const dirs = userToolDirs({ home, vars, everyNode });
  cache.set(key, { at: now, dirs });
  return dirs;
}
/** Look at the folders again on the next ask (after an install, or when PATH is refreshed). */
const forgetUserDirs = () => cache.clear();

module.exports = { userToolDirs, defaultUserDirs, forgetUserDirs, npmPrefixBin, DIR_VARS, TTL_MS };
