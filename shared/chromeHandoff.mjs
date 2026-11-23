// "Open in Chrome" for every controller of the user's Chrome: which route a chat's sign-in hand-off takes, and what the agent is told to continue there. Pure, so main, the browser pane and the tests agree.
//
// A built-in browser page (a passkey, a sign-in that stalls) is handed to the user's real Chrome. Who continues
// there is the chat's Chrome controller on its current segment:
// - 'your-chrome': MoPilot's Your Chrome tools (the Playwright Extension): the chat's Chrome instance opens
//   the site in its tab group and the browser channel switches to Chrome (electron/capabilities/browser/handoff.cjs).
// - 'claude-in-chrome', 'codex-browser-plugin': the harness drives Chrome itself and never sees a tab MoPilot
//   opens, so the site opens in the user's Chrome (the browser and profile the vendor's extension is on) and the agent
//   is told to pick it up with its own tool: Claude in Chrome opens it in its tab group (same profile, same sign-in),
//   the Codex Browser plugin claims the user's tab (browser.user.openTabs / claimTab).
// - 'codex-extension': the Codex Browser plugin on MoPilot's Chrome backend (Codex segments' default): the site
//   opens in the user's Chrome and the plugin opens it in the chat's tab group through that backend.
// - 'extension', 'relay': MoPilot's chrome_* tools over its own extension or the relay: the site opens in the
//   profile those tools use, and the agent opens it in the chat's tab group.
// - 'setup': Your Chrome would continue, but the Playwright Extension it connects through isn't in Chrome yet; the
//   pane offers Browser settings to set it up, never an "Open in Chrome" that could only fail.
// - 'setup-extension': MoPilot's chrome_* tools (or the Codex plugin on its backend) would continue, but MoPilot's extension isn't in the user's Chrome (or is turned off there); the pane offers Add to Chrome, and goes on
//   by itself once the extension is there.
// - 'none': nothing in this chat can reach the user's Chrome; the pane offers Browser settings instead of a button
//   that could only fail.

/** @typedef {'your-chrome' | 'claude-in-chrome' | 'codex-browser-plugin' | 'codex-extension' | 'extension' | 'relay' | 'setup' | 'setup-extension' | 'none'} HandoffRoute */

/** How the pane names each route's controller. */
export const ROUTE_LABEL = {
  'your-chrome': 'Your Chrome',
  'claude-in-chrome': 'Claude in Chrome',
  'codex-browser-plugin': 'the Codex Browser plugin',
  'codex-extension': 'the Codex Browser plugin',
  extension: "MoPilot's Chrome tools",
  relay: "MoPilot's Chrome tools",
  setup: '',
  'setup-extension': '',
  none: '',
};

/**
 * What a Your Chrome hand-off does to the saved Preferred browser: the browser channel is one setting for every chat,
 * so the pane says so before the user goes ahead and once it changed (Claude Desktop keeps its Preferred browser
 * "by default unless you ask otherwise"; MoPilot can't switch one chat alone, so it says what changed).
 */
export const PREFERRED_WILL_CHANGE = 'Agents in every chat will use your Chrome.';
export const PREFERRED_CHANGED = 'Agents in every chat now use your Chrome.';

/** Why a chat with no Chrome controller can't hand a page over, and what works instead. */
export const NO_CHROME = "This chat can't use your Chrome. Turn it on, or sign in another way.";

/** Why Your Chrome can't take a page over yet, and what sets it up. */
export const CHROME_SETUP = 'Set up the Playwright Extension, or sign in another way.';

/** Why MoPilot's Chrome tools can't take a page over yet, and what sets them up. */
export const EXTENSION_SETUP = "Add MoPilot's extension to Chrome to continue there.";

/** Whether the route still needs something set up before anything can continue in Chrome. */
export const needsSetup = (/** @type {HandoffRoute} */ route) => route === 'none' || route === 'setup' || route === 'setup-extension';

/** Why a route that needs setup can't continue (the error main and the continuation give). */
export const setupReason = (/** @type {HandoffRoute} */ route) =>
  route === 'setup' ? CHROME_SETUP : route === 'setup-extension' ? EXTENSION_SETUP : NO_CHROME;

/**
 * The route a chat's hand-off takes.
 * @param {{ vendor: 'claude-in-chrome' | 'codex-browser-plugin' | null, relay: 'extension' | 'relay' | null,
 *           yourChrome: boolean, onChrome: boolean, codexExtension?: boolean }} o
 *   vendor: the harness's own Chrome controller on the chat's current segment; relay: MoPilot's chrome_* tools
 *   are on (their channel); yourChrome: Your Chrome's tools are on; onChrome: the browser channel is Chrome already;
 *   codexExtension: the chat's current segment is a native Codex thread MoPilot serves the user's Chrome to
 * @returns {HandoffRoute} never 'setup' or 'setup-extension': main narrows a route to them when its extension is
 *   missing (handoff.cjs chatHandoffRoute)
 */
