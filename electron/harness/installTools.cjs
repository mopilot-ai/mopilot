// What a harness install line needs from this machine: npm and Homebrew on the login-shell PATH, and whether npm's
// global folder can be written without admin rights (we never run sudo).
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** `prefix=` from an .npmrc's text, with a leading ~ expanded. */
function npmrcPrefix(text, home) {
  const m = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(text);
  return m ? m[1].replace(/^~(?=$|[\\/])/, home) : null;
}

/**
 * npm's global prefix as npm would pick it, without running npm: the environment, then ~/.npmrc, then npm's default
 * (the prefix its binary lives in, <prefix>/bin/npm; %APPDATA%\npm on Windows).
 */
function npmPrefix({ npmBin, env, home, platform, readFile }) {
  const fromEnv = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (fromEnv) return fromEnv;
  try {
    const p = npmrcPrefix(readFile(path.join(home, '.npmrc')), home);
    if (p) return p;
  } catch (error) {
    // no ~/.npmrc: npm's own default applies
    noteIgnored("read the user's .npmrc", error, ['ENOENT', 'EISDIR', 'EACCES']);
  }
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'npm') : path.dirname(npmBin);
  return path.dirname(path.dirname(npmBin));
}

/** Whether `dir` (or, before it exists, the nearest folder above it) can be written. */
function writable(dir, access) {
  try {
    access(dir, fs.constants.W_OK);
    return true;
  } catch (error) {
    // there but not ours (EACCES, EPERM): npm would need admin rights
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') return false;
  }
  const up = path.dirname(dir);
  return up !== dir && writable(up, access);
}

/**
 * @param {{ which: (name: string) => string | null, env: Record<string, string | undefined>, platform?: string,
 *   home?: string, readFile?: (p: string) => string, access?: (p: string, mode: number) => void }} o
 * @returns {{ npm: boolean, brew: boolean, npmWritable: boolean | null }}
 */
function installTools({
  which,
  env,
  platform = process.platform,
  home = os.homedir(),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  access = fs.accessSync,
}) {
  // Windows' lookup follows PATHEXT, so this finds npm.cmd there
  const npmBin = which('npm');
  const brew = platform !== 'win32' && !!which('brew');
  if (!npmBin) return { npm: false, brew, npmWritable: null };
  const prefix = npmPrefix({ npmBin, env, home, platform, readFile });
  // global packages go to <prefix>/lib/node_modules (<prefix>\node_modules on Windows)
  const target = platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  return { npm: true, brew, npmWritable: writable(target, access) };
}

module.exports = { installTools, npmPrefix, npmrcPrefix };
