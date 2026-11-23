// The built-in browser in main: its storage, downloads and pane tabs (main-owned views, or guests with views off), and the browser tools agents get behind their switches.
const path = require('node:path');
const { chatFolder: chatFolderOf, retainChatFolders } = require('../capabilities/browser/chatFolders.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const crypto = require('node:crypto');
const { browserDownloads } = require('./browserDownloads.cjs');
const { siteTables, confirmCall } = require('./browserSiteTables.cjs');
const { PanelBrowser, PARTITION: BROWSER_PARTITION } = require('../capabilities/browser/cdp.cjs');
const { ChromeChannel, spawnSpec: chromeSpawnSpec, EXTENSION_URL } = require('../capabilities/browser/extension.cjs');
const { installedExtensionVersion } = require('../capabilities/browser/chromeMigration.cjs');
const { BrowserControl, schemaCache } = require('../capabilities/browser/control.cjs');
const { ChromeTokens } = require('../capabilities/browser/chromeToken.cjs');
const { BrowserWindows } = require('../capabilities/browser/windows.cjs');
const { BrowserTabs } = require('../capabilities/browser/host.cjs');
const { createHostTabs } = require('./hostTabsWiring.cjs');
const { remoteBrowserFactory } = require('./remoteBrowserWiring.cjs');
const { registerAgentTabs } = require('../capabilities/browser/agentTabs.cjs');
const { CredentialHandoff, registerCredentialIpc } = require('../capabilities/browser/credentials.cjs');
const { CredentialStore } = require('../capabilities/browser/credentialStore.cjs');
const { createLoginAssist } = require('../capabilities/browser/loginAssist.cjs');
const { touchIdConfirm } = require('../capabilities/browser/userFill.cjs');
const { registerBrowserTools: registerBrowserHostTools, inAppBrowserEnabled } = require('../capabilities/browser/hostTools.cjs');
const { createTurnTraces } = require('./turnTraces.cjs');
const { createDevPreviewWiring } = require('./devPreviewWiring.cjs');
const { AgentCursor } = require('../capabilities/browser/agentCursor.cjs');
const { seenByUser } = require('../capabilities/browser/hostUtil.cjs');
const { configureBrowserAuth } = require('../capabilities/browser/auth.cjs');
const { BrowserStorage } = require('../capabilities/browser/storage.cjs');
const { registerClaudeSignIn } = require('../capabilities/browser/claudeSite.cjs');
const { createBrowserData } = require('../capabilities/browser/data.cjs');
const { createImporter } = require('../capabilities/browser/import/service.cjs');
const { WebPermissions, dialogAsk } = require('../capabilities/browser/webPermissions.cjs');
const { PaneViews } = require('../capabilities/browser/views.cjs');
const { startMemoryGuard } = require('./memoryGuardWiring.cjs');
const { PageDialogs, installPageDialogs, leaveAsk, PAGE_DIALOG_CHANNEL } = require('../capabilities/browser/pageDialogs.cjs');
const { installFormPosts } = require('../capabilities/browser/formPosts.cjs');
const { PageHang } = require('../capabilities/browser/pageHang.cjs');
const { browserPartition } = require('../../shared/browserStorage.mjs');
const { chatModel } = require('../capabilities/computerUse.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { chromeLinkApplies } = require('../session/segmentScope.cjs');
const { vendorChromeOf } = require('../../shared/controllerPlan.mjs');
const { chatHandoffRoute } = require('../capabilities/browser/handoff.cjs');
const { setupChromeRelay, extensionShipped, chromeRelayNotices } = require('./chromeRelay.cjs');
const { servedChromeKind, chromeToolsOn } = require('../capabilities/browser/chromeControl.cjs');
const { webMcpPrefs } = require('../capabilities/browser/webmcp.cjs');

/**
 * @param {import('../main.cjs').BrowserToolsDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createBrowserTools({
  app,
  ipcMain,
  BrowserWindow,
  WebContentsView,
  webContents,
  session,
  dialog,
  shell,
  utilityProcess,
  safeStorage,
  systemPreferences,
  nativeImage,
  shellEnv,
  readState,
  uiPrefs,
  isFlagEnabled,
  chatProject,
  appWindows,
  live,
}) {
  const { windows, mainWindow, broadcastAll } = appWindows;
  /** The chat's Claude in Chrome link: only from its current Claude segment's CLI (segmentScope.cjs), else null. */
  const claudeLinkOf = (/** @type {string} */ chatId) =>
    chromeLinkApplies(() => live.controller.ref(chatId)) ? (live.sessions.get(chatId)?.chromeLink ?? null) : null;
  /** The controller plan of a chat's current segment, or null before main has the plans. */
  const planOf = (/** @type {string} */ chatId) => live.controllerPlans?.current(chatId) ?? null;
  /** Who drives a chat's agent's Chrome when MoPilot's Your Chrome tools are hidden from it: its current segment's controller plan. */
  const vendorChrome = (/** @type {string} */ chatId) => vendorChromeOf(planOf(chatId));
  /** Site permissions for browser control, one table per browser (D4), and the panel tabs agents drive. */
  /** @type {InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants>} the in-app browser's; assigned by registerBrowserTools before its first await, before any window opens */
  let browserGrants;
  /** @type {InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants>} the user's own Chrome's (Your Chrome); assigned with browserGrants */
  let chromeGrants;
  /** @type {InstanceType<typeof PanelBrowser>} assigned by registerBrowserTools before its first await, before any window opens */
  let panelBrowser;
  /** The built-in browser's tabs per chat, behind the browser_* tools (electron/capabilities/browser/host.cjs). */
  /** @type {InstanceType<typeof BrowserTabs>} assigned by registerBrowserTools before its first await, before any window opens */
  let browserTabs;
  /** @type {ReturnType<typeof createHostTabs>} the tabs on every Host, this Mac's included (hostTabsWiring.cjs); assigned with browserTabs */
  let hostTabs;
  /** What the pane shows about agent control of those tabs (electron/capabilities/browser/agentTabs.cjs). */
  let agentTabs;
  const previewWiring = createDevPreviewWiring({
    app,
    shellEnv,
    isFlagEnabled,
    chatProject,
    live,
    browser: {
      get tabs() {
        return browserTabs;
      },
      get grants() {
        return browserGrants;
      },
    },
  });
  const { registerDevPreviews } = previewWiring;
  /** @type {InstanceType<typeof BrowserWindows>} assigned at startup, before any window or IPC handler uses it */
  let browserWindows;
  let browserAuth = { touchId: false };
  /** The built-in browser's partitions: the shared profile and chats' own (Settings → Browser → Storage). */
  /** @type {InstanceType<typeof BrowserStorage> | null} */
  let browserStorage = null;
  /** What pages in every browser partition may use (camera, microphone, location...): webPermissions.cjs. */
  /** @type {InstanceType<typeof WebPermissions> | null} */
  let webPermissions = null;
  // the native dialog goes on the window showing the page: a view's (none while parked), else a <webview>'s host
  const pageWindow = (wc) =>
    paneViews?.entryOf(wc) ? paneViews.windowOf(wc) : wc?.hostWebContents ? BrowserWindow.fromWebContents(wc.hostWebContents) : null;
  const askNative = dialogAsk(dialog, pageWindow);
  /** The pages' own alert, confirm and prompt (pageDialogs.cjs): the pane shows them, the agent on the tab answers them too. */
  const pageDialogs = new PageDialogs({ isPage: (wc) => !!wc && !!browserWindows?.pages.has(wc.id) });
  /** Pages that stopped responding (pageHang.cjs): a page waiting on its own dialog is not one. */
  const pageHang = new PageHang({ blocked: (wc) => !!pageDialogs.of(wc) || !!browserTabs?.dialogOpen(wc) });
  /** A page asks to confirm leaving it while the user, not an agent, left it: Chrome's question (pageDialogs.cjs leaveAsk). */
  const askLeave = leaveAsk(dialog, pageWindow);
  /** The window a view tab shows in for the passkey picker: null while parked, undefined for a page that is not a view. */
  const viewWindow = (wc) => (paneViews?.entryOf(wc) ? paneViews.windowOf(wc) : undefined);
  /** A user's view tab in a chat's pane, as WebPermissions' driver sees it: the user drives it. */
  const paneDriver = (wc) => {
    const chatId = paneViews?.chatOf(wc);
    return chatId && live.sessions?.has(chatId) ? { chatId, tabId: '', agent: false } : null;
  };
  const pagePermissions = () =>
    (webPermissions ??= new WebPermissions({
      file: path.join(app.getPath('userData'), 'capabilities', 'browser-web-permissions.json'),
      driver: (wc) => browserTabs?.driver(wc) ?? paneDriver(wc),
      // a page the user drives in a chat's tab (an agent's, or a view tab in its pane) asks on that chat's card; a tab of no chat, on a native dialog
      ask: (req) =>
        req.chatId
          ? live.computerUse.broker.ask(req.chatId, 'browserPermission', {
              harness: live.controller.ref(req.chatId).kind,
              origin: req.origin,
              permissions: req.permissions,
            })
          : askNative(req),
      note: (chatId, text) => browserTabs?.change(chatId, text),
      // a frame's link to an app: the pane offers "Open in app"
      external: (wc, url) => browserWindows?.external(wc, url),
    }));
  /** History and bookmarks (electron/capabilities/browser/data.cjs). */
  const browserData = createBrowserData({ userData: () => app.getPath('userData'), safeStorage });
  /** MoPilot's own saved logins (credentialStore.cjs): the agent's credential sheet, the user's key button and imports share one. */
  /** @type {InstanceType<typeof CredentialStore> | null} */
  let logins = null;
  const loginStore = () =>
    (logins ??= new CredentialStore({ file: path.join(app.getPath('userData'), 'capabilities', 'browser-logins.json'), safeStorage }));
  /** Saved logins under a page's sign-in fields and "Save password?" after the user signs in (loginAssist.cjs), in the user's tabs. */
  const loginAssist = createLoginAssist({
    store: loginStore,
    confirm: touchIdConfirm(systemPreferences),
    // only asked on a page's signal, after startup: registerBrowserTools has made browserTabs by then
    isAgent: (wc) => !!browserTabs.driver(wc)?.agent,
    enabled: () => isFlagEnabled('shared.browser.loginAssist'),
    notify: (wc, detail) => broadcastAll('browser:loginAssist', { pageId: wc.id, ...detail }),
  });
  /** Imports from other browsers (electron/capabilities/browser/import/), built on first use. */
  /** @type {ReturnType<typeof createImporter> | null} */
  let importer = null;
  const browserImporter = () =>
    (importer ??= createImporter({
      userData: () => app.getPath('userData'),
      data: browserData,
      logins: loginStore,
      session: () => session.fromPartition(BROWSER_PARTITION),
      broadcast: broadcastAll,
    }));
  /** Whether a page is in the shared profile, the only one whose visits are remembered. */
  const inSharedProfile = (wc) => wc.session === session.fromPartition(BROWSER_PARTITION);
  const panelStorage = () =>
    (browserStorage ??= new BrowserStorage({
      fromPartition: (p) => session.fromPartition(p),
      clearHistory: browserData.clearHistory,
      // a chat's own partition gets what the shared profile has: agent and user downloads, the passkey account picker, web permissions
      configure: (ses) => {
        pagePermissions().install(ses);
        installPageDialogs(ses);
        installFormPosts(ses, webContents);
        ses.on('will-download', onBrowserDownload);
        configureBrowserAuth({ app, session: ses, dialog, BrowserWindow, webContents, browserWindows, viewWindow });
      },
    }));
  /** Every session a browser panel tab may be in (assertCdpTarget, popups). */
  const panelSessions = () => panelStorage().sessions();
  /** Pane tabs as main-owned views (views.cjs); off, the pane hosts <webview> guests as before. */
  const viewTabsOn = () => isFlagEnabled('shared.browser.viewTabs');
  /** @type {InstanceType<typeof PaneViews> | null} assigned at startup (setupGuests) */
  let paneViews = null;
  /** The app windows, but never the Mini window. */
  const appWindowList = () => [...windows].filter((w) => !w.isDestroyed() && w !== appWindows.mini);
  /** An app:command to the window showing `wc`'s view, else the focused or main window; false when there is none. */
  const tellWindow = (wc, command, arg) => {
    const shown = wc ? paneViews?.windowOf(wc) : null;
    const focused = BrowserWindow.getFocusedWindow();
    const w = shown || (focused && windows.has(focused) && focused !== appWindows.mini ? focused : mainWindow());
    if (!w || w.isDestroyed()) return false;
    w.webContents.send('app:command', command, arg);
    return true;
  };
  /** A view tab for an agent's chat, in the partition its chat's tabs use (Settings → Browser → Storage), or a duplicate's with its `history`; null with views off. */
  const spawnView = (chatId, history = /** @type {{ entries: any[], index: number } | null} */ (null)) => {
    if (!viewTabsOn() || !paneViews) return null;
    const entry = paneViews.create({ partition: browserPartition(uiPrefs().browserStorage, chatId), url: 'about:blank', history });
    entry.keep = true;
    return entry.wc;
  };
  /** Your Chrome: one @playwright/mcp utility process per chat. */
  /** @type {InstanceType<typeof ChromeChannel>} assigned by registerBrowserTools before its first await, before any window opens */
  let chromeChannel;
  /** @type {InstanceType<typeof ChromeTokens>} assigned by registerBrowserTools before its first await, before any window opens */
  let chromeTokens;
  /** The user's Chrome over MoPilot's relay (B2 step 1, app/chromeRelay.cjs), when its switch was on at startup. */
  /** @type {ReturnType<typeof setupChromeRelay> | null} */
  let chromeRelay = null;
  /** Which channel's sage_browser_* tools sessions get. */
  /** @type {InstanceType<typeof BrowserControl>} assigned by registerBrowserTools before its first await, before any window opens */
  let browserControl;
  /** The browser channel prefs main acts on: { channel, profileDir }. */
  let browserPrefs = { channel: 'builtin', profileDir: '' };
  /** The route a chat's sign-in hand-off to the user's Chrome takes (browser/handoff.cjs chatHandoffRoute). */
  const chromeHandoffRoute = (/** @type {string} */ chatId) => {
    const snapshot = live.controllerPlans?.snapshot(chatId);
    return chatHandoffRoute({
      plan: snapshot?.plan ?? null,
      channelEnabled: snapshot?.channel === true,
      tools: snapshot?.tools ?? [],
      relay: chromeRelay,
      isEnabled: isFlagEnabled,
      channel: browserControl?.drivesUserChrome() ? 'chrome' : 'builtin', // what runs, not the preference (control.cjs)
      extension: () =>
        browserPrefs.channel === 'chrome' ||
        !!chromeTokens?.has(browserPrefs.profileDir) ||
        installedExtensionVersion({ profileDir: browserPrefs.profileDir || null }) != null,
      codexExtension: snapshot?.ownChrome === true,
    });
  };
  // where a panel session's download goes, which page's navigation it was, and the pane's Downloads list (browserDownloads.cjs)
  const shared = { app, session, ipcMain, shell, broadcast: broadcastAll };
  const { onBrowserDownload, setupDownloads } = browserDownloads({ ...shared, partition: BROWSER_PARTITION, tabs: () => browserTabs });

  /** Browser control: the built-in browser over CDP, or Your Chrome through @playwright/mcp, each behind its remote switch. */
  async function registerBrowserTools() {
    const dir = path.join(app.getPath('userData'), 'capabilities');
    // one site table per browser (D4), with the cards they ask on (browserSiteTables.cjs)
    ({ browserGrants, chromeGrants } = siteTables({ live, dir, prefs: uiPrefs, isFlagEnabled }));
    panelBrowser = new PanelBrowser({
      appContents: () => [...windows].filter((w) => !w.isDestroyed()).map((w) => w.webContents),
      panelSession: panelSessions,
      hang: pageHang,
      open: (chatId) => {
        // the chat's current browser_* tab, when it has one, is the tab sage_browser_* drives too
        const current = browserTabs?.current(chatId);
        if (current && current.kind === 'tab') {
          try {
            return void panelBrowser.attach(chatId, current.wc, current.owner);
          } catch (error) {
            // the tab may have closed: fall back to opening a new one below
            noteIgnored("drive the chat's current browser tab", error);
          }
        }
        // the chat's original tab as a view: no window needed, a window's pane shows it when there is one
        const wc = spawnView(chatId);
        if (wc) {
          browserTabs.attach(chatId, null, wc, null);
          panelBrowser.attach(chatId, wc, null);
          tellWindow(null, 'open-agent-browser-tab', chatId);
          return;
        }
        const focused = BrowserWindow.getFocusedWindow();
        const w = focused && windows.has(focused) && focused !== appWindows.mini ? focused : mainWindow();
        if (!w) return false;
        w.webContents.send('app:command', 'open-agent-browser-tab', chatId);
      },
    });
    const chatFolder = (kind, chatId) => chatFolderOf(dir, kind, chatId);
    // they hold copies of the user's files: gone with the chat, and aged out (chatFolders.cjs)
    retainChatFolders({ root: dir, chats: live.chats, deletion: live.chatDeletion });
    const windowFor = (owner) => {
      const own = owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null;
      if (own && windows.has(own)) return own;
      const focused = BrowserWindow.getFocusedWindow();
      return focused && windows.has(focused) && focused !== appWindows.mini ? focused : mainWindow();
    };
    browserTabs = new BrowserTabs({
      appContents: () => [...windows].filter((w) => !w.isDestroyed()).map((w) => w.webContents),
      panelSession: panelSessions,
      prepare: previewWiring.prepare,
      // the pages' own dialogs, which the agent answers on its tabs, and pages that stopped responding
      dialogs: pageDialogs,
      hang: pageHang,
      // a pane tab for the chat, in the window that already shows its tabs
      open: (chatId, { tabKey, focus, owner, after }) => {
        const w = windowFor(owner);
        if (!w) return false;
        w.webContents.send('app:command', 'open-agent-browser-tab', { chatId, tabKey, focus, ...(after === undefined ? {} : { after }) });
      },
      // a view tab works with no window open; with views off, a window's pane opens a <webview>
      spawn: spawnView,
      close: (tab) => {
        if (tab.kind === 'popup') return BrowserWindow.fromWebContents(tab.wc)?.close();
        const req = { chatId: tab.chatId, tabKey: tab.legacy ? null : tab.id };
        if (paneViews?.close(tab.wc)) {
          // main closed the page: every window drops its pane tab
          for (const w of appWindowList()) w.webContents.send('app:command', 'close-agent-browser-tab', req);
          return;
        }
        if (tab.owner && !tab.owner.isDestroyed()) tab.owner.send('app:command', 'close-agent-browser-tab', req);
      },
      select: (tab, { auto = false } = {}) => {
        if (tab.kind === 'popup') {
          const win = BrowserWindow.fromWebContents(tab.wc);
          return void (win?.show(), win?.focus());
        }
        const req = { chatId: tab.chatId, tabKey: tab.legacy ? null : tab.id, ...(auto ? { auto: true } : {}) };
        // a view tab may have no pane tab yet (opened with no window): opening one selects it, or adds it
        if (paneViews?.entryOf(tab.wc)) return void tellWindow(tab.wc, 'open-agent-browser-tab', { ...req, focus: true });
        if (tab.owner && !tab.owner.isDestroyed()) tab.owner.send('app:command', 'select-agent-browser-tab', req);
      },
      // sage_browser_* follow the chat's current tab
      onSelect: (chatId, wc, owner) => panelBrowser.attach(chatId, wc, owner),
      onChange: (chatId) => (agentTabs?.changed(chatId), live.phoneTabsChanged?.(chatId)),
      images: { fromBuffer: (buf) => nativeImage.createFromBuffer(buf) },
      downloadsDir: (chatId) => chatFolder('browser-downloads', chatId),
      platform: process.platform,
      // where the agent clicks and types, drawn on the page (IAB-04); it glides (and the action waits) only where seen
      cursor: new AgentCursor({
        enabled: () => isFlagEnabled('shared.browser.agentCursor'),
        shown: (tab) => seenByUser(pageWindow(tab.wc), paneViews?.entryOf(tab.wc) ? 'front' : tab.layer),
      }),
      // screenshots sized for the chat's current model, as desktop screenshots are (IAB-07)
      modelOf: (chatId) => chatModel(live.controller.ref(chatId).kind, live.chats.record?.(chatId), uiPrefs()),
    });
    // a machine's chats use that machine's browser: one RemoteTabs per Host, made when a chat first needs it (electron/app/hostTabsWiring.cjs)
    live.remoteBrowserTabs = remoteBrowserFactory({
      live,
      nativeImage,
      chatModel,
      uiPrefs,
      hang: pageHang,
      tell: tellWindow,
      windows: appWindowList,
    });
    // a site the user lowered to read only refuses writes for the rest of the turn, then asks again
    browserTabs.onTurnEnd((chatId) => {
      browserGrants.turnEnded(chatId);
      chromeGrants.turnEnded(chatId);
    });
    hostTabs = createHostTabs({ live, local: browserTabs });
    agentTabs ??= registerAgentTabs({
      ipcMain,
      tabs: () => browserTabs,
      hosts: () => hostTabs,
      desktops: () => live.computerUse?.hostDesktop?.tabs,
      grants: () => browserGrants,
      broadcast: broadcastAll,
      stop: (chatId) => live.controller.stopChat(chatId),
      report: noteIgnored,
    });
    live.agentTabsChanged = agentTabs.changed;
    const folders = (chatId) => ({ uploads: chatFolder('browser-uploads', chatId), downloads: chatFolder('browser-downloads', chatId) });
    const traces = createTurnTraces({ ipcMain, readState, isFlagEnabled, broadcastAll, hostTabs, dir, browserGrants }); // G5, both browsers
    if (isFlagEnabled('shared.browser.parityTools')) {
      // browser_request_credentials: the sheet in the chat, and logins saved in MoPilot's own store
      const credentials = (live.credentialHandoff = new CredentialHandoff({
        store: loginStore(),
        onChange: (list) => broadcastAll('browser:credentialRequestsChanged', list),
      }));
      registerCredentialIpc({ ipcMain, handoff: credentials });
      registerBrowserHostTools(traces.recording(live.routines.recording(live.capabilities, hostTabs.routed())) /* G4, G5 */, {
        tabs: hostTabs.routed(),
        grants: browserGrants,
        credentials,
        memory: browserData,
        // MoPilot can't fill a login in the user's own Chrome: the Chrome controller the current segment's plan names
        // (Claude in Chrome while its link is up, the Codex Browser plugin), else Your Chrome when the channel is
        // set to it. A chat working in an in-app tab this turn (the agent holds it) is not there; an old tab doesn't count
        chromeRoute: (chatId) => {
          if (browserTabs?.current(chatId)?.held) return null;
          const vendor = vendorChrome(chatId);
          // Claude in Chrome is the chat's browser only while its link is up
          if (vendor === 'Claude in Chrome') return claudeLinkOf(chatId)?.connected ? vendor : null;
          if (vendor) return `${vendor} in your Chrome`;
          return browserControl?.drivesUserChrome() ? 'Your Chrome' : null;
        },
        // checked on every call so remote switches apply at once (never the Your Chrome channel choice)
        enabled: () => inAppBrowserEnabled(isFlagEnabled),
        // JavaScript and uploads: a card for each call, naming the in-app browser
        confirm: confirmCall(live, 'iab'),
        folders,
        // a Chrome tab of a native Codex thread's plugin (#1539): the Chrome host's, set up below
        chromeShots: (chatId, tabId) => chromeRelay?.screenshots(chatId, tabId) ?? null,
      });
      registerDevPreviews(dir);
    }
    chromeTokens = new ChromeTokens({ file: path.join(dir, 'chrome-token.json'), safeStorage });
    // B2 (design D5): the user's Chrome over MoPilot's own extension (step 2) or its relay to the Playwright Extension (step 1), behind their
    // switches (read once, here); Codex segments get the extension by default wherever this build ships it, unless the vendor's own Chrome is chosen (chromeControl.cjs)
    const chromeKind = servedChromeKind(isFlagEnabled, { shipped: extensionShipped() });
    if (chromeKind) {
      const relayed = setupChromeRelay({
        registry: live.routines.recording(live.capabilities, () => live.chromeRelay?.tabs, 'chrome_'), // G4: records chrome_* steps
        // the user's Chrome's own site table (D4), the one Your Chrome uses: cards name Chrome
        grants: chromeGrants,
        token: () => chromeTokens.get(browserPrefs.profileDir),
        profileDir: () => browserPrefs.profileDir,
        images: { fromBuffer: (buf) => nativeImage.createFromBuffer(buf) },
        modelOf: (chatId) => chatModel(live.controller.ref(chatId).kind, live.chats.record?.(chatId), uiPrefs()),
        confirm: confirmCall(live, 'chrome'),
        folders,
        isFlagEnabled,
        kind: chromeKind,
        // the extension's saved pairing and its native host's launcher live here (app/chromeRelay.cjs extensionFiles)
        files: { dir, safeStorage, packaged: app.isPackaged },
        traces,
        ...chromeRelayNotices({ changed: () => live.capabilityHealth?.changed(), notifier: () => live.notifier, appWindows }),
        chatTitle: (chatId) => live.codex?.chatName(chatId) || null,
        busy: (chatId) => !!live.sessions?.running(chatId), // a running chat keeps its Chrome tabs; an idle one lets go
        controller: live.controller, // a Chrome tab's Stop is the chat's Esc; a reply's named tabs stay at let-go
        panel: (m, reply) => live.chromePanel?.handle(m, reply), // Chrome's side panel (app/chromePanel.cjs)
      });
      chromeRelay = relayed;
      // at will-quit: a quit the exit gate holds back (a turn running, the user cancels) keeps Chrome control
      app.on('will-quit', () => relayed.stop());
    }
    const outputDir = path.join(dir, 'playwright-output');
    chromeChannel = new ChromeChannel({
      fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      // the extension tracks the pinned @playwright/mcp release; its installed version is read from the Chrome profile
      pinnedExtension: require('@playwright/mcp/package.json').version,
      extensionVersion: () => installedExtensionVersion({ profileDir: browserPrefs.profileDir || null }),
      spec: () => {
        fs.mkdirSync(outputDir, { recursive: true });
        return chromeSpawnSpec({
          outputDir,
          profileDir: browserPrefs.profileDir || null,
          token: chromeTokens.get(browserPrefs.profileDir),
          env: process.env,
        });
      },
      // a chat's instance (its tab group) stays while its turn runs; quitting stops them all (electron/app/lifecycle.cjs)
      busy: (chatId) => !!live.sessions?.running(chatId),
      // without a saved token, Chrome asks the user to approve each new connection: the chat says so while a call waits
      onApproval: (chatId, waiting) => live.sessions?.patch(chatId, { chromeApproval: waiting }),
    });
    browserControl = new BrowserControl({
      registry: live.capabilities,
      grants: browserGrants,
      chromeGrants,
      panel: panelBrowser,
      chrome: chromeChannel,
      isEnabled: isFlagEnabled,
      cache: schemaCache(path.join(dir, `playwright-mcp-${require('@playwright/mcp/package.json').version}-tools.json`)),
      ownChrome: () => chromeToolsOn(isFlagEnabled, { shipped: extensionShipped() }), // Chrome through MoPilot's extension
    });
    const p = readState().prefs || {};
    browserPrefs = {
      channel: p.browserChannel === 'chrome' ? 'chrome' : 'builtin',
      profileDir: typeof p.chromeProfileDir === 'string' ? p.chromeProfileDir : '',
    };
    await browserControl.configure(browserPrefs.channel);
    broadcastAll('browser:channelChanged', chromeState());
  }

  function chromeState() {
    return {
      active: browserControl?.active ?? null,
      hasToken: !!chromeTokens?.has(browserPrefs.profileDir),
      extensionUrl: EXTENSION_URL,
      // chats that keep their Chrome connection until their turn ends, after a profile or token change
      waitingChats: chromeChannel?.releasing().length ?? 0,
    };
  }

  /**
   * A view tab's popup (window.open, target=_blank, OAuth) as a tab of the same pane: the popup's own
   * webContents (Chromium keeps its opener, POST body and window.close), wrapped in a view. An agent's
   * tab opens an agent tab of its chat; a user's tab a pane tab of its opener's chat (named by `opener`, its pane tab).
   */
  function openPopupTab(opener, options, url) {
    const views = /** @type {InstanceType<typeof PaneViews>} */ (paneViews);
    const entry = options?.webContents ? views.adopt(options.webContents) : views.create({ session: opener.session, url });
    entry.keep = !!views.entryOf(opener)?.keep;
    try {
      panelBrowser?.registerPopup(opener, entry.wc);
    } catch (error) {
      // sage_browser_* keep their tab; the popup is still a pane tab
      noteIgnored('let the agent drive a popup', error);
    }
    const tab = browserTabs?.adoptPopup(opener, entry.wc, { asTab: true });
    if (tab) tellWindow(opener, 'open-agent-browser-tab', { chatId: tab.chatId, tabKey: tab.id, focus: true });
    else {
      const paneId = `browser-${crypto.randomUUID()}`;
      views.name(entry, paneId);
      tellWindow(opener, 'open-browser-view', { paneId, url, title: url, opener: [...(views.entryOf(opener)?.panes ?? [])][0] });
    }
    return entry.wc;
  }

  /** At app ready: popups from browser tabs, passkeys, sign-in and web permissions for the shared profile, and every tab a sandboxed page. */
  function setupGuests() {
    browserWindows = new BrowserWindows({
      BrowserWindow,
      appContents: () => [...windows].filter((w) => !w.isDestroyed()).map((w) => w.webContents),
      panelSession: panelSessions,
      onPopup: (opener, popup) => {
        panelBrowser?.registerPopup(opener, popup);
        browserTabs?.adoptPopup(opener, popup);
      },
      openTab: openPopupTab,
      shortcutBindings: () => readState().prefs?.keybindings ?? {},
      broadcast: broadcastAll,
      dialogs: pageDialogs,
      hang: pageHang,
      acting: (wc) => !!browserTabs?.acting(wc),
      askLeave,
      note: (wc, text, cdp) => browserTabs?.notePage(wc, text, cdp),
      openExternal: (url) => shell.openExternal(url),
      systemLanguages: app.getPreferredSystemLanguages.bind(app),
    });
    pagePermissions().install(session.fromPartition(BROWSER_PARTITION));
    installPageDialogs(session.fromPartition(BROWSER_PARTITION));
    installFormPosts(session.fromPartition(BROWSER_PARTITION), webContents);
    // whether the shared profile is signed in to claude.ai: main follows it with no window open (claudeSite.cjs)
    registerClaudeSignIn({ ipcMain, session: () => panelStorage().shared, broadcast: broadcastAll });
    // the dialog preload's question: the page waits for the answer (pageDialogs.cjs)
    ipcMain.on(PAGE_DIALOG_CHANNEL, (event, type, message, defaultPrompt) => pageDialogs.request(event, type, message, defaultPrompt));
    paneViews = new PaneViews({
      WebContentsView,
      BrowserWindow,
      session: (p) => session.fromPartition(p),
      partition: (p) => panelStorage().partition(p),
      windowOf: (sender) => {
        const w = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
        return w && windows.has(w) ? w : null;
      },
      agentView: (chatId, tabKey) => browserTabs?.byKey(chatId, tabKey)?.wc ?? null,
      prepare: previewWiring.prepare,
      onCreated: (wc) => {
        browserWindows.register(wc);
        browserData.attach(wc, inSharedProfile);
        loginAssist.attach(wc);
      },
    });
    const quittingViews = paneViews;
    app.on('before-quit', (event) => {
      if (!event.defaultPrevented) quittingViews.shutdown();
    });
    startMemoryGuard({ app, browserWindows, windows });
    // where closing every window quits the app, the hidden window parked views live in must not keep it running
    app.on('browser-window-created', (_e, win) =>
      win.once('closed', () => {
        if (process.platform !== 'darwin' && !appWindowList().length) paneViews?.dropPark();
      }),
    );
    browserAuth = configureBrowserAuth({
      app,
      session: session.fromPartition(BROWSER_PARTITION),
      dialog,
      BrowserWindow,
      webContents,
      browserWindows,
      viewWindow,
    });
    // Browser tabs: sandboxed guests in their own session, no preload. Native popups retain OAuth callbacks.
    app.on('web-contents-created', (_e, wc) => {
      wc.on('will-attach-webview', (ev, prefs, params) => {
        // pane tabs are main's views: no window may attach a guest
        if (viewTabsOn()) return void ev.preventDefault();
        delete prefs.preload;
        prefs.nodeIntegration = false;
        // the page dialogs' preload runs in a guest's frames too (sandboxed below: no Node)
        prefs.nodeIntegrationInSubFrames = true;
        prefs.contextIsolation = true;
        prefs.sandbox = true;
        prefs.webSecurity = true;
        prefs.webviewTag = false;
        Object.assign(prefs, webMcpPrefs()); // a page's own tools (WebMCP, webmcp.cjs) with their switch, as views and popups
        // the shared profile, or the chat's own partition the pane asked for (Settings → Browser → Storage)
        const partition = panelStorage().partition(params.partition);
        prefs.partition = partition;
        params.partition = partition;
      });
      wc.on('did-attach-webview', (_event, guest) => {
        browserWindows.register(guest);
        browserData.attach(guest, inSharedProfile);
        loginAssist.attach(guest);
      });
      if (wc.getType() === 'webview') {
        // Closed until the app's host reports this guest; register() installs the browser-only policy.
        wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      }
    });
  }

  return {
    browserData,
    browserImporter,
    loginStore,
    loginAssist,
    panelStorage,
    panelSessions,
    setupDownloads,
    registerBrowserTools,
    chromeState,
    setupGuests,
    vendorChrome,
    chromeHandoffRoute,
    /** @returns {InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants>} */
    get browserGrants() {
      return browserGrants;
    },
    /** @returns {InstanceType<typeof import('../capabilities/browser/origins.cjs').OriginGrants>} */
    get chromeGrants() {
      return chromeGrants;
    },
    /** @returns {InstanceType<typeof PanelBrowser>} */
    get panelBrowser() {
      return panelBrowser;
    },
    /** @returns {InstanceType<typeof BrowserTabs>} */
    get browserTabs() {
      return browserTabs;
    },
    get hostTabs() {
      return hostTabs;
    },
    /** @returns {InstanceType<typeof import('../capabilities/browser/devPreview.cjs').DevPreviews> | null} */
    get devPreviews() {
      return previewWiring.devPreviews;
    },
    /** @returns {InstanceType<typeof import('../capabilities/browser/browserShim.cjs').BrowserShim> | null} */
    get browserShim() {
      return previewWiring.browserShim;
    },
    /** @returns {InstanceType<typeof PaneViews> | null} */
    get paneViews() {
      return paneViews;
    },
    /** @returns {InstanceType<typeof BrowserWindows>} */
    get browserWindows() {
      return browserWindows;
    },
    get browserAuth() {
      return browserAuth;
    },
    /** @returns {InstanceType<typeof BrowserStorage> | null} */
    get browserStorage() {
      return browserStorage;
    },
    /** @returns {InstanceType<typeof ChromeChannel>} */
    get chromeChannel() {
      return chromeChannel;
    },
    /** @returns {InstanceType<typeof ChromeTokens>} */
    get chromeTokens() {
      return chromeTokens;
    },
    /** @returns {ReturnType<typeof setupChromeRelay> | null} */
    get chromeRelay() {
      return chromeRelay;
    },
    /** @returns {InstanceType<typeof BrowserControl>} */
    get browserControl() {
      return browserControl;
    },
    get browserPrefs() {
      return browserPrefs;
    },
    /** @param {typeof browserPrefs} v */
    set browserPrefs(v) {
      browserPrefs = v;
    },
  };
}

module.exports = { createBrowserTools };