export function handoffRoute({ vendor, relay, yourChrome, onChrome, codexExtension = false }) {
  // the thread is served the user's Chrome by MoPilot (its note sends the plugin there, not to the vendor's)
  if (codexExtension) return 'codex-extension';
  if (vendor) return vendor;
  // the agent already works in Your Chrome (the chrome_* tools are hidden then); else the tools it has now
  if (yourChrome && onChrome) return 'your-chrome';
  if (relay) return relay;
  return yourChrome ? 'your-chrome' : 'none';
}

/** Whether the route opens the site in the user's Chrome itself (the agent picks it up), rather than in the chat's Your Chrome instance. */
export const opensInUserChrome = (/** @type {HandoffRoute} */ route) =>
  route === 'claude-in-chrome' ||
  route === 'codex-browser-plugin' ||
  route === 'codex-extension' ||
  route === 'extension' ||
  route === 'relay';

/** How the agent continues at `url` with the route's tool. */
function continueWith(/** @type {HandoffRoute} */ route, /** @type {string} */ url, chromeToolName = 'chrome_tabs_context_mcp') {
  if (route === 'claude-in-chrome')
    return `with Claude in Chrome: call tabs_context_mcp, then navigate a tab of your tab group to ${url} (it shares the sign-in of the user's Chrome)`;
  if (route === 'codex-browser-plugin')
    return `with the Codex Browser plugin in the user's Chrome: list their open tabs (browser.user.openTabs()) and claim the one at ${url} (browser.user.claimTab), or open ${url} in a new tab of that Chrome`;
  if (route === 'codex-extension')
    return `with the Codex Browser plugin on MoPilot's Chrome: get the browser named "MoPilot Chrome" from agent.browsers.list() by its id (not agent.browsers.get("chrome")), then open ${url} in a tab of this chat's tab group (it shares the sign-in of the user's Chrome)`;
  if (route === 'extension' || route === 'relay')
    return `with your Chrome tools: call ${chromeToolName}, then navigate a tab of this chat's tab group to ${url} (it shares the sign-in of the user's Chrome)`;
  return `with your Chrome browser tools at ${url}: take a fresh snapshot in this chat's Chrome tab group`;
}

/**
 * What a browser_request_signin call still waiting on the in-app page returns once the user moved the sign-in to
 * Chrome: the call ends (the agent is never left waiting on a tab the user left), and the agent learns where to go.
 * The renderer's narration reads its first words (src/lib/agentNarration/handoffs.ts).
 */
export function movedNote(/** @type {HandoffRoute} */ route, /** @type {string} */ url) {
  return `The user moved this sign-in to their Chrome, where their passkeys and saved sign-ins work: ${url} is open there. Don't continue this site in the built-in browser (it has a separate session). End your turn and ask the user to tell you when they have signed in; then continue the task ${continueWith(route, url)}, and check the sign-in state first.`;
}

/** The first words of movedNote, for the readers of a finished call. */
export const MOVED_PREFIX = 'The user moved this sign-in to their Chrome';

/** The hidden block the routing note travels in: the user's bubble shows only the short line after it (shared/userText.mjs). */
export const HANDOFF_TAG = 'sage-browser-handoff';

/** Trusted browser routing context stays hidden while the user's own message remains visible.
 * @param {string} note @param {string} shown */
export function browserHandoffMessage(note, shown) {
  const safe = note.replace(new RegExp(`</(${HANDOFF_TAG})`, 'gi'), '<\\/$1');
  return `<${HANDOFF_TAG}>\n${safe}\n</${HANDOFF_TAG}>\n${shown}`;
}

/** The site's host for the user's short line, or the address itself when it has none. */
function hostOf(/** @type {string} */ url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * What "Continue in Chrome" sends: a hidden note telling the agent how to continue with the route's tool, then the
 * short line the user sees in their bubble. `signedIn`: the user went to Chrome to sign in and says they did.
 * @param {HandoffRoute} route @param {string} url @param {string} [chromeToolName] @param {{ signedIn?: boolean }} [o]
 */
export function continueMessage(route, url, chromeToolName = 'chrome_tabs_context_mcp', { signedIn = false } = {}) {
  if (needsSetup(route)) throw new Error(setupReason(route));
  const how = opensInUserChrome(route)
    ? `${signedIn ? 'The user signed in' : 'The user opened this site'} in their Chrome at ${url}. Continue the task ${continueWith(route, url, chromeToolName)}, and check the sign-in state first. The built-in browser has a separate session.`
    : `Continue the current browser task in Your Chrome at ${url}. Take a fresh snapshot in this chat's Chrome tab group, verify the current sign-in state, and continue the original task. The old built-in browser has a separate session.`;
  // the note is the app's own text: a closing tag in it never ends the block early
  const shown = `${signedIn ? 'Signed in. ' : ''}Continue in Chrome · ${hostOf(url)}`;
  return browserHandoffMessage(how, shown);
}
