// Electron main process: the composition root that creates main's services (electron/app), wires them and registers IPC.
const {
  app,
  BrowserWindow,
  WebContentsView,
  webContents,
  utilityProcess,
  safeStorage,
  ipcMain: electronIpc,
  dialog,
  shell: systemShell,
  Menu,
  nativeTheme,
  clipboard,
  Notification,
  protocol,
  net,
  screen,
  globalShortcut,
  session,
  Tray,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  systemPreferences,
} = require('electron');
// a harness request's answer reaches the window after the stream deltas main sent before it (electron/harness/coreBatcher.cjs)
// and, while the performance probe runs, each answer timed (electron/perf/probe.cjs timedIpc)
const ipcMain = require('./perf/probe.cjs').timedIpc(
  require('./harness/coreBatcher.cjs').orderedReplies(electronIpc, (fn, args) => appWindows.streams.ordered(fn, args)),
);
const path = require('node:path');
// every link main opens goes through the scratch-Chrome guard (capabilities/browser/userChrome.cjs, #1535)
const shell = require('./capabilities/browser/userChrome.cjs').userShell(systemShell);
const fs = require('node:fs');
const { createGitQueries } = require('./platform/gitQueries.cjs');
const { APP_NAME, retryMigration, migrationReport, restoreMigration } = require('./migrations/migrate.cjs');
const { parseLsFilesZ } = require('./platform/gitParse.cjs');
const { API_BASE } = require('./platform/install.cjs');
const { restoreGoal } = require('./session/goalHeld.cjs');
const { linkedChildOf } = require('./session/orchestration/family.cjs');
const { isEnabled: isFlagEnabled } = require('./platform/flags.cjs');
const claude = require('./app/claudeHarness.cjs').createClaudeHarness({ shell, preferHighestCli: () => appState.preferHighestCli() });
const { ProjectsStore, registerProjects } = require('./platform/projects.cjs');
const { registerChats, patchPrefs, patchPrefsSync } = require('./platform/chats.cjs');
const pty = require('./platform/pty.cjs');
const gitPlatform = require('./platform/git.cjs');
const shellEnv = require('./platform/env.cjs');
const search = require('./platform/search.cjs');
const { AppServer } = require('./harness/codex.cjs');
const { listCodexProjects } = require('./platform/codexImport.cjs');
const { writeAtomic, readJson } = require('./platform/fsutil.cjs');
const { QuickChatState, QuickChatRequests, rendererReadiness, knownChat } = require('./session/quickChat.cjs');
const { CodexProviders, authCommandPath } = require('./identity/contract/codexProvider.cjs');
const acp = require('./harness/acp.cjs');
const { usedClaudeInChrome } = require('./capabilities/browser/chromeMigration.cjs');
const { registerCapture: registerAnnotateCapture } = require('./capabilities/browser/annotate.cjs');
const { chromeHandoff, cancelChromeHandoff } = require('./capabilities/browser/handoff.cjs');
const { registerNotify } = require('./platform/notify.cjs');
const { createDictation } = require('./platform/voice.cjs');
const fsPlatform = require('./platform/fs.cjs');
const { spawnArgs } = require('./platform/winbin.cjs');
const { createCommands } = require('./app/commands.cjs');
const { createAppState } = require('./app/appState.cjs');
const { createCodexServer } = require('./app/codexServer.cjs');
const { createWindows } = require('./app/windows.cjs');
const { createZoom } = require('./app/zoom.cjs');
const { createMenus } = require('./app/menu.cjs');
const { createChatSessions } = require('./app/sessions.cjs');
const { createBrowserTools } = require('./app/browserTools.cjs');
const { createAgentTools } = require('./app/agentTools.cjs');
const { createComputerAccess, openNotified } = require('./app/computerAccess.cjs');
const { createAutomations } = require('./app/automations.cjs');
const { createUpdates } = require('./app/updates.cjs');
const { createIdentity } = require('./app/identity.cjs');
const { createLifecycle } = require('./app/lifecycle.cjs');
const { startApp } = require('./app/startup.cjs');
const { openFlags } = require('./app/flags.cjs');
const { applyBackgroundMode } = require('./app/backgroundMode.cjs');
const { registerIpcModules } = require('./app/ipc/modules.cjs');
const windowReadiness = rendererReadiness();
const quickRequests = new QuickChatRequests();
/** @type {InstanceType<typeof QuickChatState>} assigned at startup, before any window or IPC handler uses it */
let quickState;
// E2E instances run behind the user's work (SAGE_E2E_BACKGROUND=1): no focus, Dock icon or OS notifications.
applyBackgroundMode({ app, BrowserWindow, Notification });
// Never let a parent Claude Code / API-key environment leak into Codex, terminals or the Claude CLI.
claude.scrubProcessEnv();
// The login shell's env (PATH from nvm, ~/.local/bin, …); awaited before any harness is looked up.
shellEnv.init();

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const isWin = process.platform === 'win32';
/** Main's late-bound services and state, which the modules in electron/app/ipc and electron/app read, and a few set, through these accessors. */
const live = {
  get codex() {
    return chatSessions.codex;
  },
  get controller() {
    return chatSessions.controller;
  },
  get capsService() {
    return chatSessions.capsService;
  },
  get acpAdmission() {
    return chatSessions.acpAdmission;
  },
  get acpHost() {
    return chatSessions.acpHost;
  },
  get peerRuntime() {
    return chatSessions.peerRuntime;
  },
  get sessions() {
    return chatSessions.sessions;
  },
  get chats() {
    return appState.chats;
  },
  get mini() {
    return appWindows.mini;
  },
  get quickState() {
    return quickState;
  },
  get claudeTurns() {
    return chatSessions.claudeTurns;
  },
  get acpTurns() {
    return chatSessions.acpTurns;
  },
  get switchRunner() {
    return chatSessions.switchRunner;
  },
  get controllerPlans() {
    return chatSessions.controllerPlans;
  },
  /** @param {typeof notifyMode} v */
  set notifyMode(v) {
    notifyMode = v;
  },
  /** @param {typeof notifyKinds} v */
  set notifyKinds(v) {
    notifyKinds = v;
  },
  get menuKeybindings() {
    return menus.menuKeybindings;
  },
  set menuKeybindings(v) {
    menus.menuKeybindings = v;
  },
  get cookieStatus() {
    return lifecycle.cookieStatus;
  },
  get migration() {
    return appState.migration;
  },
  set migration(v) {
    appState.migration = v;
  },
  get browserTabs() {
    return browserTools.browserTabs;
  },
  get hostTabs() {
    return browserTools.hostTabs;
  },
  get panelBrowser() {
    return browserTools.panelBrowser;
  },
  get browserGrants() {
    return browserTools.browserGrants;
  },
  get chromeGrants() {
    return browserTools.chromeGrants;
  },
  get browserPrefs() {
    return browserTools.browserPrefs;
  },
  set browserPrefs(v) {
    browserTools.browserPrefs = v;
  },
  get chromeChannel() {
    return browserTools.chromeChannel;
  },
  get browserControl() {
    return browserTools.browserControl;
  },
  get browserWindows() {
    return browserTools.browserWindows;
  },
  get paneViews() {
    return browserTools.paneViews;
  },
  get browserAuth() {
    return browserTools.browserAuth;
  },
  get chromeTokens() {
    return browserTools.chromeTokens;
  },
  get chromeRelay() {
    return browserTools.chromeRelay;
  },
  get devPreviews() {
    return browserTools.devPreviews;
  },
  get browserShim() {
    return browserTools.browserShim;
  },
  get browserStorage() {
    return browserTools.browserStorage;
  },
  get browserData() {
    return browserTools.browserData;
  },
  get browserImporter() {
    return browserTools.browserImporter;
  },
  get loginStore() {
    return browserTools.loginStore;
  },
  get loginAssist() {
    return browserTools.loginAssist;
  },
  get accounts() {
    return signIns.accounts;
  },
  get identity() {
    return signIns.identity;
  },
  get mopilot() {
    return signIns.mopilot;
  },
  get capabilities() {
    return agentTools.capabilities;
  },
  get capabilityHealth() {
    return agentTools.health;
  },
  get nativeAvailability() {
    return agentTools.nativeAvailability;
  },
  get codexTools() {
    return agentTools.codexTools;
  },
  get codexSiteBlocks() {
    return agentTools.codexSiteBlocks;
  },
  get codexChromeBackends() {
    return agentTools.codexChromeBackends;
  },
  get siteConsent() {
    return agentTools.siteConsent;
  },
  get acpTools() {
    return agentTools.acpTools;
  },
  get computerUse() {
    return agentTools.computerUse;
  },
  get remoteOwners() {
    return computerAccess.owners;
  },
  get computerAccess() {
    return computerAccess;
  },
  get scheduler() {
    return automations.scheduler;
  },
  get notifier() {
    return notifier;
  },
  get telemetry() {
    return lifecycle.telemetry;
  },
  get updater() {
    return updates.updater;
  },
  get exitGate() {
    return updates.exitGate;
  },
};
/** @typedef {typeof live} Live */

