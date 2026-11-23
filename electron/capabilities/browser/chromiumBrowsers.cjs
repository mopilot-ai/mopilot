// The Chromium-family browsers and their user data folders (profiles, native messaging hosts) on each platform: one list for every reader (import sources, the browser extension probes, the Claude in Chrome migration note), plus the scratch profile MoPilot was pointed at.
const os = require('node:os');
const path = require('node:path');

/**
 * @typedef {{ id: string, name: string, mac: string, win: string | null, linux: string | null, service: string | null }} ChromiumBrowser
 *   mac: under ~/Library/Application Support; win: under %LOCALAPPDATA%; linux: under ~/.config (null where the
 *   browser has no build); service: its Safe Storage keychain item on macOS, null where MoPilot doesn't import from it
 */

/** @type {readonly ChromiumBrowser[]} Google Chrome first, then each family's release before its other channels. */
const CHROMIUM_BROWSERS = Object.freeze([
  {
    id: 'chrome',
    name: 'Google Chrome',
    mac: 'Google/Chrome',
    win: 'Google/Chrome/User Data',
    linux: 'google-chrome',
    service: 'Chrome Safe Storage',
  },
  {
    id: 'chrome-beta',
    name: 'Google Chrome Beta',
    mac: 'Google/Chrome Beta',
    win: 'Google/Chrome Beta/User Data',
    linux: 'google-chrome-beta',
    service: null,
  },
  {
    id: 'chrome-dev',
    name: 'Google Chrome Dev',
    mac: 'Google/Chrome Dev',
    win: 'Google/Chrome Dev/User Data',
    linux: 'google-chrome-unstable',
    service: null,
  },
  {
    id: 'chrome-canary',
    name: 'Google Chrome Canary',
    mac: 'Google/Chrome Canary',
    win: 'Google/Chrome SxS/User Data',
    linux: null,
    service: null,
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    mac: 'Microsoft Edge',
    win: 'Microsoft/Edge/User Data',
    linux: 'microsoft-edge',
    service: 'Microsoft Edge Safe Storage',
  },
  {
    id: 'edge-beta',
    name: 'Microsoft Edge Beta',
    mac: 'Microsoft Edge Beta',
    win: 'Microsoft/Edge Beta/User Data',
    linux: 'microsoft-edge-beta',
    service: null,
  },
  {
    id: 'edge-dev',
    name: 'Microsoft Edge Dev',
    mac: 'Microsoft Edge Dev',
    win: 'Microsoft/Edge Dev/User Data',
    linux: 'microsoft-edge-dev',
    service: null,
  },
  {
    id: 'edge-canary',
    name: 'Microsoft Edge Canary',
    mac: 'Microsoft Edge Canary',
    win: 'Microsoft/Edge SxS/User Data',
    linux: null,
    service: null,
  },
  {
    id: 'brave',
    name: 'Brave',
    mac: 'BraveSoftware/Brave-Browser',
    win: 'BraveSoftware/Brave-Browser/User Data',
    linux: 'BraveSoftware/Brave-Browser',
    service: 'Brave Safe Storage',
  },
  { id: 'chromium', name: 'Chromium', mac: 'Chromium', win: 'Chromium/User Data', linux: 'chromium', service: 'Chromium Safe Storage' },
  { id: 'vivaldi', name: 'Vivaldi', mac: 'Vivaldi', win: 'Vivaldi/User Data', linux: 'vivaldi', service: 'Vivaldi Safe Storage' },
  { id: 'arc', name: 'Arc', mac: 'Arc/User Data', win: null, linux: null, service: 'Arc Safe Storage' },
]);

/**
 * A browser's user data folder on this platform; null where it has no build.
 * @param {ChromiumBrowser} b
 * @param {{ home?: string, platform?: string, env?: Record<string, string|undefined> }} [o]
 */
function browserUserData(b, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', ...b.mac.split('/'));
  if (platform === 'win32') return b.win && path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), ...b.win.split('/'));
  return b.linux && path.join(home, '.config', ...b.linux.split('/'));
}

/**
 * Every Chromium-family browser's user data folder on this platform, Google Chrome's first, whether or not
 * the browser is installed (callers look inside).
 * @param {{ home?: string, platform?: string, env?: Record<string, string|undefined> }} [o]
 * @returns {{ id: string, name: string, dir: string }[]}
 */
function chromiumUserDataDirs(o = {}) {
  return CHROMIUM_BROWSERS.flatMap((b) => {
    const dir = browserUserData(b, o);
    return dir ? [{ id: b.id, name: b.name, dir }] : [];
  });
}

/**
 * The Google Chrome folder MoPilot's Chrome tools were pointed at (MOPILOT_CHROME_RELAY_USER_DATA_DIR: the
 * Chrome comparison's scratch profile, where it also runs the vendors' extensions), then every Chromium-family
 * browser's own folder: where a vendor Chrome controller's native host and extension can be. Each folder once.
 * @param {{ home?: string, platform?: string, env?: Record<string, string|undefined> }} [o]
 * @returns {{ id: string, name: string, dir: string }[]}
 */
function vendorChromeUserDataDirs(o = {}) {
  const own = chromiumUserDataDirs(o);
  const relay = (o.env ?? process.env).MOPILOT_CHROME_RELAY_USER_DATA_DIR;
  if (!relay) return own;
  const dir = path.resolve(relay);
  return [{ id: CHROMIUM_BROWSERS[0].id, name: CHROMIUM_BROWSERS[0].name, dir }, ...own.filter((b) => b.dir !== dir)];
}

module.exports = { CHROMIUM_BROWSERS, browserUserData, chromiumUserDataDirs, vendorChromeUserDataDirs };
