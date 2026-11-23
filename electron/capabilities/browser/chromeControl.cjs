// Which channel serves the user's Chrome to MoPilot's native-shaped Chrome tools (design D5): MoPilot's own extension (B2 step 2) or the relay over the Playwright Extension (step 1).
//
// shared.browser.chromeExtension wins over shared.browser.chromeRelay: both are off by default. Either one turns on
// the same chrome_* tools, the same Codex extension backend and the same browser host for every harness; only the
// channel under them differs. No dependencies, so the visibility rule and the backends can read it.
// Wherever the build ships MoPilot's own extension, it serves the user's Chrome by default, with both switches off
// (design D5, the bu1 comparison; #1483): a native Codex thread through its Chrome backend while
// codex.browser.chromeExtension is on (off, Codex uses the vendor's own Chrome, the ChatGPT extension), and every other
// session through the chrome_* tools while shared.browser.chromeExtensionByDefault is on (chromeToolsOn). A session
// whose harness controls Chrome itself (Claude in Chrome, the Codex Browser plugin) still sees no chrome_* tools
// (visibility.cjs), so this reaches ACP sessions, managed Codex threads and Claude sessions without Claude in Chrome.

const RELAY_FLAG = 'shared.browser.chromeRelay';
const EXTENSION_FLAG = 'shared.browser.chromeExtension';
/** Codex segments get MoPilot's extension (on by default); off, their Browser plugin keeps the vendor's ChatGPT extension. */
const CODEX_EXTENSION_FLAG = 'codex.browser.chromeExtension';
/** Every other session gets the chrome_* tools over MoPilot's extension where the build ships it (on by default). */
const DEFAULT_EXTENSION_FLAG = 'shared.browser.chromeExtensionByDefault';

/**
 * The channel the switches choose now, or null when MoPilot doesn't serve the user's Chrome this way.
 * @param {(key: string) => boolean} isEnabled
 * @returns {'extension' | 'relay' | null}
 */
function chromeChannelKind(isEnabled) {
  if (isEnabled(EXTENSION_FLAG)) return 'extension';
  if (isEnabled(RELAY_FLAG)) return 'relay';
  return null;
}

/**
 * The names the Codex Browser plugin's env (BROWSER_USE_AVAILABLE_BACKENDS) gives its Chrome backends, whose
 * browsers report type "extension": "chrome" since the ChatGPT app's 26.1007 plugin, "extension" before it.
 */
const CHROME_BACKEND_KEYS = Object.freeze(['chrome', 'extension']);

/** Whether the plugin's env lists a Chrome backend, under either name. @param {readonly string[]} backends */
function pluginListsChrome(backends) {
  return backends.some((b) => CHROME_BACKEND_KEYS.includes(b));
}

/** Whether MoPilot serves the user's Chrome to its native-shaped tools (chrome_*) for every harness. */
function chromeControlOn(isEnabled) {
  return chromeChannelKind(isEnabled) !== null;
}

/**
 * Whether sessions are shown the chrome_* tools: with a switch for every harness on, or by default
 * (shared.browser.chromeExtensionByDefault) where the build ships the extension. A harness with its own Chrome
 * controller is left out by the visibility rule, not here.
 * @param {(key: string) => boolean} isEnabled @param {{ shipped?: boolean }} [o] shipped: this build ships the extension
 */
function chromeToolsOn(isEnabled, { shipped = false } = {}) {
  return chromeControlOn(isEnabled) || (shipped && isEnabled(DEFAULT_EXTENSION_FLAG));
}

/**
 * Whether native Codex threads get the user's Chrome through MoPilot's backend: with a switch for every harness
 * on, or by default (codex.browser.chromeExtension) where the build ships the extension; with that default off and
 * no switch for every harness, Codex keeps the vendor's own Chrome.
 * @param {(key: string) => boolean} isEnabled @param {{ shipped?: boolean }} [o] shipped: this build ships the extension
 */
function codexChromeOn(isEnabled, { shipped = false } = {}) {
  if (!isEnabled('native.codex.enabled')) return false;
  return chromeControlOn(isEnabled) || (shipped && isEnabled(CODEX_EXTENSION_FLAG));
}

/**
 * The channel main serves at startup: the one the switches choose for every harness, else MoPilot's extension
 * when it is served by default (codexChromeOn, chromeToolsOn), else none.
 * @param {(key: string) => boolean} isEnabled @param {{ shipped?: boolean }} [o]
 * @returns {'extension' | 'relay' | null}
 */
function servedChromeKind(isEnabled, o = {}) {
  return chromeChannelKind(isEnabled) ?? (codexChromeOn(isEnabled, o) || chromeToolsOn(isEnabled, o) ? 'extension' : null);
}

/**
 * Which sessions MoPilot's own channel serves the user's Chrome to, for the status rows and the Claude in Chrome
 * note: `tools`, the sessions shown the chrome_* tools (Claude without Claude in Chrome, ACP, managed Codex threads);
 * `codex`, native Codex threads (the chrome_* tools, or MoPilot's backend for the Browser plugin); `takeover`, the
 * chrome_* tools replace the Browser plugin's Chrome in native Codex threads (#1319 G28, codexPluginChrome.cjs
 * codexChromeOff); `kind`, the channel under them. Choosing Your Chrome as the browser channel hides the chrome_* tools (visibility.cjs) but changes
 * none of this: it says where they would come back.
 * @param {(key: string) => boolean} isEnabled @param {{ shipped?: boolean }} [o]
 * @returns {{ tools: boolean, codex: boolean, takeover: boolean, kind: 'extension' | 'relay' | null }}
 */
function servedChrome(isEnabled, o = {}) {
  const tools = chromeToolsOn(isEnabled, o);
  const codex = codexChromeOn(isEnabled, o);
  return { tools, codex: tools || codex, takeover: tools && codex, kind: servedChromeKind(isEnabled, o) };
}

/** The selected Chrome provider for native Codex; runtime readiness never selects a different provider.
 * @param {{ tools: boolean, codex: boolean, takeover?: boolean } | undefined} served
 * @returns {'vendor' | 'tools' | 'backend'}
 */
function codexChromeRoute(served) {
  if (served?.takeover) return 'tools';
  return served?.codex && !served.tools ? 'backend' : 'vendor';
}

module.exports = {
  chromeChannelKind,
  servedChrome,
  codexChromeRoute,
  chromeControlOn,
  chromeToolsOn,
  codexChromeOn,
  servedChromeKind,
  pluginListsChrome,
  CHROME_BACKEND_KEYS,
  RELAY_FLAG,
  EXTENSION_FLAG,
  CODEX_EXTENSION_FLAG,
  DEFAULT_EXTENSION_FLAG,
};
