// The one place MoMo's home API (shared/momoHomeApi.mjs `createHomeApi`) is held for main: whoever composes the home (the Mac's machine list over the Host's answers, or the scripted fake in a dev run) sets it, the windows' IPC reads it, and changes it announces reach every window.
/** @typedef {{ view: () => Promise<unknown>, intent: (raw: unknown) => Promise<unknown>, hostCall?: (method: string, params: object) => Promise<unknown>, onChanged: (fn: (payload: unknown) => void) => () => void }} HomeApi */

/** @type {HomeApi | null} */
let current = null;
/** @type {(() => void) | null} */
let stop = null;
/** @type {Set<(payload: unknown) => void>} */
const listeners = new Set();

/** Installs the home API (null: none) and follows its changes; the previous one is let go of. @param {HomeApi | null} api */
function setHomeApi(api) {
  stop?.();
  stop = null;
  current = api;
  if (api) {
    stop = api.onChanged((payload) => {
      for (const fn of listeners) {
        try {
          fn(payload);
        } catch (error) {
          void error; // a window's own failure is its own
        }
      }
    });
  }
}

/** @returns {HomeApi | null} */
const getHomeApi = () => current;

/** @param {(payload: unknown) => void} fn @returns {() => void} */
function onHomeChanged(fn) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

module.exports = { setHomeApi, getHomeApi, onHomeChanged };
