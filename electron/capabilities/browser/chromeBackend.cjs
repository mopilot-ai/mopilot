// Codex's Browser plugin drives the user's Chrome through MoPilot's relay (B2, design D5): an "extension" backend per native Codex thread, beside its "iab" one.
//
// It is the in-app browser backend (iabBackend.cjs) over the browser host for Chrome (chromeHost.cjs)
// instead of the pane's: the same socket per thread in /tmp/codex-browser-use, the same peer check, the
// same CDP classification (every method read, write or blocked) with the current page checked per command,
// the same action queue and site rules, with the user's Chrome's site table, and refusals that name Chrome. getInfo reports
// { type: 'extension', family: 'chrome', discoveryScope: 'session', metadata.codexSessionId } with
// Browser.user off (the user's own tabs are never claimed: only the chat's tab group is served). The
// plugin keeps it only when its env lists its Chrome backends (BROWSER_USE_AVAILABLE_BACKENDS): as "chrome" since the
// ChatGPT app's 26.1007 plugin, as "extension" before (chromeControl.cjs pluginListsChrome).
//
// The B2 spike's step 0 found that agent.browsers.get('chrome') resolves to the vendor's global extension
// backend (the ChatGPT extension) while that is connected: the browser service sorts global backends
// before session ones and returns the first of the family. Browser ids are the service's own counters, so
// no fixed id can be named. What MoPilot can do from here is chromeBackendNote: the thread is told
// which browser in agent.browsers.list() is MoPilot's (its metadata.codexSessionId is the thread id)
// and to get it by that entry's id, not by 'chrome'. What remains (design.md): a model that still asks for
// 'chrome' gets the vendor's backend when the ChatGPT extension is connected.
const os = require('node:os');
const { noteIgnored } = require('../../ignored.cjs');
const path = require('node:path');
const { IabBackend, IabBackends, pluginBrowserEnv } = require('./iabBackend.cjs');
const { servedChrome, codexChromeRoute, pluginListsChrome } = require('./chromeControl.cjs');
const { UPLOAD_HINT } = require('./iabBackend/protocol.cjs');

const NAME = 'MoPilot Chrome';

/** One native thread's backend for the user's Chrome. */
class ChromeBackend extends IabBackend {
  /** @param {ConstructorParameters<typeof IabBackend>[0]} o */
  constructor(o) {
    super(o);
    // its refusals name the user's Chrome (refusals.cjs), so the chat's strip and cards say which browser
    this.browser = /** @type {'chrome'} */ ('chrome');
  }

  info() {
    return {
      apiSupportOverrides: { 'Browser.user': false, 'Tab.markDeliverable': true, 'Tab.markHandoff': true },
      name: NAME,
      version: this.version,
      type: 'extension',
      family: 'chrome',
      discoveryScope: 'session',
      blobDownloadsSupported: false,
      capabilities: { browser: [], tab: [] },
      metadata: { ...(this.flavor ? { codexAppBuildFlavor: this.flavor } : {}), codexSessionId: this.threadId },
    };
  }
}

/**
 * What a native thread with a MoPilot Chrome backend is told: which browser that is and how to get it, that it
 * works before Chrome is connected (the first call opens MoPilot's pairing page: #1319 G23, where a thread said
 * it had no Chrome tool instead of trying it), that it opens its own tabs, and how to tell an upload worked (UPLOAD_HINT).
 * @param {string} threadId the thread's own id (its backend's codexSessionId)
 */
function chromeBackendNote(threadId) {
  return `MoPilot serves the user's own Chrome for this thread as the "extension" browser named "${NAME}" in agent.browsers.list(): the one whose metadata.codexSessionId is "${threadId}". When the user means their Chrome, get that entry with agent.browsers.get(entry.id) and use it, even when Chrome doesn't look connected yet: the first call opens MoPilot's pairing page in the user's Chrome and waits while they press Pair, and its error says what to do if they don't. Never answer that no Chrome tool is available without trying it. Its tabs.list contains this chat's admitted tabs in the user's signed-in Chrome profile. A page shared from the Chrome side panel is already admitted: use that existing entry and preserve its state. It does not enumerate unrelated user tabs. Don't call agent.browsers.get("chrome"): it can pick another Chrome backend that MoPilot does not control. ${UPLOAD_HINT}`;
}

/**
 * The thread backends codexConfig.cjs starts and stops (its `browserBackends`), several kinds as one: the
 * first answers available() and has() (the in-app browser note follows it), all of them are loaded and unloaded.
 * @param {...{ available: () => boolean, has: (threadId: string) => boolean, loaded: (threadId: string, o?: { parent?: string | null, surfaces?: { chrome: boolean, chromeRoute?: string } }) => unknown,
 *              unloaded: (threadId: string) => void, exited: () => void }} list
 */
function combineBackends(...list) {
  return {
    available: () => list[0].available(),
    has: (threadId) => list[0].has(threadId),
    loaded: (threadId, o) =>
      Promise.all(
        list.map(async (b) => {
          try {
            return await b.loaded(threadId, o);
          } catch (error) {
            noteIgnored('start a Codex browser backend', error);
            return null;
          }
        }),
      ),
    unloaded: (threadId) => {
      for (const b of list) b.unloaded(threadId);
    },
    exited: () => {
      for (const b of list) b.exited();
    },
  };
}

/**
 * The Chrome backends main runs, on its late-bound services: the browser host for Chrome and Chrome's site
 * permissions (live.chromeRelay), the chat a thread belongs to, the Codex app-server's pid, and the plugin env.
 * @param {{ live: any, server: { proc?: { pid?: number } | null }, isFlagEnabled: (key: string) => boolean,
 *           shellEnv: { childEnv: () => Record<string, string | undefined> }, home?: string, shipped?: boolean }} o
 *   shipped: this build ships MoPilot's extension, so Codex threads use it by default (chromeControl.cjs codexChromeOn)
 */
function mainChromeBackends({ live, server, isFlagEnabled, shellEnv, home = os.homedir(), shipped = false }) {
  return new IabBackends({
    Backend: ChromeBackend,
    kind: 'extension',
    listed: pluginListsChrome,
    accepts: ({ surfaces }) => !surfaces?.chromeRoute || (surfaces.chromeRoute === 'backend' && surfaces.chrome),
    tabs: () => live.chromeRelay?.tabs ?? null,
    grants: () => live.chromeRelay?.grants,
    chatOf: (id) => live.controller?.chatOf(id) ?? id,
    harnessPid: () => server.proc?.pid,
    // only while the chrome_* tools are off: with them on, a Codex thread gets them instead of the plugin's Chrome (#1319 G28)
    enabled: () => codexChromeRoute(servedChrome(isFlagEnabled, { shipped })) === 'backend',
    pluginEnv: () => pluginBrowserEnv({ codexHome: shellEnv.childEnv().CODEX_HOME || path.join(home, '.codex') }),
  });
}

module.exports = { ChromeBackend, chromeBackendNote, combineBackends, mainChromeBackends, NAME };
