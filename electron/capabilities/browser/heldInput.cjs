// Keys and mouse buttons an agent pressed on a tab through CDP and has not released yet, so a hold ends with them up: a stop, a turn end, a failure or a detach lets go of them.
const { noteIgnored } = require('../../ignored.cjs');
const { liveness, stopSignal } = require('../contract/actionGuard.cjs');

/** The longest a single browser action holds keys or buttons down, in ms (under the tab action's own bound). */
const HOLD_MS_MAX = 30_000;

/** @typedef {{ method: string, params: Record<string, any>, sessionId: string }} Release */
/** tab -> what is down on it, in the order it went down: id -> the event that lets it go */
const held = new WeakMap();
/** tab -> where the mouse last was, so a button is let go where it is */
const pointer = new WeakMap();

const keyId = (p) => `key:${p.code || p.key}`;
const buttonId = (p) => `button:${p.button || 'left'}`;

/**
 * Records one CDP command sent to the tab: a key or button going down is held until its own up event goes (any
 * other command is not input and changes nothing).
 * @param {object} tab
 * @param {string} method
 * @param {Record<string, any>} p
 * @param {string} [sessionId]
 */
function noteInput(tab, method, p, sessionId = '') {
  if (method !== 'Input.dispatchKeyEvent' && method !== 'Input.dispatchMouseEvent') return;
  let list = held.get(tab);
  if (!list) held.set(tab, (list = new Map()));
  if (method === 'Input.dispatchKeyEvent') {
    if (p.type === 'keyUp') list.delete(keyId(p));
    else if (p.type === 'keyDown' || p.type === 'rawKeyDown') {
      const { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode } = p;
      list.set(keyId(p), {
        method,
        params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode, modifiers: 0 },
        sessionId,
      });
    }
  } else {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) pointer.set(tab, { x: p.x, y: p.y });
    if (p.type === 'mouseReleased') list.delete(buttonId(p));
    else if (p.type === 'mousePressed')
      list.set(buttonId(p), {
        method,
        params: { type: 'mouseReleased', button: p.button || 'left', buttons: 0, clickCount: p.clickCount ?? 1 },
        sessionId,
      });
  }
}

/** Whether a key or mouse button is still down on the tab. */
function isHolding(tab) {
  return (held.get(tab)?.size ?? 0) > 0;
}

/**
 * Lets go of everything still down on the tab, last pressed first, through `send(method, params, sessionId)`. The
 * events go out in order without waiting for each answer (a turn end detaches CDP right after), then the answers
 * are awaited. Best effort: a page that went away has nothing held any more.
 * @param {object} tab
 * @param {(method: string, params: Record<string, any>, sessionId?: string) => Promise<unknown> | unknown} send
 */
async function releaseHeld(tab, send) {
  const list = held.get(tab);
  if (!list?.size) return;
  const releases = [...list.values()].reverse();
  list.clear();
  const at = pointer.get(tab) ?? { x: 0, y: 0 };
  const sent = releases.map((r) => {
    const params = r.method === 'Input.dispatchMouseEvent' ? { ...r.params, ...at } : r.params;
    try {
      return Promise.resolve(r.sessionId ? send(r.method, params, r.sessionId) : send(r.method, params));
    } catch (error) {
      return Promise.reject(error);
    }
  });
  for (const r of await Promise.allSettled(sent))
    if (r.status === 'rejected') noteIgnored('let go of a key or mouse button held on a browser tab', r.reason);
}

/**
 * Lets go now of what is down on the tab, through its debugger, waiting at most `ms` (a page a dialog blocks may not
 * answer). The turn end calls it before the turn's commands stop: a Chrome tab's relay refuses them after (#1632).
 * @param {any} tab @param {number} [ms]
 */
async function releaseNow(tab, ms = 400) {
  const dbg = tab.backend.isDestroyed() ? null : tab.backend.debugger;
  if (!dbg || !isHolding(tab) || !dbg.isAttached()) return;
  /** @type {any} */
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  await Promise.race([releaseHeld(tab, (...command) => dbg.sendCommand(...command)), late]);
  clearTimeout(timer);
}

/** Forgets what is down on the tab without sending anything: its page can't be reached any more. */
function forgetHeld(tab) {
  held.delete(tab);
}

/**
 * Waits `ms` while keys or buttons are held, ending early when the call is stopped or its turn ends
 * (../contract/actionGuard.cjs), or `cut` aborts. Resolves true when the whole time passed, false when it was cut short.
 * @param {number} ms
 * @param {AbortSignal | null} [cut]
 */
function holdFor(ms, cut = null) {
  const live = liveness();
  const signals = [stopSignal(), cut].filter((s) => s !== null);
  return new Promise((resolve) => {
    if (!live() || signals.some((s) => s.aborted)) return resolve(false);
    const end = Date.now() + ms;
    /** @type {ReturnType<typeof setTimeout>} */
    let t;
    const done = (full) => {
      clearTimeout(t);
      for (const s of signals) s.removeEventListener('abort', stop);
      resolve(full);
    };
    const stop = () => done(false);
    // the turn token and the control epoch have no event: they are looked at every 100 ms
    const tick = () => {
      if (!live()) return done(false);
      const left = end - Date.now();
      if (left <= 0) return done(true);
      t = setTimeout(tick, Math.min(100, left));
    };
    for (const s of signals) s.addEventListener('abort', stop, { once: true });
    tick();
  });
}

/**
 * A hold length in ms from a number of seconds (the browser_computer `duration`) or ms (a script's `delay`):
 * 0 when absent, and at most HOLD_MS_MAX.
 * @param {unknown} value
 * @param {number} unit ms per unit (1000 for seconds)
 */
function holdMs(value, unit) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(HOLD_MS_MAX, Math.round(n * unit));
}

module.exports = { HOLD_MS_MAX, noteInput, isHolding, releaseHeld, releaseNow, forgetHeld, holdFor, holdMs };
