// IPC for the browser pane: panel tabs (views or guests), site grants, the browser channel and Chrome, popups and annotate capture.
const path = require('node:path');
const { registerPaneNavigation } = require('../../capabilities/browser/paneNavigation.cjs');
const { assertCdpTarget } = require('../../capabilities/browser/cdp.cjs');
const { registerViewIpc } = require('../../capabilities/browser/views.cjs');
const { savedWebPermissions } = require('../../capabilities/browser/webPermissions.cjs');
const registerBrowserData = require('./browserData.cjs').register;
const registerBrowserImport = require('./browserImport.cjs').register;
const registerBrowserLogins = require('./browserLogins.cjs').register;
const registerBrowserErrands = require('./browserErrands.cjs').register;
const { touchIdConfirm } = require('../../capabilities/browser/userFill.cjs');
const { traitsOf } = require('../../harness/family.cjs');
const { openSiteForRoute } = require('../../capabilities/browser/openSite.cjs');
const { vendorChromeProfile } = require('../../capabilities/nativeAvailability.cjs');
const { openInChrome } = require('../../capabilities/browser/userChrome.cjs');
const { handoffContinuation, handoffOwner } = require('../../capabilities/browser/handoffContinuation.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const {
    shell,
    dialog,
    BrowserWindow,
    systemPreferences,
    panelStorage,
    webContents,
    setupDownloads,
    broadcastAll,
    chromeState,
    registerAnnotateCapture,
    panelSessions,
    chromeHandoff,
    cancelChromeHandoff,
    isFlagEnabled,
    patchPrefs,
    STATE_FILE,
    app,
    readJson,
    usedClaudeInChrome,
    writeAtomic,
    chromeHandoffRoute,
    live,
  } = deps;
  registerPaneNavigation(ipcMain, {
    page: (sender, id) => {
      const wc = webContents.fromId(id);
      const views = live.paneViews;
      const entry = views?.entryOf(wc);
      if (entry && !entry.binders.has(sender)) throw new Error('This page belongs to another window.');
      assertCdpTarget(wc, { appContents: [sender], panelSession: panelSessions(), host: sender });
      return wc;
    },
    create: (sender, paneId, source, chat) => {
      const views = live.paneViews;
      if (!views) throw new Error('Browser tabs are not available yet.');
      if (views.panes.has(paneId) || views.closed.has(paneId)) throw new Error('This duplicate tab already exists.');
      const entry = views.create({ session: source.session });
      entry.chat = chat;
      views.name(entry, paneId);
      if (!views.bind(paneId, sender, { chat })) {
        entry.wc.close();
        throw new Error('Could not create the duplicate tab.');
      }
      return entry.wc;
    },
    chatOf: (id) => live.controller.chatOf(id),
    ownerOf: (wc) => {
      const driver = live.browserTabs?.driver(wc);
      const entry = live.paneViews?.entryOf(wc);
      if (!driver && !entry) return undefined;
      const chat = driver?.chatId ?? entry?.chat;
      return chat ? live.controller.chatOf(chat) : null;
    },
  });
  // the shared profile and every chat's own storage
  registerBrowserData(ipcMain, { data: live.browserData, broadcastAll });
  registerBrowserErrands(ipcMain, { live, broadcastAll });
  registerBrowserLogins(ipcMain, {
    store: live.loginStore,
    assist: () => live.loginAssist,
    webContents,
    panelSessions,
    confirm: touchIdConfirm(systemPreferences),
  });
  registerBrowserImport(ipcMain, {
    importer: live.browserImporter,
    enabled: () => isFlagEnabled('shared.browser.import'),
    openExternal: (url) => shell.openExternal(url),
    // the passwords file Safari exported: the user picks it, and may send it to the Trash once imported
    chooseFile: async (sender) => {
      const win = BrowserWindow.fromWebContents(sender);
      /** @type {import('electron').OpenDialogOptions} */
      const opts = {
        title: 'Choose the passwords file Safari exported',
        properties: ['openFile'],
        filters: [{ name: 'Passwords (CSV)', extensions: ['csv'] }],
      };
      const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    trash: (file) => shell.trashItem(file),
  });
  ipcMain.handle('browser:clearData', () => panelStorage().clearAll(webContents.getAllWebContents()));
  ipcMain.handle('browser:setDownloads', (_e, dir, ask) => setupDownloads(dir, ask));
  // pane tabs as main-owned views: binding, bounds, the toolbar and closing (views.cjs)
  registerViewIpc(ipcMain, () => live.paneViews);
  ipcMain.handle('browser:preparePreview', (_e, chat, url) => {
    if ((chat !== null && typeof chat !== 'string') || typeof url !== 'string') throw new Error('Invalid preview address.');
    return live.devPreviews?.prepare(chat, url) ?? url;
  });
  // a window's panel tab for an agent's chat; main checks it is a panel guest before CDP touches it
  ipcMain.handle('browser:attach', (e, chatId, wcId, tabKey) => {
    try {
      const wc = webContents.fromId(wcId);
      // every agent tab joins the chat's browser_* tabs; the chat's original tab also stays sage_browser_*'s
      if (live.browserTabs) live.browserTabs.attach(chatId, typeof tabKey === 'string' ? tabKey : null, wc, e.sender);
      if (!live.browserTabs || typeof tabKey !== 'string') live.panelBrowser?.attach(chatId, wc, e.sender);
      return true;
    } catch {
      return false;
    }
  });
  // how a window's pane lays out a panel tab's page: input and screenshots wait until it is painted
  ipcMain.handle('browser:layer', (e, wcId, layer) => {
    try {
      return !!live.browserTabs?.layer(webContents.fromId(wcId), layer, e.sender);
    } catch {
      return false;
    }
  });
  // each browser keeps its own site table (D4): the in-app browser's unless the call names the user's Chrome
  const grantsOf = (browser) => (browser === 'chrome' ? live.chromeGrants : live.browserGrants);
  ipcMain.handle('browser:sites', (_e, browser) => grantsOf(browser)?.list() ?? []);
  ipcMain.handle('browser:setSite', (_e, origin, level, browser) => {
    grantsOf(browser)?.set(origin, level ?? null);
    return grantsOf(browser)?.list() ?? [];
  });
  // the chat's "ways forward" strip: a site the user refused is allowed for the rest of that chat (never a blocked one), in the browser that refused it
  ipcMain.handle(
    'browser:allowSiteInChat',
    (_e, chatId, origin, level, browser) => grantsOf(browser)?.allowInChat(chatId, origin, level) ?? false,
  );
  // sites allowed the camera, microphone, location or notifications for good (webPermissions.cjs)
  const webPermissionsFile = () => path.join(app.getPath('userData'), 'capabilities', 'browser-web-permissions.json');
  ipcMain.handle('browser:webPermissions', () => savedWebPermissions(webPermissionsFile()).list());
  ipcMain.handle('browser:forgetWebPermission', (_e, origin) => savedWebPermissions(webPermissionsFile()).forget(String(origin)));
  ipcMain.handle('browser:configure', async (_e, prefs) => {
    const next = {
      channel: prefs?.channel === 'chrome' ? 'chrome' : 'builtin',
      profileDir: typeof prefs?.profileDir === 'string' ? prefs.profileDir.trim() : '',
    };
    // a new profile or token takes effect on each chat's next instance; a chat working in its Chrome keeps its own until its turn ends
    if (next.profileDir !== live.browserPrefs.profileDir) live.chromeChannel?.restartAll();
    live.browserPrefs = next;
    await live.browserControl?.configure(next.channel);
    broadcastAll('browser:channelChanged', chromeState());
    return chromeState();
  });
  ipcMain.handle('browser:chromeState', () => chromeState());
  ipcMain.handle('browser:pageState', (e, id) => ({
    pages: live.browserWindows.state(id, e.sender),
    auth: live.browserAuth,
    restartUrl: live.browserWindows.restart(id, e.sender),
  }));
  ipcMain.handle('browser:focusPopup', (e, id) => live.browserWindows.focus(id, e.sender));
  // Annotate mode: its overlay (isolated world) and marked screenshot, on the asking window's own pane tabs in any pane session
  registerAnnotateCapture(ipcMain, { webContents, panelSession: panelSessions });
  ipcMain.handle('browser:closePopup', (e, id) => live.browserWindows.closePopup(id, e.sender));
  ipcMain.handle('browser:cancelPasskey', (e, id, legacy) => live.browserWindows.cancelPasskey(id, e.sender, legacy));
  // a page notice's actions (shared/browserNotice.mjs): its own dialog answered, its app link opened on the user's
  // click, a notice put away, and a page that stopped responding stopped (Reload and Close tab start there)
  ipcMain.handle('browser:answerDialog', (e, id, dialogId, accept, text) =>
    live.browserWindows.answerDialog(id, dialogId, accept, typeof text === 'string' ? text : null, e.sender),
  );
  ipcMain.handle('browser:openAppLink', (e, id, linkId) => live.browserWindows.openAppLink(id, linkId, e.sender));
  ipcMain.handle('browser:dismissNotice', (e, id) => live.browserWindows.dismiss(id, e.sender));
  ipcMain.handle('browser:stopPage', (e, id) => live.browserWindows.stop(id, e.sender));
  ipcMain.handle('browser:reloadPage', (e, id) => live.browserWindows.reload(id, e.sender));
  ipcMain.handle('browser:resubmitPage', (e, id) => live.browserWindows.resubmit(id, e.sender));
  ipcMain.handle('browser:setAudioMuted', (e, id, muted) => live.browserWindows.setAudioMuted(id, muted === true, e.sender));
  // a request without a page (the ways-forward strip) hands over the chat's current agent tab
  const withPage = (request) => {
    if (!request || typeof request !== 'object' || request.webContentsId != null) return request;
    const chatId = typeof request.chatId === 'string' ? request.chatId : null;
    return { ...request, webContentsId: (chatId && live.browserTabs?.current(chatId)?.wc.id) ?? undefined };
  };
  // which way "Open in Chrome" goes for a chat, so the pane offers only a hand-off that can complete
  // Settings → Browser's "Use Claude in Chrome": saved before it answers, so the rows read again with the new choice and
  // the next Claude Code session starts with it (agentTools.cjs claudeInChrome)
  ipcMain.handle('browser:claudeInChrome', (_e, on) => {
    const value = on === true;
    patchPrefs(STATE_FILE(), { claudeInChrome: value });
    broadcastAll('prefs:changed', { set: { claudeInChrome: value }, unset: [] });
    return value;
  });
  ipcMain.handle('browser:handoffRoute', (_e, chatId) => (typeof chatId === 'string' && chatId ? chromeHandoffRoute(chatId) : 'none'));
  ipcMain.handle('browser:handoffContinuation', (_e, { chatId, url, signedIn } = {}) => {
    return handoffContinuation(live, chromeHandoffRoute, chatId, url, signedIn === true);
  });
  ipcMain.handle('browser:continueInChrome', (e, request) =>
    chromeHandoff({
      browserWindows: live.browserWindows,
      chromeChannel: live.chromeChannel,
      browserControl: live.browserControl,
      isEnabled: () => isFlagEnabled('shared.browser.extension'),
      getPrefs: () => live.browserPrefs,
      commitPrefs: (next) => {
        patchPrefs(STATE_FILE(), { browserChannel: next.channel });
        live.browserPrefs = next;
        broadcastAll('prefs:changed', { set: { browserChannel: next.channel }, unset: [] });
      },
      changed: () => broadcastAll('browser:channelChanged', chromeState()),
      // a chat whose harness drives Chrome itself, or MoPilot's chrome_* tools, gets the site in the user's Chrome
      route: chromeHandoffRoute,
      owner: (chatId) => handoffOwner(live.controller, chatId),
      openSite: (url, route) =>
        openSiteForRoute(url, route, {
          openExternal: (u) => shell.openExternal(u),
          openInChrome,
          vendorProfile: (controller, userData) => vendorChromeProfile(controller, { userData }),
          profileDir: live.browserPrefs.profileDir,
        }),
      // the agent's browser_request_signin call still waiting on the page learns where to continue
      signinMoved: (chatId, note, wcId) => live.browserTabs?.signinMoved(chatId, note, wcId),
    })(withPage(request), e.sender),
  );
  ipcMain.handle('browser:cancelChromeHandoff', (e, request) =>
    cancelChromeHandoff({ browserWindows: live.browserWindows, chromeChannel: live.chromeChannel }, request, e.sender),
  );
  ipcMain.handle('browser:setChromeToken', (_e, token) => {
    const ok = live.chromeTokens?.set(live.browserPrefs.profileDir, token) ?? false;
    live.chromeChannel?.restartAll();
    return ok;
  });
  // the one-time "Claude in Chrome is replaced" note: only for people who used it, until they act on it or close it
  const noteFile = () => path.join(app.getPath('userData'), 'claude-in-chrome-note.json');
  ipcMain.handle('browser:claudeInChromeNote', (_e, chatId) => {
    if (readJson(noteFile(), null)?.dismissed) return false;
    // shown in a chat on a harness whose sessions ran Claude in Chrome themselves, and on the settings page
    if (typeof chatId === 'string' && !traitsOf(live.controller.ref(chatId).kind).nativeChrome) return false;
    return usedClaudeInChrome();
  });
  ipcMain.handle('browser:dismissClaudeInChromeNote', () => {
    writeAtomic(noteFile(), JSON.stringify({ dismissed: true }));
    return true;
  });
  ipcMain.handle('browser:testChrome', () => live.chromeChannel?.test() ?? { ok: false, message: 'Not ready' });
}

module.exports = { register };