/* What main.cjs passes each electron/app module; the modules import these typedefs as their deps types. */
const commandsDeps = () => ({ shell, isWin });
/** @typedef {ReturnType<typeof commandsDeps>} CommandsDeps */
const { run, winExists, WIN_APP_PATHS, openInWindows } = createCommands(commandsDeps());
const appStateDeps = () => ({ app, isFlagEnabled, claude, live, broadcast: (...a) => appWindows.broadcastAll(...a) });
/** @typedef {ReturnType<typeof appStateDeps>} AppStateDeps */
const appState = createAppState({ ...appStateDeps(), dialog });
const { STATE_FILE, readState, writeState, uiPrefs, preferHighestCli } = appState;
const codexServerDeps = () => ({ app, APP_NAME, isWin, shellEnv, readState, preferHighestCli, live });
/** @typedef {ReturnType<typeof codexServerDeps>} CodexServerDeps */
const { server, codexBinary, findCodexBinary, codexBinaries, clientInfo } = createCodexServer(codexServerDeps());
const zoom = createZoom({ prefs: () => readState().prefs });
const windowsDeps = () => ({ BrowserWindow, webContents, shell, nativeTheme, screen, APP_NAME, isDev, isWin, windowReadiness, live, zoom });
/** @typedef {ReturnType<typeof windowsDeps>} WindowsDeps */
const appWindows = createWindows(windowsDeps());
const { windows, broadcastAll, broadcastExcept, viewedBy, createWindow, showMainWindow, commandMainWindow, readyMainWindow, toggleMini } =
  appWindows;
