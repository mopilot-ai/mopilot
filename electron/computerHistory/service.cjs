// Computer History in main (#1363): the store under userData, the recorder fed by the computer-use helper's activity.sample, the screen-lock, sleep and quit events that suspend it, the indicator state the menu bar icon and the windows follow, and the memories and block a window previews before sharing. One per app run (appComputerHistory), started with main's services and working with no window open.
const path = require('node:path');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { HistoryStore } = require('./store.cjs');
const { BUILT_IN_BROWSER, isBrowser } = require('./policy.cjs');
const { Recorder } = require('./recorder.cjs');
const { memoriesOf, digestText, historyBlock } = require('./digest.cjs');
const { appExclusion, NEVER_APPS, HEALTH_DOMAINS } = require('./exclusions.cjs');
const { dayKey, isDayKey, newestDayFirst } = require('./segments.cjs');
const indicator = require('./indicator.cjs');

/** How long a quit may take before a quit that never happened (the user cancelled it) lets recording go on. */
const QUIT_GRACE_MS = 60_000;
const SAMPLE_TIMEOUT_MS = 3000;

/** @typedef {import('./recorder.cjs').RecorderState} RecorderState */

/**
 * The helper's sample, or why there is none. The helper reads a title only for an app the user allowed, and a page
 * address only for an allowed browser, so nothing of any other app reaches main.
 * @param {{ call(method: string, params?: object, o?: { timeoutMs?: number }): Promise<any> } | null | undefined} helper
 * @param {import('./policy.cjs').Settings} settings
 */
async function helperSample(helper, settings) {
  if (!helper) return { error: 'unavailable' };
  const apps = settings.apps.map((a) => a.bundleId).filter((id) => id !== BUILT_IN_BROWSER.bundleId);
  try {
    const s = await helper.call('activity.sample', { apps, browsers: apps.filter(isBrowser) }, { timeoutMs: SAMPLE_TIMEOUT_MS });
    // without Accessibility the helper can read no title and no secure-field state, so nothing is kept
    if (s && typeof s === 'object' && s.trusted === false) return { error: 'needs-permission' };
    return s;
  } catch (error) {
    // the recorder records the cause once, when the failure starts
    return { error: 'unavailable', cause: error };
  }
}

/**
 * @param {object} o
 * @param {string} o.userData
 * @param {import('./store.cjs').SafeStorage | null} o.safeStorage
 * @param {() => any} o.helper the computer-use helper, or null while computer use is not set up
 * @param {() => string[]} [o.userDeny]
 * @param {{ on(event: string, fn: (...args: any[]) => void): unknown, getSystemIdleState?: (threshold: number) => string } | null} [o.powerMonitor]
 * @param {{ on(event: string, fn: (...args: any[]) => void): unknown } | null} [o.app]
 * @param {(state: RecorderState) => void} [o.broadcast] to the windows
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [o.timers]
 * @param {Partial<ConstructorParameters<typeof Recorder>[0]>} [o.recorder] recorder overrides (tests)
 */
function createComputerHistory(o) {
  const timers = o.timers ?? { setTimeout, clearTimeout };
  const userDeny = o.userDeny ?? (() => []);
  const store = new HistoryStore({ dir: path.join(o.userData, 'computer-history'), safeStorage: o.safeStorage });
  const pm = o.powerMonitor ?? null;
  const locked = () => {
    try {
      return pm?.getSystemIdleState?.(1) === 'locked';
    } catch (error) {
      noteIgnored("read whether the screen is locked for Computer History's recorder", error);
      return false;
    }
  };
  const recorder = new Recorder({
    store,
    sample: (settings) => helperSample(o.helper(), settings),
    idleSeconds: async () => {
      // no helper: the sample that follows reports it unavailable
      const h = o.helper();
      return h ? h.idleSeconds() : 0;
    },
    locked,
    userDeny,
    onChange: (state) => {
      indicator.set({ status: state.status });
      o.broadcast?.(state);
    },
    ...o.recorder,
  });
  if (locked()) recorder.suspend('locked');
  /** @type {ReturnType<typeof setTimeout> | null} */
  let quitTimer = null;
  pm?.on('lock-screen', () => recorder.suspend('locked'));
  pm?.on('unlock-screen', () => recorder.wake('locked'));
  pm?.on('suspend', () => recorder.suspend('asleep'));
  pm?.on('resume', () => recorder.wake('asleep'));
  o.app?.on('before-quit', () => {
    // a quit stops recording at once; if the app is still here after the grace, the quit was cancelled
    recorder.suspend('quit');
    if (quitTimer) timers.clearTimeout(quitTimer);
    quitTimer = timers.setTimeout(() => {
      quitTimer = null;
      recorder.wake('quit');
    }, QUIT_GRACE_MS);
  });
  o.app?.on('will-quit', () => {
    if (quitTimer) timers.clearTimeout(quitTimer);
    quitTimer = null;
    recorder.dispose();
  });

  /**
   * The memories of some days for a preview or a share: their lines, the digest text and the block a harness gets.
   * @param {{ days?: unknown, apps?: unknown, sites?: unknown }} [q] days: day keys (default today); apps / sites:
   *   only these bundle ids / sites
   */
  function memories(q = {}) {
    const today = dayKey(Date.now());
    const days = Array.isArray(q.days) ? q.days.filter(isDayKey).slice(0, 31) : [today];
    const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);
    const { entries, unreadable } = recorder.entries(days);
    const m = memoriesOf(entries, { userDeny: userDeny(), apps: strings(q.apps), sites: strings(q.sites) });
    return { memories: m, text: digestText(m), block: historyBlock(m), unreadable };
  }

  /** The days with memories, newest first, and the ones the recorder still holds. */
  function days() {
    const listed = new Set(store.listDays());
    if (recorder.open) listed.add(dayKey(recorder.open.start));
    for (const e of recorder.pending) listed.add(dayKey(e.start));
    return [...listed].sort(newestDayFirst);
  }

  /** Apps the user may pick, with why one can't be picked. */
  function candidates(apps) {
    return (Array.isArray(apps) ? apps : [])
      .filter((a) => a && typeof a.bundleId === 'string' && a.bundleId)
      .map((a) => ({ bundleId: a.bundleId, name: String(a.name || a.bundleId), excluded: appExclusion(a.bundleId, userDeny()) }));
  }

  return {
    store,
    recorder,
    memories,
    days,
    candidates,
    /** The lists Settings shows as never recorded. */
    exclusions: () => ({ apps: NEVER_APPS.map((r) => ({ ...r })), healthSites: [...HEALTH_DOMAINS] }),
    /** Runs `fn` on the recorder and answers with the state, or the failure as `{ ok: false, error }`. */
    act(fn) {
      try {
        const r = fn(recorder) ?? { ok: true };
        return r.ok === false ? { ...r, state: recorder.state } : { ok: true, ...r, state: recorder.state };
      } catch (error) {
        return { ok: false, error: messageOf(error), state: recorder.state };
      }
    },
  };
}

/** @type {ReturnType<typeof createComputerHistory> | null} */
let current = null;
/** The app run's Computer History, or null before main started it. */
const appComputerHistory = () => current;
/** Starts the app run's Computer History once (electron/app/ipc/computerHistory.cjs). */
function startComputerHistory(o) {
  current ??= createComputerHistory(o);
  return current;
}

module.exports = { createComputerHistory, startComputerHistory, appComputerHistory, helperSample, QUIT_GRACE_MS };
