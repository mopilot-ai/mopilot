// App updates: the update prefs and channel, the updater, the exit gate Quit and Restart to update go through, and the stealth restart.
const { Updater } = require('../updates/updater.cjs');
const { failureWatcher, recordActivation, reportInstalledVersion, takeActivationFailure } = require('../updates/outcome.cjs');
const { updateChannel } = require('../updates/channel.cjs');
const { installId } = require('../platform/install.cjs');
const { refreshFlags, isEnabled } = require('../platform/flags.cjs');
const { createExitGate, isEmpty, quietBlocked } = require('../platform/exitGate.cjs');
const { anyUnsent } = require('./unsent.cjs');
const pty = require('../platform/pty.cjs');
const { saveRestartView, clearRestartView, takeRestartView } = require('./restartView.cjs');
const { createStealthUpdate } = require('./stealthUpdate.cjs');
const { primaryOf } = require('../session/viewing.cjs');

/**
 * @param {import('../main.cjs').UpdatesDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createUpdates({ app, ipcMain, dialog, claude, readState, win, broadcastAll, live, windowReadiness }) {
  const { mainWindow, viewedBy } = win;
  live.pty = pty;
  /** @type {InstanceType<typeof Updater>} assigned at startup, before any window or IPC handler uses it */
  let updater;
  /** Quit and Restart to update go through it (electron/platform/exitGate.cjs). */
  /** @type {ReturnType<typeof createExitGate>} assigned at startup, before any window or IPC handler uses it */
  let exitGate;
  /* The renderer's update prefs; the channel it asks for is checked against the MoPilot account. */
  let updatePrefs = { auto: true, channel: 'stable' };
  function configureUpdates(opts) {
    if (opts) updatePrefs = opts;
    const before = updater.channel;
    const state = updater.configure({
      auto: updatePrefs.auto,
      channel: updateChannel(updatePrefs.channel, !!live.mopilot?.status().user?.internal),
    });
    // refreshFlags records failures and keeps the flags scoped to the current channel.
    if (updater.channel !== before) void refreshFlags();
    return state;
  }
  /* Restart to update: the chat the main window shows is reopened by the new version (restartView.cjs). The updater
     says "installing" just before it quits, and goes back to "ready" when the restart failed. */
  let viewSaved = false;
  /** @type {ReturnType<typeof createStealthUpdate> | undefined} */
  let stealth;
  function restartView(status) {
    const dir = app.getPath('userData');
    if (status === 'installing') {
      const main = mainWindow();
      const shown = main && !main.isDestroyed() ? main : null;
      // a restart nobody asked for comes back as the window was: shown without focus, minimized, or hidden
      const window = stealth?.installing
        ? { visible: !!shown?.isVisible() && !shown.isMinimized(), minimized: !!shown?.isMinimized() }
        : undefined;
      saveRestartView(dir, shown ? primaryOf(viewedBy.get(shown.webContents.id)) : undefined, Date.now(), window);
      viewSaved = true;
    } else if (viewSaved) {
      viewSaved = false;
      clearRestartView(dir);
      // the restart the gate let through did not happen: the next quit asks again
      exitGate.reopen();
    }
  }
  /** At app ready, once the MoPilot account exists: the exit gate, the updater, and the saved update prefs. */
  function openUpdates() {
    exitGate = createExitGate({
      ipcMain,
      dialog,
      window: () => {
        const win = mainWindow();
        return win && windowReadiness.has(win.webContents.id) ? win : null;
      },
      sessions: () => live.sessions,
      controller: () => live.controller,
      codex: () => live.codex,
      claude: () => claude,
      claudeTurns: () => live.claudeTurns,
      prefs: () => readState().prefs,
      keepsRunning: () => live.keepsRunning ?? null,
    });
    const watchFailures = failureWatcher((failure) => live.telemetry?.track('update_failed', { ...failure, channel: updater.channel }));
    updater = new Updater({
      installId: installId(app.getPath('userData')),
      broadcast: (st) => {
        watchFailures(st);
        restartView(/** @type {{ status?: string }} */ (st).status);
        broadcastAll('updates:state', st);
      },
      gate: (reason) => exitGate.request(reason, { quiet: !!stealth?.installing }),
      idle: async () => isEmpty(await exitGate.collect()),
      token: () => live.mopilot.accessToken(),
      activationAttempt: (version, channel) => recordActivation(app.getPath('userData'), version, channel),
    });
    {
      const p = readState().prefs || {};
      configureUpdates({ auto: p.autoUpdate !== false, channel: p.updateChannel });
    }
    reportInstalledVersion({
      userData: app.getPath('userData'),
      version: app.getVersion(),
      channel: updater.channel,
      track: (name, props) => live.telemetry?.track(name, props),
    });
    const missed = takeActivationFailure(app.getPath('userData'), app.getVersion());
    if (missed) {
      updater.set({ status: 'error', error: `Could not install MoPilot ${missed.version}. Check for updates to try again.` });
      live.telemetry?.track('update_failed', missed);
    }
    stealth = createStealthUpdate({
      enabled: () => isEnabled('app.update.stealth') && updatePrefs.auto !== false,
      // Windows installs by hand (the installer is downloaded in the browser): nothing to restart into
      ready: () => updater.state.status === 'ready' && !updater.manual,
      focused: () => win.anyFocused(),
      fullScreen: () => win.anyFullScreen(),
      // nothing the exit gate counts, no unsent draft, no command in a terminal, no dev server a chat started
      quiet: async () =>
        !quietBlocked(await exitGate.collect(), readState().prefs?.confirmClose) &&
        !anyUnsent() &&
        !pty.busy() &&
        !live.devPreviews?.servers.size,
      install: async () => {
        // an install that did not even start (the update changed meanwhile) leaves the gate as it was
        if (!(await updater.install())) exitGate.reopen();
      },
    });
    app.on('browser-window-focus', () => stealth?.reset());
    app.on('will-quit', () => stealth?.stop());
  }

  return {
    configureUpdates,
    openUpdates,
    /** How the first main window opens: on the chat shown before a restart to update, and as it was then, once. */
    restartLaunch: () => takeRestartView(app.getPath('userData')),
    get updatePrefs() {
      return updatePrefs;
    },
    /** @returns {InstanceType<typeof Updater>} */
    get updater() {
      return updater;
    },
    /** @returns {ReturnType<typeof createExitGate>} */
    get exitGate() {
      return exitGate;
    },
  };
}

module.exports = { createUpdates };
