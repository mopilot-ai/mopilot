// Opening a site in the user's own browser for a sign-in hand-off (browser/handoff.cjs): the browser and profile the chat's vendor Chrome controller is paired with, the profile MoPilot's Chrome tools use, else the default browser; in a run pinned to a scratch Chrome folder, only that folder.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { proc } = require('../../platform/ports/proc.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { pinnedChrome } = require('./userChrome.cjs');

/** macOS app names that differ from the browser's name in chromiumBrowsers.cjs. */
const MAC_APP = ownTable({ brave: 'Brave Browser' });

/**
 * Opens `url` with macOS's `open` in an app (by name, wherever it is installed), in a profile when one is named:
 * a running browser takes the URL in that profile's window. Resolves once `open` succeeded.
 * @param {string} url
 * @param {{ app: string, profile: string | null }} target
 * @param {typeof proc.spawn} spawn
 */
function openInMacApp(url, { app, profile }, spawn) {
  const args = profile ? ['-na', app, '--args', `--profile-directory=${profile}`, url] : ['-a', app, url];
  return new Promise((resolve, reject) => {
    const child = spawn('open', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${app} did not open (exit ${code})`))));
  });
}

/**
 * Opens the site for a route that opens it in the user's Chrome (shared/chromeHandoff.mjs opensInUserChrome):
 * - 'extension', 'relay', 'codex-extension': in the Chrome profile MoPilot's Chrome tools use (`openInChrome`, app/chromeRelay.cjs);
 * - 'claude-in-chrome', 'codex-browser-plugin': on macOS, in the browser and profile the vendor's extension is on
 *   (`vendorProfile`, nativeAvailability.cjs vendorChromeProfile), else Google Chrome.
 * Anything that can't open there opens in the default browser, where the user can still sign in.
 * A run pinned to a scratch Chrome folder (userChrome.cjs pinnedChrome: a contract, bench or comparison run) opens
 * every route in Chrome on that folder, a vendor's in the profile its extension is on there, and falls back to nothing:
 * `open -na` and the default browser would both open the default folder (#1535).
 * @param {string} url
 * @param {import('../../../shared/chromeHandoff.mjs').HandoffRoute} route
 * @param {{ openExternal: (url: string) => Promise<unknown>,
 *           openInChrome: (url: string, o: { profileDir: string }) => Promise<unknown>,
 *           vendorProfile: (controller: any, userData?: string) => { browser: string, name: string, profile: string } | null,
 *           profileDir?: string, platform?: string, spawn?: typeof proc.spawn, env?: Record<string, string | undefined> }} o
 *   vendorProfile: with `userData`, looks in that Chrome folder only
 */
async function openSiteForRoute(
  url,
  route,
  { openExternal, openInChrome, vendorProfile, profileDir = '', platform = process.platform, spawn = proc.spawn, env = process.env },
) {
  const pin = pinnedChrome(env);
  if (pin) {
    if ('refuse' in pin) throw new Error(pin.refuse);
    const vendor = route === 'claude-in-chrome' || route === 'codex-browser-plugin';
    return void (await openInChrome(url, { profileDir: vendor ? (vendorProfile(route, pin.dir)?.profile ?? '') : profileDir }));
  }
  try {
    if (route === 'extension' || route === 'relay' || route === 'codex-extension') return void (await openInChrome(url, { profileDir }));
    if (platform === 'darwin') {
      const paired = vendorProfile(route);
      const target = paired
        ? { app: MAC_APP[paired.browser] ?? paired.name, profile: paired.profile }
        : { app: 'Google Chrome', profile: null };
      return void (await openInMacApp(url, target, spawn));
    }
  } catch (error) {
    // not installed, or it didn't start: the default browser still lets the user sign in
    noteIgnored("open a site in the browser of the chat's Chrome controller", error);
  }
  await openExternal(url);
}

module.exports = { openSiteForRoute, openInMacApp };
