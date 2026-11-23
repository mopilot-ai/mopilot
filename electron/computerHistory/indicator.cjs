// Computer History's indicator state (#1363): what the menu bar icon and the windows show, set by the recorder and followed by electron/app/menu.cjs, so the icon is up while recording even when the user turned the tray off.

/** @typedef {{ status: import('./recorder.cjs').Status }} IndicatorState */

/** @type {IndicatorState} */
let state = { status: 'off' };
/** @type {Set<(s: IndicatorState) => void>} */
const listeners = new Set();

/** The state now. */
const get = () => state;

/** @param {IndicatorState} next */
function set(next) {
  if (next.status === state.status) return;
  state = { status: next.status };
  for (const fn of listeners) fn(state);
}

/** Calls `fn` on each change; returns the unsubscribe. */
function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether the indicator says something is being recorded (or would be, once a failure clears). */
const recording = (s = state) =>
  s.status === 'recording' || s.status === 'needs-permission' || s.status === 'unavailable' || s.status === 'store-unavailable';

module.exports = { get, set, subscribe, recording };
