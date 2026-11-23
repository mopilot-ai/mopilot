// The browser host's limits and timings, waits with timeouts, and its URL, file name and image helpers.
const { AsyncLocalStorage } = require('node:async_hooks');
const { ToolError } = require('../contract/registry.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { isSecretParam, mayNameSecret } = require('../../../shared/urlSecrets.mjs');

const MAX_TABS = 8;
const BUFFER_MAX = 500;
const ATTACH_MS = 15_000;
const LOAD_MS = 20_000;
const ACTION_MS = 60_000;
const CLOSE_MS = 2_000;
const TURN_END_MS = 5_000;
const SHOW_MS = 2_000;
const CAPTURE_MS = 5_000;
const FRAME_MS = 1_000;
const ORPHANS_MAX = 16;
const LAYERS = new Set(['front', 'back', 'none']);
/** The pane's backdrop behind a page (.browser-view): what a page with no background of its own shows on. */
const PAGE_BACKDROP = { color: { r: 255, g: 255, b: 255, a: 1 } };
/** Resolves after the page's next two animation frames (its first painted frame). */
const FRAME_SCRIPT = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';
/** Whether the page's root or body background is opaque black. */
const BLACK_PAGE_SCRIPT =
  '[document.documentElement, document.body].some((e) => !!e && /^rgba?\\(0, 0, 0(, 1)?\\)$/.test(getComputedStyle(e).backgroundColor))';
const MARKS = new Set(['deliverable', 'handoff']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const withTimeout = (p, ms, onTimeout) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (e) {
        reject(e);
      }
    }, ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/** The tab action (BrowserTabs.run) the running code belongs to, followed across its awaits; none outside one. */
const actionRuns = new AsyncLocalStorage();
const tooLong = () => new ToolError('The browser action took too long.', 'timeout');

/**
 * Runs `fn` as a tab action bounded by `ms`. When the time is up the caller is rejected and the tab's queue moves
 * on, so the action is over: whatever `fn` still sends to the page after that throws (assertActionLive) instead
 * of running outside the queue, beside the next action. Time spent waiting for the user (waitingForUser) is not
 * counted: the clock stops while a card is open and starts over when it is answered.
 */
const runAction = (fn, ms) =>
  new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const run = {
      over: false,
      waiting: 0,
      pause() {
        if (run.waiting++ === 0) clearTimeout(timer);
      },
      resume() {
        if (--run.waiting === 0 && !run.over) arm();
      },
    };
    const arm = () => {
      timer = setTimeout(() => {
        run.over = true;
        reject(tooLong());
      }, ms);
      timer.unref?.();
    };
    arm();
    actionRuns
      .run(run, () => Promise.resolve().then(fn))
      .then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });

/** Throws when the running code belongs to a tab action that already timed out: the queue has moved on without it. */
const assertActionLive = () => {
  if (actionRuns.getStore()?.over) throw tooLong();
};

/** Whether the running code is a tab action's (inside BrowserTabs.run). */
const inAction = () => !!actionRuns.getStore();

/**
 * Waits for `p` (the user's answer on a card) without spending the running tab action's time; throws when the
 * action timed out meanwhile anyway.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
const waitingForUser = async (p) => {
  const run = actionRuns.getStore();
  if (!run) return p;
  run.pause();
  try {
    return await p;
  } finally {
    run.resume();
    assertActionLive();
  }
};

const waitEvent = (wc, events, ms) =>
  new Promise((resolve) => {
    const listeners = new Map();
    const done = (name) => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) wc.removeListener(event, listener);
      resolve(name);
    };
    const timer = setTimeout(() => done('timeout'), ms);
    timer.unref?.();
    for (const event of events) {
      const listener = () => done(event);
      listeners.set(event, listener);
      wc.once(event, listener);
    }
  });

const stale = (ref) =>
  new ToolError(
    `${ref} is stale or not found on the current page. Re-read the page (browser_read_page or browser_find) to get fresh references, then repeat this action: it was not performed.`,
    'stale_ref',
  );
const oneLine = (s, n = 200) => {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ')
    .trim();
  return t.length > n ? `${prefixUnits(t, n - 1)}…` : t;
};

/** Whether a captured image has nothing on it: empty, or every pixel black (or fully transparent). */
function isBlank(img) {
  if (!img || img.isEmpty()) return true;
  const bm = img.toBitmap();
  for (let i = 0; i + 2 < bm.length; i += 4) if (bm[i] > 8 || bm[i + 1] > 8 || bm[i + 2] > 8) return false;
  return true;
}

/**
 * Query values that look like credentials are hidden where the model reads an address (network listings, history):
 * the hand-off's rule (shared/urlSecrets.mjs isSecretParam), and more widely any name with a word that names a
 * credential on some site whatever its value (?state=CA, ?pin=94107: mayNameSecret) or that merely contains a
 * credential word. Stricter than the hand-off on purpose: hiding a value here costs nothing, while the hand-off
 * would reopen the wrong page.
 */
function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const [k, v] of [...u.searchParams])
      if (isSecretParam(k, v) || mayNameSecret(k) || /token|key|secret|pass|auth|code|sig|session|credential/i.test(k))
        u.searchParams.set(k, 'REDACTED');
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return String(url);
  }
}

/** A URL from the model: a scheme-less address is https (localhost is http); only http/https/about:blank. */
function normalizeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new ToolError('Give a URL.', 'bad_args');
  if (s === 'about:blank') return s;
  let candidate = s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?|#)/i.test(s)) candidate = `http://${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) candidate = `https://${s}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    throw new ToolError(`Not a valid URL: ${oneLine(s)}`, 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new ToolError(`Only http and https pages can be opened: ${oneLine(s)}`, 'bad_url');
  return u.toString();
}

/** A download's name as one safe file name: separators and NUL become `_`, at most 200 characters. */
function safeFileName(name) {
  return (
    String(name || 'download')
      .replace(/[/\\:\u0000]/g, '_')
      .slice(0, 200) || 'download'
  );
}

/**
 * Records the nested frames a page's password mask could not reach (their fields stay as they are; the rest
 * are masked). `what` names the capture, e.g. 'a screenshot'.
 * @param {{ unreadable?: string[] } | null | undefined} result the page's mask answer
 * @param {string} what
 */
function noteUnreadable(result, what) {
  if (result?.unreadable) noteIgnored(`mask password fields in a nested frame for ${what}`, result.unreadable.join('; '));
}

/**
 * Whether the user can see a pane tab's page now (the agent cursor glides only then): its window is shown and not
 * minimized, and the page is in front of the pane. A parked view (a hidden pane, no window open) has no window.
 * @param {{ isDestroyed: () => boolean, isVisible: () => boolean, isMinimized: () => boolean } | null | undefined} win
 * @param {string | undefined} layer
 */
function seenByUser(win, layer) {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && layer === 'front';
}

module.exports = {
  seenByUser,
  noteUnreadable,
  MAX_TABS,
  BUFFER_MAX,
  ATTACH_MS,
  LOAD_MS,
  ACTION_MS,
  CLOSE_MS,
  TURN_END_MS,
  SHOW_MS,
  CAPTURE_MS,
  FRAME_MS,
  ORPHANS_MAX,
  LAYERS,
  PAGE_BACKDROP,
  FRAME_SCRIPT,
  BLACK_PAGE_SCRIPT,
  MARKS,
  sleep,
  withTimeout,
  runAction,
  assertActionLive,
  inAction,
  waitingForUser,
  waitEvent,
  stale,
  oneLine,
  isBlank,
  redactUrl,
  normalizeUrl,
  safeFileName,
};