const menusDeps = () => ({ Menu, Tray, nativeImage, globalShortcut, shell, BrowserWindow, APP_NAME, isDev, isWin, win: appWindows, live });
/** @typedef {ReturnType<typeof menusDeps>} MenusDeps */
const menus = createMenus({ ...menusDeps(), notice: (n) => notifier?.notice(n), t: live.language.t });
const { buildMenu, setTray, setVoiceHotkey, setMiniShortcut } = menus;

// a thread's own model provider for an API-key account with its own endpoint (electron/identity/contract/codexProvider.cjs)
// agents, shells and ptys start through native/disclaim: they don't inherit MoPilot's TCC grants (electron/platform/disclaim.cjs)
require('./platform/disclaim.cjs').configure({
  launcher: require('./platform/disclaim.cjs').disclaimPath({ packaged: app.isPackaged }),
  dir: () => path.join(app.getPath('userData'), 'bin'),
});
const codexProviders = new CodexProviders({ command: authCommandPath({ packaged: app.isPackaged }) });
/** Something capabilities read has changed: windows ask again. */
const capsChanged = () => broadcastAll('session:capsChanged');
/** The branch and remotes of the repository a folder is in, or null. */
const { gitInfo, gitStatus } = createGitQueries({ run });
/** System notifications (electron/platform/notify.cjs), once registered. */
/** @type {ReturnType<typeof registerNotify> | null} */
let notifier = null;
// Settings → General → Notifications, as the renderer last saved it; read by every notification.
let notifyMode = 'unfocused';
let notifyKinds = {};
// IPC whose errors come back as values, so the window sees the original message (preload's call() rethrows it).
// Module scope: registerIpc passes it to the IPC modules (electron/app/ipc) that use it.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { value: await fn(...args) };
    } catch (err) {
      return { error: { message: String(err?.message ?? err), code: err?.code ?? null } };
    }
  });
}

