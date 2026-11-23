// Loads an app window's page (a main window or Quick Chat) and brings it back when it stops working: a renderer that is gone reloads, a hung one offers Wait or Reload, a page that didn't load is tried again, and each problem is kept for diagnostics (#4424).
const { noteIgnored } = require('../ignored.cjs');

/** Reloads after a renderer is gone allowed within RELOAD_WINDOW_MS before the user is asked instead (a crash loop). */
const RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;
/** How long a page that didn't load waits before its one automatic retry. */
const LOAD_RETRY_MS = 1_000;
/** Problems kept for Copy diagnostics and bug reports, whatever the usage-data choice. */
const PROBLEMS_KEPT = 10;
/** How often an app window's renderer memory is read, so a renderer that is gone says how big it was. */
const MEMORY_SAMPLE_MS = 60_000;
/** Chromium's code for a navigation that was cancelled (a newer one replaced it): not a failure. */
const ERR_ABORTED = -3;

const LABELS = { main: 'app window', quick: 'Quick Chat' };

/** @typedef {{ at: number, window: string, problem: string, exitCode?: number, memoryMB?: number }} WindowProblem */
/** @type {WeakSet<object>} the app windows' webContents, whose problems recovery reports itself */
const owned = new WeakSet();
/** @type {WindowProblem[]} the latest problems, oldest first, kept whatever the usage-data choice */
const problems = [];
/** Whether the webContents is an app window's (lifecycle's generic report leaves it to recovery). */
const ownsAppWindow = (/** @type {object} */ wc) => owned.has(wc);
/** The latest app window problems, oldest first, for Copy diagnostics and bug reports. */
const recentWindowProblems = () => problems.map((p) => ({ ...p }));
/** Forgets the problems (tests). */
const clearWindowProblems = () => void problems.splice(0);

/**
 * @param {{ page: string, isDev: boolean, telemetry: () => { error: (e: object) => void } | null | undefined,
 *   quitting: () => boolean, app?: { quit: () => void, getAppMetrics: () => { pid: number, memory?: { workingSetSize?: number } }[] },
 *   dialog?: { showMessageBox: (win: any, o: object) => Promise<{ response: number }> },
 *   now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown,
 *   every?: (fn: () => void, ms: number) => { unref?: () => void } }} deps
 *   page: the built app page (dist/index.html); in development the dev server's page loads instead; app, dialog: Electron's
 */
