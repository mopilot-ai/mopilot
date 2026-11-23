// Opening a page in the user's Chrome or default browser: Chrome's executable, `openInChrome`, and `userShell`, Electron's shell with the one way main hands a URL to the system. A run pinned to a scratch Chrome folder (MOPILOT_CHROME_RELAY_USER_DATA_DIR) opens web pages only there, never in the default folder (#1535).
const path = require('node:path');
const { proc } = require('../../platform/ports/proc.cjs');

/** The variable a bench or contract run names its real Chrome with, behind bench/scratch-chrome.mjs (chromeGuard). */
const BENCH_CHROME = 'MOPILOT_SCRATCH_CHROME_REAL';

/**
 * The Chrome folder this run pinned MoPilot to: MOPILOT_CHROME_RELAY_USER_DATA_DIR, the scratch profile of a
 * contract, bench or Chrome comparison run. A bench run (MOPILOT_SCRATCH_CHROME_REAL) without one is refused rather
 * than sent to the default folder, which in the benchmark VM is a real, signed-in and synced profile. Null for a
 * real user: Chrome and the default browser open as they always do.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ dir: string } | { refuse: string } | null}
 */
function pinnedChrome(env = process.env) {
  if (env.MOPILOT_CHROME_RELAY_USER_DATA_DIR) return { dir: path.resolve(env.MOPILOT_CHROME_RELAY_USER_DATA_DIR) };
  if (env[BENCH_CHROME])
    return { refuse: 'This run names no scratch Chrome folder (MOPILOT_CHROME_RELAY_USER_DATA_DIR), so it opens no page in Chrome.' };
  return null;
}

/** Chrome's executable on this platform (an override wins). */
function chromeExecutable({ platform = process.platform, env = process.env } = {}) {
  if (env.MOPILOT_CHROME_RELAY_EXECUTABLE) return env.MOPILOT_CHROME_RELAY_EXECUTABLE;
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32')
    return path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  return 'google-chrome';
}

/**
 * Opens `url` in Chrome: in the given profile, and in the pinned scratch folder when the run set one.
 * Resolves once Chrome started; rejects when it can't be started, or when a bench run named no scratch folder.
 * @param {string} url
 * @param {{ profileDir?: string, env?: Record<string, string | undefined>, platform?: NodeJS.Platform, spawn?: typeof proc.spawn }} [o]
 */
function openInChrome(url, { profileDir = '', env = process.env, platform = process.platform, spawn = proc.spawn } = {}) {
  const pin = pinnedChrome(env);
  if (pin && 'refuse' in pin) return Promise.reject(new Error(pin.refuse));
  const args = [];
  if (pin) args.push(`--user-data-dir=${pin.dir}`);
  if (profileDir) args.push(`--profile-directory=${profileDir}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    const child = spawn(chromeExecutable({ platform, env }), args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(undefined);
    });
  });
}

/** A URL the system would hand to the default browser (a page), not to another app (mailto:, zoommtg:, System Settings). */
const opensInBrowser = (/** @type {string} */ url) => /^(https?|file):/i.test(String(url));

/**
 * Hands `url` to the system: a page opens in the default browser and an app link in its app (shell.openExternal).
 * In a run pinned to a scratch Chrome folder, a page opens in Chrome on that folder instead, since the default browser
 * would open the default profile; it is refused, not opened elsewhere, when the run named no folder.
 * @param {string} url
 * @param {{ openExternal: (url: string) => Promise<unknown>, env?: Record<string, string | undefined>,
 *           open?: typeof openInChrome }} o
 */
async function openExternal(url, { openExternal: system, env = process.env, open = openInChrome }) {
  if (!opensInBrowser(url) || !pinnedChrome(env)) return void (await system(url));
  await open(url, { env });
}

/**
 * Electron's shell with `openExternal` behind the guard above, and everything else its own: main takes the shell only
 * this way (main.cjs and each module that requires Electron's), so no link can reach the default folder in a pinned run.
 * @template {{ openExternal: (url: string, options?: any) => Promise<unknown> }} S
 * @param {S} shell
 * @param {{ env?: Record<string, string | undefined>, open?: typeof openInChrome }} [o] for tests: the run's environment and Chrome
 * @returns {S}
 */
function userShell(shell, o = {}) {
  // a stand-in Electron with no shell (unit tests) has no link to guard
  if (shell == null) return shell;
  // the caller's options pass through as given (none when it gave none)
  const guarded = (/** @type {string} */ url, /** @type {any[]} */ ...options) =>
    openExternal(url, { ...o, openExternal: (u) => shell.openExternal(u, ...options) });
  // the shell's own methods run on the shell itself, whatever Electron's bindings expect `this` to be; one bound copy
  // each. The proxy's target is its own empty object, so no property of Electron's shell constrains what it returns.
  const bound = new Map();
  return /** @type {S} */ (
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'openExternal') return guarded;
          const value = Reflect.get(shell, key);
          if (typeof value !== 'function') return value;
          if (!bound.has(key)) bound.set(key, value.bind(shell));
          return bound.get(key);
        },
      },
    )
  );
}

module.exports = { pinnedChrome, chromeExecutable, openInChrome, openExternal, userShell, opensInBrowser };