const chatSessionsDeps = () => ({
  app,
  claude,
  pty,
  shellEnv,
  server,
  clientInfo,
  codexProviders,
  readState,
  uiPrefs,
  preferHighestCli,
  isFlagEnabled,
  gitInfo,
  gitStatus,
  capsChanged,
  appWindows,
  live,
});
/** @typedef {ReturnType<typeof chatSessionsDeps>} ChatSessionsDeps */
const chatSessions = createChatSessions(chatSessionsDeps());
const browserToolsDeps = () => ({
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
  chatProject: chatSessions.chatProject,
  appWindows,
  live,
});
/** @typedef {ReturnType<typeof browserToolsDeps>} BrowserToolsDeps */
const browserTools = createBrowserTools(browserToolsDeps());
const { panelStorage, panelSessions, setupDownloads, chromeState } = browserTools;
const agentToolsDeps = () => ({
  app,
  ipcMain,
  BrowserWindow,
  screen,
  globalShortcut,
  clipboard,
  shell,
  claude,
  shellEnv,
  server,
  handle,
  API_BASE,
  uiPrefs,
  isFlagEnabled,
  setControlling: menus.setControlling,
  appWindows,
  live,
});
/** @typedef {ReturnType<typeof agentToolsDeps>} AgentToolsDeps */
const agentTools = createAgentTools(agentToolsDeps());
const computerAccess = createComputerAccess({ live, app, safeStorage, isFlagEnabled, prefs: uiPrefs, broadcastAll });
const automationsDeps = () => ({
  ipcMain,
  claude,
  shellEnv,
  gitPlatform,
  readState,
  uiPrefs,
  isFlagEnabled,
  appWindows,
  broadcastAll,
  chatProject: chatSessions.chatProject,
  powerMonitor,
  hostApi: { dialog, shell, powerSaveBlocker, app },
  run,
  winPaths: WIN_APP_PATHS,
  version: app.getVersion(),
  live,
  openChat: (chatId, page) => (page ? commandMainWindow(page) : chatId ? commandMainWindow('open-chat', chatId) : showMainWindow()),
});
/** @typedef {ReturnType<typeof automationsDeps>} AutomationsDeps */
const automations = createAutomations(automationsDeps());
const updatesDeps = () => ({ app, ipcMain, dialog, claude, readState, win: appWindows, broadcastAll, live, windowReadiness });
/** @typedef {ReturnType<typeof updatesDeps>} UpdatesDeps */
const updates = createUpdates(updatesDeps());
const lifecycleDeps = () => ({
  app,
  protocol,
  session,
  net,
  globalShortcut,
  isWin,
  claude,
  pty,
  server,
  readState,
  appWindows,
  menus,
  chatSessions,
  live,
});
/** @typedef {ReturnType<typeof lifecycleDeps>} LifecycleDeps */
const lifecycle = createLifecycle(lifecycleDeps());
const { reportMigrationOnce } = lifecycle;
const identityDeps = () => ({
  app,
  shell,
  claude,
  server,
  codexBinary,
  clientInfo,
  codexProviders,
  readState,
  STATE_FILE,
  patchPrefs,
  patchPrefsSync,
  capsChanged,
  reportMigrationOnce,
  updates,
  appWindows,
  live,
});
/** @typedef {ReturnType<typeof identityDeps>} IdentityDeps */
const signIns = createIdentity(identityDeps());
const flagsDeps = () => ({ app, ipcMain, broadcastAll, capsChanged, chromeState, live });
/** @typedef {ReturnType<typeof flagsDeps>} FlagsDeps */

/*
 * What registerIpc passes every electron/app/ipc module (electron/app/ipc/modules.cjs): one shared set, so a new IPC module
 * takes what it needs from it without a line here. The modules import IpcDeps as their deps type.
 */
