// What Electron's entry runs instead of main when the Rust core did not load (electron/boot.cjs): it reports why, tells a person to reinstall and exits.
// main's services hold the core from the moment they are built (the stream batcher, the transcript writer), so none is
// built here. The report uses the app's own reporter, from its own user data folder and with the user's usage choice.
const path = require('node:path');
const electron = require('electron');
const { createLifecycle } = require('./lifecycle.cjs');
const { peekUiState } = require('../platform/chats.cjs');
const { currentSmokeLaunch } = require('./smokeLaunch.cjs');

/** How long the report may take to leave before the app exits. */
const REPORT_MS = 2000;

/**
 * main's lifecycle with nothing else of main, for its user data folder (`prepareApp`, moved from the old name) and its
 * reporter (`startTelemetry`, with the usage choice read from ui-state.json).
 * @param {{ app: any, protocol: any }} o
 */
function reporterLifecycle({ app, protocol }) {
  const readState = () => peekUiState(path.join(app.getPath('userData'), 'ui-state.json'));
  return createLifecycle(
    /** @type {any} */ ({
      app,
      protocol,
      isWin: process.platform === 'win32',
      // read only for a report's harness versions: none run without the core, so it names none (undefined)
      claude: { version: Function.prototype },
      readState,
      appWindows: {},
      live: {},
    }),
  );
}

/**
 * Stop a process whose core did not load, with `problem`, coreProblem's reason. The report goes first: a machine that
 * always stops here has no other way to say so, and no update reaches it. A person sees the reinstall dialog; a checkout
 * or a smoke launch has the reason in its output and its result, and nobody to dismiss a dialog. It ends in exit 1 however
 * it ends, a quit meanwhile (Cmd+Q, a logout) included; a second launch while it runs leaves quietly, as main's does.
 * @param {string} problem
 * @param {{ app?: any, dialog?: { showErrorBox: (title: string, text: string) => void }, protocol?: any,
 *           telemetry?: { error: (e: { message: string, kind: string }) => void, flush: () => Promise<unknown> } }} [o]
 *   telemetry: a reporter of the caller's, in place of main's (and its user data folder) for a test
 * @returns {Promise<void>} settles once the app was told to exit
 */
function stopWithoutCore(problem, { app = electron.app, dialog = electron.dialog, protocol = electron.protocol, telemetry } = {}) {
  const lifecycle = telemetry ? null : reporterLifecycle({ app, protocol });
  lifecycle?.prepareApp();
  // the user data folder's lock, taken where main takes it (lifecycle.singleInstance, right after prepareApp): a second
  // launch while the first says why exits 0, with no second report or dialog
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return Promise.resolve();
  }
  lifecycle?.startTelemetry();
  const reporter = telemetry ?? /** @type {any} */ (lifecycle).telemetry;
  // a quit while the report leaves still fails the launch; exit doesn't wait, so a logout isn't held
  app.on('will-quit', () => app.exit(1));
  const smokeLaunch = currentSmokeLaunch();
  reporter.error({ message: problem, kind: 'startup' });
  smokeLaunch?.failed(problem);
  return app.whenReady().then(async () => {
    console.error(problem);
    await Promise.race([reporter.flush(), new Promise((resolve) => setTimeout(resolve, REPORT_MS))]);
    if (app.isPackaged && !smokeLaunch)
      dialog.showErrorBox(
        'MoPilot cannot start',
        'Part of MoPilot is missing or damaged. Install it again from https://mopilot.ai/download.',
      );
    app.exit(1);
  });
}

module.exports = { stopWithoutCore, REPORT_MS };
