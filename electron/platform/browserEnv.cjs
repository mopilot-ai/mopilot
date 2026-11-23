// The app's $BROWSER shim as a child's environment names it (capabilities/browser/browserShim.cjs writes the shim), and
// the overrides that take a child off it, so the platform's pty can start a sign-in without reaching up into the browser.
const SCRIPT_NAME = 'mopilot-browser.js';

/**
 * Overrides that take a child off the shim (null removes a variable): a sign-in (`claude auth login`)
 * opens an OAuth page whose redirect lands on the CLI's own localhost listener, which only works in the
 * user's own browser, never in a chat's pane. BROWSER goes back to the user's own, else the system opener.
 */
function systemBrowserEnv(env = {}) {
  const shim = (v) => typeof v === 'string' && v.endsWith(`/${SCRIPT_NAME}`);
  const own = env.MOPILOT_BROWSER_FALLBACK || (env.BROWSER && !shim(env.BROWSER) ? env.BROWSER : null);
  return { BROWSER: own, MOPILOT_BROWSER_SOCK: null, MOPILOT_BROWSER_TOKEN: null, MOPILOT_BROWSER_FALLBACK: null };
}

module.exports = { SCRIPT_NAME, systemBrowserEnv };
