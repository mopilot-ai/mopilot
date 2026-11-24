// Opens the app window before slow setup, and admits renderer boot only once main's services are ready.
const { messageOf, noteIgnored } = require('../ignored.cjs');
const { currentSmokeLaunch } = require('./smokeLaunch.cjs');
const { startStallLogger } = require('../perf/stalls.cjs');
const { startRendererLog } = require('../perf/rendererLog.cjs');
const { installUserTurns } = require('../capabilities/browser/userTurn.cjs');
const { openMobileRemote } = require('./mobileRemote.cjs');
const { openRoutines } = require('./routines.cjs');
const { openAlwaysOn, openStartupWindow, startRemote } = require('./alwaysOnWiring.cjs');
const { registerSpeechWindows } = require('../platform/speechWindows.cjs');
const { registerRemoteWindows } = require('../remote/settingsWindows.cjs');
const { markStartup, markModules } = require('../perf/startup.cjs');
const { openGateway } = require('./gatewayWiring.cjs');
const STARTUP_TIMEOUT_MS = 30_000;

/** @param {import('../main.cjs').StartupDeps} deps main's startup services and commands */
function startApp({
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
  openFlags,
  menus,
  readState,
  buildMenu,
  createWindow,
  automations,
  live,
  safeStorage,
  fsPromises,
  broadcastAll,
  chromeState,
  reportMigrationOnce,
  setMiniShortcut,
  setVoiceHotkey,
  setTray,
  setupDownloads,
  showMainWindow,
}) {
  registerSpeechWindows(ipcMain);
  registerRemoteWindows(ipcMain);
  const smokeLaunch = currentSmokeLaunch();
  /** @type {(result: object) => void} */
  let finish;
  const ready = new Promise((resolve) => {
    finish = resolve;
  });
  let closed = false;
  let retired = false;
  const setup = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const fail = (error) => {
    if (retired) return;
    retired = true;
    setup.abort();
    clearTimeout(timer);
    finish({ error: { code: 'startup_failed', message: 'MoPilot could not finish starting.' } });
    live.telemetry.error({ message: messageOf(error), kind: 'startup' });
    // the flush timer starts later than this: a machine that always fails here would otherwise never report it
    void live.telemetry.flush();
    smokeLaunch?.failed(messageOf(error));
  };
  ipcMain.handle('app:ready', () => {
    smokeLaunch?.rendererReady();
    return ready;
  });
  const stop = () => {
    closed = true;
    retired = true;
    setup.abort();
    clearTimeout(timer);
    finish({ error: { code: 'startup_closed', message: 'MoPilot is quitting.' } });
  };
  lifecycle.quitSignal.addEventListener('abort', stop, { once: true });
  if (lifecycle.quitSignal.aborted) stop();
  void app.whenReady().then(async () => {
    if (retired) return;
    // the startup timeline the probe writes (electron/perf/startup.cjs, docs/architecture/rust-core.md §2)
    markStartup('whenReady');
    markModules('whenReady');
    // main runs only with the core: Electron's entry stops a process without one before main loads (electron/boot.cjs)
    try {
      lifecycle.onReady();
      // always on, whatever shared.perf.probe says (electron/perf/stalls.cjs)
      startStallLogger({ dir: app.getPath('userData') });
      startRendererLog({ dir: app.getPath('userData') });
      browserTools.setupGuests();
      markStartup('guestsReady');
      // The lightweight renderer entry waits on app:ready before importing the full app or using its IPC.
      menus.menuKeybindings = readState().prefs?.keybindings || {};
      // after a restart to update, on the chat it showed before (and, after a stealth one, as it was then)
      const launch = updates.restartLaunch();
      // started by the login item for Mobile Remote: the menu-bar item is the app, no window opens
      live.alwaysOn = openAlwaysOn({ app, menus, live, broadcastAll, ignored: noteIgnored });
      const quiet = openStartupWindow(live.alwaysOn, () => createWindow(launch.hash, { restore: launch.window }));
      markStartup('windowCreated');
      app.on('activate', () => {
        if (!closed) void showMainWindow();
      });
      timer = setTimeout(() => fail(new Error('App startup timed out.')), STARTUP_TIMEOUT_MS);
      await shellEnv.ready();
      markStartup('shellEnvReady');
      if (retired) return;
      await signIns.openAccounts(setup.signal);
      markStartup('accountsOpen');
      if (retired) return;
      await agentTools.openTools(setup.signal);
      markStartup('toolsOpen');
      if (retired) return;
      signIns.openMoPilot();
      updates.openUpdates();
      appState.openChats();
      chatSessions.openAcp();
      chatSessions.openSessions();
      registerIpc();
      markStartup('ipcRegistered');
      // linked sessions share the controller's hooks, so they come after the sessions and the peer service
      automations.registerOrchestration(app.getPath('userData'));
      automations.registerChromePanel(app.getPath('userData'));
      // MoMo's services, IPC and tools (refusing while the account isn't invited), once the tool registry and chats are open
      automations.registerMomo(app.getPath('userData'));
      // the MCP gateway (#2999 C2): the servers the user manages there offer their tools to every chat that isn't MoMo's
      live.gateway = openGateway({
        live,
        userData: app.getPath('userData'),
        safeStorage,
        broadcastAll,
        quitSignal: lifecycle.quitSignal,
        prefs: () => readState().prefs ?? {},
        projectOf: (chatId) => chatSessions.chatProject(chatId),
      });
      // action memory (G4): before the browser tools, which register through its recorder
      live.routines = openRoutines({ live, userData: app.getPath('userData'), safeStorage, broadcast: broadcastAll });
      const flags = openFlags();
      // Mobile Remote's sealed channel, running only while remote.enabled is on (electron/remote/runtime.cjs)
      openMobileRemote({ userData: app.getPath('userData'), live, safeStorage, fs: fsPromises });
      // always-on follows the runtime once it settled (and opens the window if a quiet start has no menu-bar item)
      void startRemote({ live, quiet, showMainWindow });
      // Install the tools before any harness session can start.
      agentTools.openComputerUse(flags);
      browserTools.registerBrowserTools().catch(() => broadcastAll('browser:channelChanged', chromeState()));
      // a browser hand-off ends the agent's turn; the user's reply, Done, Stop or a switch ends the hand-off (#1834)
      installUserTurns(live);
      // computer access listens only once the tools, the sessions and computer use it routes through are up
      live.computerAccess.open();
      buildMenu();
      // Codex still starts only when a window connects or a first request needs it.
      automations.start();
      live.acpAdmission.refresh().catch((error) => noteIgnored('probe the basic harnesses at startup', error));
      live.mopilot.refreshStatus();
      live.telemetry.start();
      live.telemetry.track('app_open', { version: app.getVersion() });
      // counts this install whatever the usage-data choice (electron/support/installPing.cjs)
      lifecycle.installPing.start();
      reportMigrationOnce();
      const prefs = readState().prefs || {};
      setMiniShortcut(!!prefs.miniShortcut);
      if (prefs.voiceHotkey) setVoiceHotkey(prefs.voiceHotkey);
      if (prefs.showInMenuBar) setTray(true);
      setupDownloads(prefs.downloadsDir || null, !!prefs.askWhereToSave);
      clearTimeout(timer);
      markStartup('appReady');
      finish({ value: null });
      smokeLaunch?.started();
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = { startApp };
