// A release's smoke launch of the packaged app (MOPILOT_SMOKE_RESULT=<file>, scripts/smoke-launch.mjs): writes how startup ended, then quits.
const { writeAtomic } = require('../platform/fsutil.cjs');

/** @typedef {{ started: () => void, failed: (message: string) => void, rendererReady: () => void, memoryGuard: (problem: string | null) => void }} SmokeReporter */
/** @type {SmokeReporter | null} the process's reporter, read by startup (electron/app/startup.cjs) */
let installed = null;

/**
 * Off unless MOPILOT_SMOKE_RESULT names a file. Installed by Electron's entry point before main (electron/boot.cjs), so a module the packaged app
 * lacks ("Cannot find module") is reported instead of Electron's blocking error dialog. The launch passes once main's
 * startup has finished, the window's renderer has asked for app:ready (its script ran) and the browser memory guard's
 * worker has loaded the core (it has no fallback, and only a shipped app shows its worker can reach the core from
 * app.asar), with the version the app reports (scripts/smoke-launch.mjs checks it is the release's); it fails on the first
 * uncaught exception, startup failure, renderer crash, failed page load or a guard that can't stop pages.
 * @param {{ app: Pick<Electron.App, 'on' | 'exit' | 'getVersion'>, env?: Record<string, string | undefined>, write?: (file: string, text: string) => void, proc?: Pick<NodeJS.Process, 'on'> }} deps
 * @returns {SmokeReporter | null}
 */
function installSmokeLaunch({ app, env = process.env, write = writeAtomic, proc = process }) {
  const file = env.MOPILOT_SMOKE_RESULT;
  installed = null;
  if (!file) return null;
  let done = false;
  let started = false;
  let rendererReady = false;
  let guardReady = false;
  /** @param {{ ok: true, version: string } | { ok: false, error: string }} result */
  const report = (result) => {
    if (done) return;
    done = true;
    try {
      write(file, `${JSON.stringify(result)}\n`);
    } finally {
      app.exit(result.ok ? 0 : 1);
    }
  };
  const fail = (/** @type {string} */ error) => report({ ok: false, error });
  const passIfReady = () => {
    if (started && rendererReady && guardReady) report({ ok: true, version: app.getVersion() });
  };
  proc.on('uncaughtException', (error) => fail(`uncaught exception: ${error?.stack ?? String(error)}`));
  app.on('render-process-gone', (_e, _wc, details) => fail(`renderer gone: ${details.reason} (${details.exitCode})`));
  app.on('web-contents-created', (_e, contents) => {
    contents.on('did-fail-load', (_ev, code, description, url, isMainFrame) => {
      if (isMainFrame && url.startsWith('file:')) fail(`page failed to load: ${url} (${code} ${description})`);
    });
  });
  installed = {
    /** main's startup finished (electron/app/startup.cjs) */
    started() {
      started = true;
      passIfReady();
    },
    /** main's startup failed, with why */
    failed(/** @type {string} */ message) {
      fail(`startup failed: ${message}`);
    },
    rendererReady() {
      rendererReady = true;
      passIfReady();
    },
    /** the browser memory guard's worker reported: null when it can stop pages, else why it can't */
    memoryGuard(/** @type {string | null} */ problem) {
      if (problem) return fail(`browser memory guard: ${problem}`);
      guardReady = true;
      passIfReady();
    },
  };
  return installed;
}

/** The reporter installed in this process, or null when this is no smoke launch. */
const currentSmokeLaunch = () => installed;

module.exports = { installSmokeLaunch, currentSmokeLaunch };