const ipcDeps = () => ({
  // Electron
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  nativeTheme,
  net,
  shell,
  systemPreferences,
  webContents,
  isWin,
  // ui-state and the chat store
  readState,
  writeState,
  STATE_FILE,
  patchPrefs,
  registerChats,
  readJson,
  writeAtomic,
  retryMigration,
  migrationReport,
  restoreMigration,
  reportMigrationOnce,
  // windows, menus and the tray
  windows,
  zoom,
  windowReadiness,
  createWindow,
  readyMainWindow,
  execWindows: appWindows.execWindows,
  viewedBy,
  broadcastAll,
  broadcastExcept,
  buildMenu,
  toggleMini,
  setTray,
  setMiniShortcut,
  setVoiceHotkey,
  // commands, files and git
  run,
  winExists,
  WIN_APP_PATHS,
  openInWindows,
  spawnArgs,
  gitInfo,
  gitStatus,
  parseLsFilesZ,
  // harnesses and chat sessions
  claude,
  server,
  shellEnv,
  findCodexBinary,
  codexBinaries,
  handle,
  watchRollout: chatSessions.watchRollout,
  unwatchRollout: chatSessions.unwatchRollout,
  peerWindowChats: chatSessions.peerWindowChats,
  persistHeldGoal: chatSessions.persistHeldGoal,
  temporarySegment: chatSessions.temporarySegment,
  restoreGoal,
  quickRequests,
  announceRunChat: automations.announceRunChat,
  // accounts, dictation and updates
  API_BASE,
  createDictation,
  configureUpdates: updates.configureUpdates,
  // the browser pane
  isFlagEnabled,
  panelStorage,
  panelSessions,
  setupDownloads,
  chromeState,
  registerAnnotateCapture,
  chromeHandoff,
  cancelChromeHandoff,
  usedClaudeInChrome,
  chromeHandoffRoute: browserTools.chromeHandoffRoute,
  live,
});
/** @typedef {ReturnType<typeof ipcDeps>} IpcDeps */
function registerIpc() {
  notifyMode = readState()?.prefs?.notifyOnComplete ?? notifyMode;
  notifyKinds = readState()?.prefs?.notifyKinds ?? notifyKinds;
  pty.register(ipcMain);
  gitPlatform.register(ipcMain);
  search.register(ipcMain);
  claude.register(ipcMain, (channel, payload) => appWindows.emitToWindows(channel, payload), {
    onEvent: (evt) => {
      live.controller.onClaudeEvent(evt);
      live.claudeTurns?.observe(evt);
      if (evt.kind === 'transcript') claude.turnApi.findTranscript(evt.key.slice(7)).then((f) => chatSessions.reconcileClaude(evt.key, f));
    },
    onControl: (key, method) => live.controller.onClaudeControl(key, method),
    onPermission: (id) => live.controller.resolveApproval(id),
    onWatch: (key, file) => chatSessions.reconcileClaude(key, file),
    onUnwatch: (key) => chatSessions.forgetClaude(key),
    pages: () => appWindows.claudePages,
  });
  automations.registerScheduler();
  fsPlatform.register(ipcMain);
  acp.register(ipcMain, live.acpHost, {
    broadcast: (channel, payload) => appWindows.emitToWindows(channel, payload),
    onPermission: (requestId) => live.controller.resolveApproval(requestId),
    routes: live,
    diffs: (key, turnIds) => live.controller.turnSnapshots?.savedOf(key, turnIds) ?? {},
    items: appWindows.acpItems,
  });
  registerProjects(
    ipcMain,
    new ProjectsStore(path.join(app.getPath('userData'), 'projects.json'), (snap) => broadcastAll('projects:changed', snap)),
    {
      // null: Codex isn't installed, which is not a failure and records nothing
      listCodexProjects: async () => {
        const bin = await findCodexBinary();
        if (!path.isAbsolute(bin) || !fs.existsSync(bin)) return null;
        return listCodexProjects(new AppServer({ findBin: () => bin, env: () => shellEnv.childEnv() }), {
          clientInfo: clientInfo('sage_codex_import'),
        });
      },
    },
  );
  // a chat is known by its record, or (a new Claude Code or ACP chat, before anything is saved for it) by its adapter's session
  quickState = new QuickChatState(
    path.join(app.getPath('userData'), 'quick-chat.json'),
    knownChat(
      (id) => live.chats.get(id),
      (id) => live.claudeTurns.sessions.has(id),
      (id) => live.acpTurns.sessions.has(id) || live.acpHost.chats.has(id),
    ),
  );
  // every electron/app/ipc module, in file-name order (after quickState, which Quick Chat reads)
  registerIpcModules(ipcMain, ipcDeps());
  for (const service of [live.mopilot, live.telemetry]) service.register(ipcMain);
  notifier = registerNotify(ipcMain, {
    Notification,
    getMode: () => notifyMode,
    getKinds: () => notifyKinds,
    getQuietHours: () => readState()?.prefs?.notifyQuietHours ?? null,
    quietFile: path.join(app.getPath('userData'), 'notify-quiet.json'),
    powerMonitor,
    isFocused: () => !!BrowserWindow.getFocusedWindow(),
    isLinkedChild: linkedChildOf(live),
    // the chat opens even when no window was open (the window opened for it gets the command); MoMo's notices open MoMo
    onClick: (chatId) => live.momo?.notices.click(chatId) || openNotified(computerAccess.owners, commandMainWindow, chatId),
  });
}

lifecycle.prepareApp();
lifecycle.singleInstance();
lifecycle.migrateCookies();
lifecycle.startTelemetry();
const startupDeps = () => ({
  app,
  ipcMain,
  lifecycle,
  browserTools,
  shellEnv,
  signIns,
  agentTools,
  updates,
  appState,
  chatSessions,
  registerIpc,
  openFlags: () => openFlags(flagsDeps()),
  menus,
  readState,
  buildMenu,
  createWindow,
  automations,
  live,
  safeStorage,
  fsPromises: fs.promises,
  broadcastAll,
  chromeState,
  reportMigrationOnce,
  setMiniShortcut,
  setVoiceHotkey,
  setTray,
  setupDownloads,
  showMainWindow,
});
/** @typedef {ReturnType<typeof startupDeps>} StartupDeps */
startApp(startupDeps());
lifecycle.handleQuit();