function createWindowRecovery({
  page,
  isDev,
  telemetry,
  quitting,
  app,
  dialog,
  now = Date.now,
  setTimer = setTimeout,
  every = setInterval,
}) {
  const appOf = () => app ?? require('electron').app;
  const dialogOf = () => dialog ?? require('electron').dialog;
  /** @type {Set<any>} webContents whose memory is sampled */
  const sampled = new Set();
  /** @type {Map<number, number>} webContents id -> its renderer's last working set, in MB */
  const memory = new Map();
  /** @type {{ unref?: () => void } | null} */
  let sampler = null;

  function sample() {
    let metrics;
    try {
      metrics = appOf().getAppMetrics();
    } catch (error) {
      return noteIgnored("read the app windows' memory", error);
    }
    for (const wc of sampled) {
      if (wc.isDestroyed()) continue;
      const pid = wc.getOSProcessId();
      const kb = metrics.find((m) => m.pid === pid)?.memory?.workingSetSize;
      if (kb) memory.set(wc.id, Math.round(kb / 1024));
    }
  }

  /**
   * Keeps the problem on this machine and reports it (with usage data on), its window named.
   * @param {'main' | 'quick'} kind
   * @param {any} wc
   * @param {string} problem
   * @param {number} [exitCode]
   */
  function note(kind, wc, problem, exitCode) {
    const memoryMB = memory.get(wc.id);
    const entry = { at: now(), window: LABELS[kind], problem, ...(exitCode !== undefined && { exitCode }), ...(memoryMB && { memoryMB }) };
    problems.push(entry);
    problems.splice(0, problems.length - PROBLEMS_KEPT);
    // the message stays one group per problem; the memory goes with the details (the fingerprint reads only stack frames)
    const message = `${entry.window} ${problem}${exitCode !== undefined ? ` (${exitCode})` : ''}`;
    telemetry()?.error({
      message,
      stack: memoryMB ? `memory: ${memoryMB} MB` : '',
      process: 'renderer',
      kind: 'window-problem',
      component: kind,
    });
  }

  const unasked = (/** @type {unknown} */ error) => (noteIgnored('ask about a window that stopped working', error), { response: -1 });
  /** Asks on the window; a question that can't be shown answers -1 (neither choice). */
  const ask = (/** @type {any} */ win, /** @type {Electron.MessageBoxOptions} */ o) => {
    try {
      return dialogOf().showMessageBox(win, o).catch(unasked);
    } catch (error) {
      return Promise.resolve(unasked(error));
    }
  };

  /** Loads an app page; a failure reaches the window's did-fail-load, which retries it. */
  const loadPage = (/** @type {any} */ win, /** @type {string} */ hash) =>
    void Promise.resolve(
      isDev ? win.loadURL(process.env.VITE_DEV_SERVER_URL + (hash ? '#' + hash : '')) : win.loadFile(page, hash ? { hash } : undefined),
    ).catch((error) => noteIgnored('load an app window', error));

  /**
   * Watches the window and loads its page.
   * @param {any} win the window
   * @param {'main' | 'quick'} kind
   * @param {string} [hash] the page's hash (#thread=…, #mini), the same on a retry
   */
  function attach(win, kind, hash = '') {
    const wc = win.webContents;
    const load = () => loadPage(win, hash);
    owned.add(wc);
    sampled.add(wc);
    if (!sampler) {
      sampler = every(sample, MEMORY_SAMPLE_MS);
      sampler.unref?.();
    }
    wc.once('destroyed', () => {
      sampled.delete(wc);
      memory.delete(wc.id);
    });
    const live = () => !win.isDestroyed() && !quitting();
    /** @type {number[]} when the renderer was reloaded after it was gone */
    let reloads = [];
    /** @type {AbortController | null} the open "not responding" question */
    let hang = null;
    /** the user chose Reload on a hung window: its renderer is stopped, and comes back without counting as a crash */
    let stopping = false;
    /** the page that didn't load was tried again once; a page that loads starts over */
    let retried = false;
    /** a crash-loop or load question is open: one at a time per window */
    let prompting = false;

    const reload = () => live() && wc.reload();
    /** Asks once at a time; a question already open answers for this one too. */
    const prompt = (/** @type {Electron.MessageBoxOptions} */ o, /** @type {(response: number) => void} */ answered) => {
      if (prompting) return;
      prompting = true;
      void ask(win, o).then(({ response }) => {
        prompting = false;
        answered(response);
      });
    };
    wc.on('did-finish-load', () => {
      retried = false;
    });
    // a page starting over (a reload, stopped or not) ends whatever Reload on a hang was waiting for
    wc.on('did-start-loading', () => {
      stopping = false;
    });

    wc.on('render-process-gone', (/** @type {unknown} */ _e, /** @type {{ reason: string, exitCode: number }} */ d) => {
      hang?.abort();
      hang = null;
      if (d.reason === 'clean-exit' || !live()) return;
      const asked = stopping;
      stopping = false;
      note(kind, wc, asked ? 'reloaded while not responding' : `renderer gone: ${d.reason}`, d.exitCode);
      if (asked) return reload();
      const t = now();
      reloads = reloads.filter((r) => t - r < RELOAD_WINDOW_MS);
      if (reloads.length < RELOADS) {
        reloads.push(t);
        return reload();
      }
      prompt(
        {
          type: 'error',
          message: 'MoPilot’s window stopped working',
          detail: 'It closed unexpectedly several times.',
          buttons: ['Reload', 'Quit'],
          defaultId: 0,
          cancelId: 1,
        },
        (response) => {
          if (response === 0) {
            reloads = [];
            reload();
          } else if (response === 1) appOf().quit();
        },
      );
    });

    wc.on('unresponsive', () => {
      if (hang || !live()) return;
      note(kind, wc, 'not responding');
      const asking = new AbortController();
      hang = asking;
      void ask(win, {
        type: 'warning',
        message: 'MoPilot isn’t responding',
        detail: 'Wait for it, or reload the window.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0,
        signal: asking.signal,
      }).then(({ response }) => {
        // the window responded (or its renderer went) while asking: the question was closed, nothing to do
        if (hang !== asking) return;
        hang = null;
        if (response !== 1 || !live()) return;
        stopping = true;
        wc.forcefullyCrashRenderer();
      });
    });
    wc.on('responsive', () => {
      hang?.abort();
      hang = null;
    });

    wc.on(
      'did-fail-load',
      (
        /** @type {unknown} */ _e,
        /** @type {number} */ code,
        /** @type {string} */ description,
        /** @type {string} */ _url,
        /** @type {boolean} */ mainFrame,
      ) => {
        if (!mainFrame || code === ERR_ABORTED || !live()) return;
        note(kind, wc, `didn't load: ${description || 'unknown error'}`, code);
        if (!retried) {
          retried = true;
          setTimer(() => live() && load(), LOAD_RETRY_MS);
          return;
        }
        prompt(
          {
            type: 'error',
            message: 'MoPilot’s window didn’t open',
            detail: `${description || 'The page didn’t load'}. ${isDev ? 'Check that the dev server is running.' : 'If this keeps happening, install MoPilot again.'}`,
            buttons: ['Try again', 'Quit'],
            defaultId: 0,
            cancelId: 1,
          },
          (response) => {
            if (response === 0 && live()) load();
            else if (response === 1) appOf().quit();
          },
        );
      },
    );
    load();
  }

  return { attach };
}

module.exports = {
  createWindowRecovery,
  ownsAppWindow,
  recentWindowProblems,
  clearWindowProblems,
  RELOADS,
  RELOAD_WINDOW_MS,
  LOAD_RETRY_MS,
  PROBLEMS_KEPT,
  MEMORY_SAMPLE_MS,
};
