// Main's channel to the user's Chrome for the native-shaped tools (design D5), set up when shared.browser.chromeExtension or shared.browser.chromeRelay is on at startup, or by default where the build ships the extension: the channel, the browser host over Chrome, Chrome's own site permissions and the chrome_* tools.
//
// - The channel is MoPilot's own extension (B2 step 2, browser/chromeExtension.cjs) when
//   shared.browser.chromeExtension is on, else the relay over the Playwright Extension (step 1). With both off, a
//   build that ships the extension still serves it: to Codex segments (unless codex.browser.chromeExtension is off: the
//   vendor's Chrome) and, through the chrome_* tools, to every session without a Chrome controller of its own (unless
//   shared.browser.chromeExtensionByDefault is off: the tools then refuse; #1483). Everything
//   above it is the same. The extension's channel starts serving at startup, so a paired extension connects
//   before the first call; its pairing page opens in the user's Chrome profile the same way the relay's
//   connect page does.
// - The relay opens the Playwright Extension's connect page by starting the user's Chrome with the URL
//   (a running Chrome takes it in its own window), in the profile Your Chrome uses, with that profile's
//   connection token (capabilities/browser/userChrome.cjs openInChrome). MOPILOT_CHROME_RELAY_USER_DATA_DIR and
//   MOPILOT_CHROME_RELAY_EXECUTABLE point it at another Chrome profile or build (the comparison runs use a scratch
//   profile, never the user's).
// - Site permissions are the user's Chrome's own table (design D4, shared with Your Chrome: one table per
//   browser), asked with cards that name Chrome.
// - The Chrome host's turn end is a step of main's turn ledger (app/sessions.cjs), beside the in-app browser's,
//   and the chrome_* tools refuse once the switch goes off.
const path = require('node:path');
const { ChromeRelay } = require('../capabilities/browser/chromeRelay.cjs');
const { ChromeExtensionChannel } = require('../capabilities/browser/chromeExtension.cjs');
const { ChromePairing } = require('../capabilities/browser/chromePairing.cjs');
// main's wiring takes the channel's signals from here, with the channel (browserTools.cjs)
const { chromeRelayNotices } = require('./chromeAskNotice.cjs');
const { sageMcpPath } = require('../capabilities/mcp/socket.cjs');
const { STORE_EXTENSION_ID, storeUrl, extensionIds, extensionInProfileOf } = require('../capabilities/browser/chromeExtensionIds.cjs');
const {
  ChromeNativeHostServer,
  hostFolders,
  hostManifest,
  installHost,
  launcherScript,
} = require('../capabilities/browser/chromeNativeHost.cjs');
const { linuxHostEnabled } = require('../capabilities/browser/chromeHostLinux.cjs');
const { extensionInProfile } = require('../capabilities/browser/chromeProfileExtension.cjs');
const { syncExternalInstall, externalFile, profileFolders } = require('../capabilities/browser/chromeExternalInstall.cjs');
const { servedChromeKind, chromeToolsOn, codexChromeOn } = require('../capabilities/browser/chromeControl.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { chromeBrowserTabs } = require('../capabilities/browser/chromeHost.cjs');
const { registerChromeTools } = require('../capabilities/browser/chromeTools.cjs');
const { chromeScreenshots } = require('../capabilities/browser/chromeScreenshots.cjs');
const { ScreenshotShelf } = require('../capabilities/browser/hostScreenshots.cjs');
const { openInChrome } = require('../capabilities/browser/userChrome.cjs');
const { AgentCursor } = require('../capabilities/browser/agentCursor.cjs');
const { addHook } = require('../session/hookChain.cjs');

/** Where the extension's files are, for loading it unpacked (the repository's copy; inside a packaged app's asar it can't be). */
const EXTENSION_DIR = path.join(__dirname, '..', 'chrome-extension');

/** How a chat's turn shows on its tab group, by the session store's turn state. */
const { stateOf } = require('../capabilities/browser/chromePanel.cjs');
const TURN_STATUS = Object.freeze(Object.assign(Object.create(null), { running: 'running', awaitingUser: 'waiting', idle: 'done' }));

/** Whether the extension can be loaded unpacked from `dir`: not from inside a packaged app's asar. */
const loadsUnpacked = (dir) => !/\.asar([\\/]|$)/.test(dir);

/**
 * Whether this build ships the extension, so sessions use it by default (chromeControl.cjs): a build it loads unpacked
 * from, or any build once the Web Store's id is configured (chromeExtensionIds.cjs, #1632).
 * @param {string} [dir] @param {string | null} [storeId]
 */
function extensionShipped(dir = EXTENSION_DIR, storeId = STORE_EXTENSION_ID) {
  return loadsUnpacked(dir) || storeUrl({ storeId }) !== null;
}

/**
 * How the user installs MoPilot's extension, for the error a call gets when it isn't connected: load it unpacked
 * where the build can, else from the Web Store.
 * @param {string} [dir] @param {string | null} [storeId]
 */
function installHint(dir = EXTENSION_DIR, storeId = STORE_EXTENSION_ID) {
  if (loadsUnpacked(dir)) return `To install it, open chrome://extensions, turn on Developer mode, choose Load unpacked and pick ${dir}.`;
  const url = storeUrl({ storeId });
  if (url) return `To install it, open ${url} in Chrome and choose Add to Chrome.`;
  return "This build of MoPilot doesn't ship its Chrome extension yet.";
}

/**
 * What the capability-health record reads about this surface (capabilityHealth.cjs chromeRelayHealth).
 * @param {{ isFlagEnabled: (key: string) => boolean, setup: ReturnType<typeof setupChromeRelay> | null | undefined,
 *           installedVersion: () => string | null, extensionUrl: string, storeId?: string | null }} o
 *   installedVersion: the Playwright Extension's version in the user's Chrome profile (the relay's need); storeId: the
 *   Web Store's id for MoPilot's own extension (chromeExtensionIds.cjs), whose page is the install link
 */
function chromeRelayFacts({ isFlagEnabled, setup, installedVersion, extensionUrl, storeId = STORE_EXTENSION_ID }) {
  // on for every harness by a switch, or by default where the build ships the extension (chromeControl.cjs)
  const served = servedChromeKind(isFlagEnabled, { shipped: extensionShipped() });
  const enabled = served !== null;
  const running = !!setup;
  const kind = setup?.kind ?? served ?? 'relay';
  if (kind === 'extension') {
    const status = running ? /** @type {any} */ (setup).relay.status() : { paired: false, connected: false, asking: false };
    // the profile is read only while it matters: a connected extension is on wherever it runs
    const installed = running && !status.connected ? /** @type {any} */ (setup.inProfile?.().state ?? null) : null;
    const installUrl = storeUrl({ storeId });
    // the name the user gave this Chrome (Name this Chrome), which Settings shows
    const name = running ? chromeName(setup.pairing) : null;
    return {
      enabled,
      running,
      kind,
      extension: null,
      paired: status.paired,
      connected: status.connected,
      asking: !!status.asking,
      ...(name ? { name } : {}),
      installed,
      installUrl,
    };
  }
  return { enabled, running, kind, extension: enabled && running ? installedVersion() : null, extensionUrl };
}

/**
 * Which extension ids the native host is installed for (#1632), or null where it isn't: a packaged build once the Web
 * Store's id is configured (that id only), or a run pointed at a scratch Chrome folder that asks for it
 * (MOPILOT_CHROME_NATIVE_HOST=1 with MOPILOT_CHROME_RELAY_USER_DATA_DIR: both ids, written into that folder only).
 * A developer build never writes into the user's own browsers.
 * @param {{ dir?: string, storeId?: string | null, env?: Record<string, string | undefined>, platform?: string, packaged?: boolean }} [o]
 * @returns {string[] | null}
 */
function nativeHostIds({
  dir = EXTENSION_DIR,
  storeId = STORE_EXTENSION_ID,
  env = process.env,
  platform = process.platform,
  packaged = true,
} = {}) {
  // Linux has no host outside an unpackaged E2E run (chromeHostLinux.cjs): no socket and no launcher either
  if (platform === 'linux' && !linuxHostEnabled({ env, packaged, platform })) return null;
  if (env.MOPILOT_CHROME_NATIVE_HOST === '1' && env.MOPILOT_CHROME_RELAY_USER_DATA_DIR) return extensionIds({ storeId });
  if (loadsUnpacked(dir)) return null;
  const ids = extensionIds({ storeId });
  return ids.length > 1 ? [ids[0]] : null;
}

/**
 * Offers the store's extension to Google Chrome at startup (chromeExternalInstall.cjs, #1632), where this build installs
 * the native host (nativeHostIds); with the switch or the extension channel off, takes a standing offer back. The
 * native host written beside it (setupChromeRelay) makes pairing need no page once the user enables the extension.
 * @param {{ dir: string, enabled: boolean, profileDir?: string | null, ids?: string[] | null, sync?: typeof syncExternalInstall,
 *           inProfile?: typeof extensionInProfile, env?: Record<string, string | undefined>, platform?: string }} o
 *   dir: main's capabilities folder (the record of the offer); enabled: the switch is on and the channel is the extension
 */
function offerChromeExtension({
  dir,
  enabled,
  profileDir = null,
  ids = nativeHostIds(),
  sync = syncExternalInstall,
  inProfile = extensionInProfile,
  env = process.env,
  platform = process.platform,
}) {
  if (!ids) return 'not-shipped';
  // the preference covers every profile of the folder: the one pairing uses, the last used, and each one on disk
  const where = externalFile({ id: ids[0], env, platform });
  const profiles = [profileDir, null, ...(where ? profileFolders(where.root) : [])];
  const states = profiles.map((p) => extensionInProfileOf((id) => inProfile(id, { profileDir: p }), { storeId: ids[0] }).state);
  const state = states.find((s) => s === 'on') ?? states.find((s) => s === 'off') ?? (states.includes(null) ? null : 'missing');
  return sync({ id: ids[0], enabled, state, stateFile: path.join(dir, 'chrome-extension-offer.json'), env, platform });
}

/**
 * Serves the native host and installs it for `ids`: the launcher on the socket's path, the manifest in each browser.
 * Resolves with whether a manifest was written (the pairing page then opens without the claim code).
 * @param {{ server: InstanceType<typeof ChromeNativeHostServer>, ids: string[], launcher: string, binary: string,
 *           folders?: string[], install?: typeof installHost }} o
 */
async function serveNativeHost({ server, ids, launcher, binary, folders = hostFolders(), install = installHost }) {
  const socket = await server.start();
  const written = install({ launcher, script: launcherScript({ binary, socket }), manifest: hostManifest({ launcher, ids }), folders });
  return written.length > 0;
}

/**
 * The extension's files in main's capabilities folder: its saved pairing (encrypted), and its native host's launcher
 * with sage-mcp's path (#1632).
 * @param {{ dir: string, safeStorage: ConstructorParameters<typeof ChromePairing>[0]['safeStorage'], packaged: boolean,
 *           platform?: string, env?: Record<string, string | undefined> }} o
 *   packaged: app.isPackaged (browserTools.cjs); platform and env: the process's, given by a test
 */
function extensionFiles({ dir, safeStorage, packaged, platform = process.platform, env = process.env }) {
  return {
    pairing: new ChromePairing({ file: path.join(dir, 'chrome-extension-pairing.json'), safeStorage }),
    nativeHost: {
      launcher: path.join(dir, 'chrome-native-host', 'mopilot-chrome-host'),
      binary: sageMcpPath({ packaged }),
      // Linux hosts only in an unpackaged E2E run (chromeHostLinux.cjs); a packaged build never
      linuxE2E: linuxHostEnabled({ packaged, platform, env }),
    },
  };
}

/**
 * Settings → Browser's Pair (#1632): opens MoPilot's own extension's pairing page now, where main serves it.
 * @param {ReturnType<typeof setupChromeRelay> | null | undefined} setup
 * @returns {Promise<'opened' | 'connected' | 'missing' | 'off' | 'unreadable' | 'unavailable'>}
 */
async function pairChromeExtension(setup) {
  if (setup?.kind !== 'extension') return 'unavailable';
  return /** @type {InstanceType<typeof ChromeExtensionChannel>} */ (setup.relay).pair();
}

/**
 * "Add to Chrome" (Settings → Browser, the welcome page, #1986): the extension's Web Store page, in Google Chrome itself
 * (the profile MoPilot uses), where one click adds it turned on, unlike an External Extensions offer. Another browser
 * gets it only when Chrome can't open. The page is main's: the renderer names no URL.
 * @param {{ storeId?: string | null, profileDir?: string, open?: typeof openInChrome, external: (url: string) => Promise<unknown> }} o
 * @returns {Promise<'chrome' | 'browser' | 'unavailable'>}
 */
async function openChromeStore({ storeId = STORE_EXTENSION_ID, profileDir = '', open = openInChrome, external }) {
  const url = storeUrl({ storeId });
  if (!url) return 'unavailable';
  try {
    await open(url, { profileDir });
    return 'chrome';
  } catch (error) {
    noteIgnored('open the Chrome Web Store page in Chrome', error);
    await external(url);
    return 'browser';
  }
}

/**
 * The user's answer to "Allow Chrome to connect?" (its dialog, Settings → Browser): true when a
 * question was up and Allow offered the pairing the extension's next ask takes. The card's "Name this Chrome", as
 * Claude's pairing prompt asks for it, is kept only with an Allow to a question that is up.
 * @param {ReturnType<typeof setupChromeRelay> | null | undefined} setup @param {unknown} allow @param {unknown} [name]
 */
function answerChromeAsk(setup, allow, name) {
  if (setup?.kind !== 'extension') return false;
  const relay = /** @type {InstanceType<typeof ChromeExtensionChannel>} */ (setup.relay);
  if (allow === true && name !== undefined && relay.status().asking) {
    // the name is cosmetic: one that can't be saved never costs the user the pairing
    try {
      setup.pairing?.rename?.(name);
    } catch (error) {
      noteIgnored('name this Chrome', error);
    }
  }
  return relay.answerAsk(allow === true);
}

/**
 * The name the user gave this Chrome (Name this Chrome), or null: none, or a pairing that can't be read.
 * @param {{ get: () => { name?: string } | null } | null | undefined} pairing
 */
function chromeName(pairing) {
  try {
    return pairing?.get()?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * The chat's folders as the chrome_* tools name them: its upload folder, and no downloads folder, since the user's
 * Chrome saves downloads where it always does, never in the chat's folder (#1570).
 * @param {((chatId: string) => { uploads: string, downloads: string | null } | null) | null | undefined} folders
 */
const chromeFolders = (folders) =>
  folders
    ? (chatId) => {
        const f = folders(chatId);
        return f && { uploads: f.uploads, downloads: null };
      }
    : null;

/**
 * The channel, its browser host and the chrome_* tools, on the user's Chrome's site table.
 * @param {{ registry: { register: (t: any) => () => void },
 *           grants: InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants>,
 *           token: () => string | null, profileDir: () => string,
 *           images: { fromBuffer: (buf: Buffer) => any }, modelOf?: (chatId: string) => any,
 *           confirm?: any, folders?: any, isFlagEnabled: (key: string) => boolean,
 *           kind?: 'relay' | 'extension', pairing?: ConstructorParameters<typeof ChromeExtensionChannel>[0]['pairing'],
 *           onStatus?: () => void, onAsk?: (asking: boolean) => void,
 *           onOpen?: (what: unknown) => boolean | Promise<boolean>, openChat?: (chatId: string) => unknown, open?: typeof openInChrome, busy?: (chatId: string) => boolean,
 *           panel?: (m: any, reply: (message: object) => void) => unknown,
 *           controller?: { stopChat: (chatId: string) => unknown, onFinished?: (e: { chatId: string, text?: unknown }) => unknown } | null,
 *           chatTitle?: (chatId: string) => string | null,
 *           nativeHost?: { launcher: string, binary: string, ids?: string[] | null, folders?: string[], linuxE2E?: boolean,
 *                          verify?: typeof import('../capabilities/browser/chromeNativeHost.cjs').verifyHostPeer } | null,
 *           files?: Parameters<typeof extensionFiles>[0],
 *           traces?: InstanceType<typeof import('../capabilities/browser/devtools/turnTrace.cjs').TurnTraces> | null }} o
 *   kind: the channel (chromeControl.cjs); pairing: the extension's saved pairing (browser/chromePairing.cjs), for 'extension';
 *   onStatus: the extension connected or went away (the capability-health record changed); busy: whether the chat's
 *   turn runs now (an idle chat lets go of its Chrome tabs, never one whose turn runs); controller: the chat controller (the
 *   control frame's Stop on a Chrome tab, agentControlFrame.cjs, stops the chat's turn there, and its turn ends tell the
 *   Chrome host the agent's reply, whose named tabs stay when the chat lets go); chatTitle: the chat's title, for its tab group; nativeHost: where the launcher
 *   goes and sage-mcp's path, for the extension's native host where this build installs one (nativeHostIds); files:
 *   main's capabilities folder, where both of those are when they aren't given (extensionFiles); traces: the app's one turn trace
 *   (devtools/turnTrace.cjs, G5), which records the chat's Chrome tabs and chrome_* steps as the built-in browser's
 */
function setupChromeRelay({
  registry,
  grants,
  token,
  profileDir,
  images,
  modelOf,
  confirm,
  folders,
  isFlagEnabled,
  kind = 'relay',
  onStatus = () => undefined,
  onAsk = () => undefined,
  onOpen,
  openChat = () => undefined,
  panel,
  open = openInChrome,
  busy,
  controller = null,
  chatTitle = () => null,
  nativeHost: givenHost,
  pairing: givenPairing,
  files,
  traces = null,
}) {
  const own = files ? extensionFiles(files) : null;
  // a build that installs the native host also offers the extension to Google Chrome, or takes the offer back (#1632)
  if (kind === 'extension' && files)
    offerChromeExtension({
      dir: files.dir,
      enabled: isFlagEnabled('shared.browser.chromeExtensionAutoAdd'),
      profileDir: profileDir() || null,
    });
  const pairing = givenPairing ?? own?.pairing;
  /** @type {NonNullable<Parameters<typeof setupChromeRelay>[0]['nativeHost']> | null} */
  const nativeHost = givenHost ?? own?.nativeHost ?? null;
  const openPage = (url) => open(url, { profileDir: profileDir() });
  // what a chat's Chrome tab group is called while the chat has no title yet: the app's name, as Claude in Chrome's is "Claude (MCP)"; never an id
  const clientName = () => 'MoPilot';
  /** @type {InstanceType<typeof ChromeRelay>} */
  let relay;
  /** @type {InstanceType<typeof ChromeNativeHostServer> | null} */
  let host = null;
  let hostInstalled = false;
  /** @type {(() => { send: (m: object) => void } | null)} the extension's connection, for the side panel's updates */
  let panelPeer = () => null;
  // the extension's ids in the profile it pairs in, the store's or the dev key's (#1632)
  const inProfile = () => extensionInProfileOf((id) => extensionInProfile(id, { profileDir: profileDir() }));
  if (kind === 'extension') {
    // the pairing page opens only in a profile that has the extension on (#1319 G29), and it is the page of the id
    // installed there: the Web Store's or the dev key's (#1632)
    const channel = new ChromeExtensionChannel({
      pairing: /** @type {any} */ (pairing),
      openPage,
      // the chat's group is titled for the chat, as ChatGPT's is for its session
      clientName: (chatId) => chatTitle(chatId) || clientName(),
      installHint: installHint(),
      installed: () => inProfile().state,
      pageId: () => inProfile().id,
      hostRoute: () => hostInstalled,
      // Chrome's side panel (app/chromePanel.cjs)
      panel,
    });
    panelPeer = () => channel.peer;
    const ids = nativeHost
      ? nativeHost.ids === undefined
        ? nativeHostIds({ packaged: files?.packaged ?? true, platform: files?.platform, env: files?.env })
        : nativeHost.ids
      : null;
    if (nativeHost && ids) {
      host = new ChromeNativeHostServer({
        claim: (o) => channel.hostClaim(o),
        // the extension's page asks MoPilot to open what it names (Try it: a chat with a sample task)
        open: onOpen,
        ids: () => ids,
        binary: nativeHost.binary,
        verify: nativeHost.verify,
        linuxE2E: nativeHost.linuxE2E === true,
        // a host that fails the checks (Chrome updated on disk, a manifest pointed elsewhere): pages carry the code again
        onRefused: () => {
          hostInstalled = false;
        },
      });
      serveNativeHost({
        server: host,
        ids,
        launcher: nativeHost.launcher,
        binary: nativeHost.binary,
        folders: nativeHost.folders ?? hostFolders({ linuxE2E: nativeHost.linuxE2E === true }),
      }).then(
        (written) => {
          hostInstalled = written;
        },
        (error) => noteIgnored("serve MoPilot's Chrome native messaging host", error),
      );
    }
    // serving from startup: a paired extension connects before the first call needs it
    channel.start().catch((error) => noteIgnored("serve MoPilot's Chrome extension", error));
    channel.on('peer', onStatus);
    channel.on('peerGone', onStatus);
    // "Allow Chrome to connect?" raised or answered (chromePairOffers.cjs)
    channel.on('ask', (asking) => {
      onStatus();
      onAsk(asking);
    });
    relay = channel;
  } else relay = new ChromeRelay({ openPage, token, clientName });
  // the agent's pointer and the control frame on the chat's Chrome tabs; the frame's Stop is the chat's Esc
  const cursor = new AgentCursor({
    enabled: () => isFlagEnabled('shared.browser.agentCursor'),
    frame: true,
    onStop: (tab) => controller?.stopChat(tab.chatId),
    // "Waiting for your OK" on the page: Review opens the chat, where its card is answered
    onReview: (tab) => openChat(tab.chatId),
  });
  const tabs = chromeBrowserTabs({ relay, images, modelOf, busy, cursor });
  if (traces) {
    // the turn trace takes this host's page gates and ends with a chat's turn here too (an ended trace is not ended twice)
    tabs.traces = traces;
    tabs.onTurnEnd((chatId) => void traces.endTurn(chatId));
  }
  if (controller) addHook(controller, 'onFinished', (e) => tabs.noteReply(e.chatId, e.text));
  // a switch for every harness, or the default where the build ships the extension (#1483); off, the channel serves
  // Codex alone. The tools refuse and "Continue in Chrome" (browser/handoff.cjs) leaves them by this one rule
  const toolsOn = () => chromeToolsOn(isFlagEnabled, { shipped: extensionShipped() });
  const OFF = 'Chrome control through MoPilot is turned off.';
  // one shelf for the chrome_* tools and the Codex plugin's Chrome tabs: a Screenshot ID outlives a harness switch
  const shelf = new ScreenshotShelf();
  const offTools = registerChromeTools(traces ? traces.recording(registry) : registry, {
    tabs,
    grants,
    confirm,
    folders: chromeFolders(folders),
    shelf,
    enabled: () => (toolsOn() ? true : OFF),
    pageTree: isFlagEnabled.bind(null, 'shared.browser.chromePageTree'),
    pageText: isFlagEnabled.bind(null, 'shared.browser.chromePageText'),
  });
  // browser_save_screenshot on a Chrome tab of a native Codex thread's plugin, served while either path is on (#1539)
  const screenshots = chromeScreenshots({
    tabs,
    grants,
    folders: chromeFolders(folders),
    shelf,
    enabled: () => (toolsOn() || codexChromeOn(isFlagEnabled, { shipped: extensionShipped() }) ? true : OFF),
    toolsOn,
  });
  return {
    kind,
    relay,
    /** the extension in the Chrome profile it pairs in; null for the relay */
    inProfile: kind === 'extension' ? inProfile : null,
    /** the extension's saved pairing, which carries this Chrome's name; null for the relay */
    pairing: kind === 'extension' ? pairing : null,
    tabs,
    grants,
    toolsOn,
    screenshots,
    /**
     * A chat's session changed (app/sessions.cjs): its turn running, waiting for the user or ended shows on its tab
     * group in Chrome, with the chat's title (Claude in Chrome's ⌛ 🔔 ✅). Chats with no Chrome session send nothing.
     * @param {{ chatId: string, patch?: { turn?: string } }} p
     */
    /** Why the Chrome administrator's policy blocks `url` for every chat (Chrome's site table, app/browserSiteTables.cjs). */
    policyBlock: (/** @type {string} */ url) => relay.policyBlock(url),
    onSessionPatch(p) {
      const status = TURN_STATUS[p?.patch?.turn ?? ''];
      if (!status) return;
      relay.turnStatus(p.chatId, { title: chatTitle(p.chatId), status });
      // the pill and favicon on the chat's tabs in Chrome follow it too
      void cursor.status(p.chatId, status);
      // the side panel's chat list and its open chat follow the turn
      panelPeer()?.send({ type: 'panel', event: { kind: 'turn', chatId: p.chatId, state: stateOf(p.patch?.turn) } });
    },
    /** Everything goes (the app quits). */
    stop() {
      offTools();
      tabs.dispose();
      relay.stop();
      host?.stop();
    },
  };
}

module.exports = {
  extensionFiles,
  setupChromeRelay,
  chromeFolders,
  chromeRelayFacts,
  pairChromeExtension,
  answerChromeAsk,
  chromeName,
  openChromeStore,
  chromeRelayNotices,
  nativeHostIds,
  offerChromeExtension,
  serveNativeHost,
  installHint,
  extensionShipped,
  EXTENSION_DIR,
};
