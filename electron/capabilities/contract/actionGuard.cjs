// Whether a tool call may still act on the user's Mac or Chrome. It may while its abort signal (Stop, a harness
// cancel, the harness quitting) has not fired, its chat's control epoch (turn end, Esc) has not moved since it
// began, and its `(chat, turn)` token (./turnTokens.cjs) is still current.
// The Registry runs every handler inside a guard; the computer-use helper and Your Chrome refuse a request from
// a call whose guard is dead, and the desktop and app locks check it before they are taken.
const { AsyncLocalStorage } = require('node:async_hooks');

/** @typedef {import('./turnTokens.cjs').TurnToken} TurnToken */
/** @typedef {{ signal: AbortSignal | null, live: () => boolean, aborted: () => boolean, onRefusal: ((code: string, message: string) => void) | null, onNoGo: ((refusal: any) => void) | null, token: TurnToken | null, tokenLive: (() => boolean) | null }} ActionGuard */
/** @typedef {{ signal?: AbortSignal | null, epoch?: (() => number) | null, onRefusal?: ((code: string, message: string) => void) | null, onNoGo?: ((refusal: any) => void) | null, token?: TurnToken | null, current?: ((token: TurnToken) => boolean) | null }} GuardOptions */

/** @type {AsyncLocalStorage<ActionGuard>} */
const store = new AsyncLocalStorage();

/**
 * A guard for the call about to run. Nested in another guard (the Registry's), it also dies with that one and
 * carries its token. epoch: the chat's control epoch now; token: the call's `(chat, turn)` token, live while
 * `current(token)` holds.
 * @param {GuardOptions} [o]
 * @returns {ActionGuard}
 */
function actionGuard({ signal = null, epoch = null, onRefusal = null, onNoGo = null, token = null, current = null } = {}) {
  const outer = store.getStore();
  const start = epoch ? epoch() : 0;
  const tokenLive = token && current ? () => current(token) : (outer?.tokenLive ?? null);
  return {
    signal: signal ?? outer?.signal ?? null,
    onRefusal: onRefusal ?? outer?.onRefusal ?? null,
    onNoGo: onNoGo ?? outer?.onNoGo ?? null,
    token: token ?? outer?.token ?? null,
    tokenLive,
    live: () => !signal?.aborted && (!epoch || epoch() === start) && (!tokenLive || tokenLive()) && (!outer || outer.live()),
    aborted: () => !!signal?.aborted || !!outer?.aborted(),
  };
}

/**
 * Runs `fn` as a call that may act only while its guard lives.
 * @template T
 * @param {GuardOptions} o
 * @param {() => T} fn
 * @returns {T}
 */
function guarded(o, fn) {
  return store.run(actionGuard(o), fn);
}

/**
 * Runs `fn` outside any call: what it sets up (the helper's socket, a listener) never inherits a call's guard.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function unguarded(fn) {
  return store.exit(fn);
}

/** Whether the running call may still act; true outside any call (setup, Settings, turn-end cleanup). */
function mayAct() {
  const g = store.getStore();
  return !g || g.live();
}

/** The running call's `(chat, turn)` token, which its executor checks; null outside a call or for one without a turn. */
function currentToken() {
  return store.getStore()?.token ?? null;
}

/**
 * Whether the running call's token is still current, read later: a lock records it when it is granted, and a lock
 * whose turn ended or was stopped is free again. Null outside a call or for one without a turn (never goes stale).
 * @returns {(() => boolean) | null}
 */
function tokenLiveness() {
  return store.getStore()?.tokenLive ?? null;
}

/**
 * Whether the running call may act, read later: an action queued now checks it when its turn in the queue comes
 * (true outside any call).
 * @returns {() => boolean}
 */
function liveness() {
  const g = store.getStore();
  return g ? g.live : () => true;
}

/**
 * Preserve a known refusal before pausing its turn aborts every call in that turn: the call answers with it, not with
 * the abort's reason. Only an abort that came first (Stop, the harness's cancel) keeps its own reason; a call whose
 * turn ended late (its epoch moved, its token was retired) while it was in its checks still says why it was refused,
 * as the chat was paused and the user told for exactly that.
 */
function recordRefusal(code, message) {
  const g = store.getStore();
  if (g && !g.aborted()) g.onRefusal?.(code, message);
}

/**
 * The running call refused an app computer use never controls (MoPilot itself, the built-in list, the user's
 * blocked apps): the chat says so in its transcript (./controlRefusals.cjs), on every harness. Nothing outside a call.
 * @param {import('./controlRefusals.cjs').Refusal} refusal
 */
function noteNoGo(refusal) {
  store.getStore()?.onNoGo?.(refusal);
}

/** The running call's abort signal, to end a wait early; null outside a call. */
function stopSignal() {
  return store.getStore()?.signal ?? null;
}

/**
 * What a call that may no longer act is told.
 * @param {string} what the side effect it was about to have
 * @param {string} [code] the registry error code (the app-scoped tools call a stop a refusal)
 */
function stopped(what, code = 'stopped') {
  // required here: the registry runs every handler inside a guard, so it requires this module
  const { ToolError } = require('./registry.cjs');
  return new ToolError(`Stopped by the user before ${what}`, code);
}

/** What a call is told once the app quits or computer use is switched off: nothing takes the Mac again. */
function shuttingDown() {
  const { ToolError } = require('./registry.cjs');
  return new ToolError('Computer use is shutting down (MoPilot is quitting, or computer use was switched off)', 'unavailable');
}

/**
 * Throws when the running call may no longer act.
 * @param {string} what the side effect it is about to have
 * @param {string} [code]
 */
function checkAct(what, code) {
  if (!mayAct()) throw stopped(what, code);
}

/**
 * Waits `ms`, or less when the running call is stopped meanwhile.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function pause(ms) {
  const signal = stopSignal();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

module.exports = {
  actionGuard,
  guarded,
  unguarded,
  mayAct,
  currentToken,
  tokenLiveness,
  liveness,
  stopSignal,
  stopped,
  shuttingDown,
  checkAct,
  pause,
  recordRefusal,
  noteNoGo,
};
