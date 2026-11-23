// macOS's passkey sheet for the built-in browser, app-wide: loads passkeys.node, says whether this signature and
// macOS allow it (and the shared.browser.systemPasskeys switch), and runs one sheet at a time. macOS shows one per
// app, so a request while one is up is refused, not queued behind the sheet the user is looking at. The slot frees
// when macOS answers, not at cancel, so a late answer can't be taken for the next request's (docs/iab-passkeys.md).
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');

/** How long a cancelled sheet may take to answer before its slot is freed anyway. */
const CANCEL_GRACE = 10_000;

/** Where passkeys.node lives: Contents/Helpers in a packaged app, native/passkeys/build in a checkout. */
function addonPath({ packaged = false, resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '../../..') } = {}) {
  return packaged ? path.join(resourcesPath, '..', 'Helpers', 'passkeys.node') : path.join(repoRoot, 'native/passkeys/build/passkeys.node');
}

/**
 * passkeys.node, on macOS only (a checkout loads its own build of it, when there is one); throws when it isn't there.
 * @param {{ platform?: string, packaged?: boolean, resourcesPath?: string, load?: (p: string) => any }} [o]
 */
function loadPasskeyAddon({ platform = process.platform, packaged = false, resourcesPath = process.resourcesPath, load = require } = {}) {
  return platform === 'darwin' ? load(addonPath({ packaged, resourcesPath })) : null;
}

/**
 * @typedef {{ available(): { entitlement: boolean, platform: boolean, securityKey: boolean }, start(json: string, win: Buffer | null, cb: (json: string) => void): number, cancel(handle: number): void }} Addon
 * @typedef {{ busy: true } | { answer: Promise<any>, cancel: () => void }} Run
 */

/**
 * `anchor`: the window showing a page, which the sheet attaches to (null while the page isn't showing); `legacy`:
 * whether Electron's Touch ID authenticator is on, so a passkey an earlier build made may be offered.
 * @param {{ load?: () => Addon | null, enabled?: () => boolean, legacy?: () => boolean, anchor?: (wc: any) => any, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} [o]
 */
function createSystemPasskeys({
  load = () => null,
  enabled = () => false,
  legacy = () => false,
  anchor = () => null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** @type {Addon | null | undefined} */
  let addon;
  /** @type {{ handle: number } | null} */
  let current = null;
  const native = () => {
    if (addon === undefined) {
      try {
        addon = load();
      } catch (error) {
        // not built (a checkout), or not macOS: Electron's own path stays
        noteIgnored("load macOS's passkey bridge", error);
        addon = null;
      }
    }
    return addon;
  };
  /** @type {{ platform: boolean, securityKey: boolean } | null | undefined} the signature and macOS: read once */
  let offered;
  const offer = () => {
    if (offered !== undefined) return offered;
    const a = native();
    /** @type {any} */
    let c = null;
    try {
      c = a?.available();
    } catch (error) {
      noteIgnored("ask macOS's passkey bridge what it can do", error);
    }
    offered = c?.entitlement && c.platform ? { platform: true, securityKey: !!c.securityKey } : null;
    return offered;
  };
  /** What the sheet can serve now: nothing unless the entitlement, macOS 13.5 and the switch allow it. */
  const caps = () => (enabled() ? offer() : null);
  return {
    caps,
    legacy,
    anchor,
    busy: () => current !== null,
    /**
     * Shows the sheet for one validated request (passkeyRequest.cjs), anchored to `window` (its native handle).
     * `answer` settles once: macOS's answer, or a cancel error after `timeout` or cancel().
     * @param {Record<string, unknown>} request
     * @param {Buffer | null} window
     * @param {number} timeout
     * @returns {Run}
     */
    run(request, window, timeout) {
      const a = native();
      if (current || !a) return { busy: true };
      const slot = { handle: 0 };
      /** @type {(value: any) => void} */
      let settle = /** @type {any} */ (null);
      const answer = new Promise((resolve) => {
        settle = resolve;
      });
      let timer;
      let grace;
      const done = (/** @type {any} */ value) => {
        clearTimer(timer);
        clearTimer(grace);
        if (current === slot) current = null;
        settle(value);
      };
      try {
        slot.handle = a.start(JSON.stringify(request), window, (json) => {
          let value;
          try {
            value = JSON.parse(json);
          } catch {
            value = { ok: false, code: 1000 };
          }
          done(value);
        });
      } catch (error) {
        noteIgnored("show macOS's passkey sheet", error);
        // no sheet came up, so there is none to close
        return { answer: Promise.resolve({ ok: false, code: 1000 }), cancel: () => undefined };
      }
      current = slot;
      const cancel = () => {
        if (current !== slot) return;
        try {
          a.cancel(slot.handle);
        } catch (error) {
          noteIgnored("close macOS's passkey sheet", error);
        }
        // macOS answers a cancel with its own error; should it never, the slot doesn't stay taken
        clearTimer(grace);
        grace = setTimer(() => done({ ok: false, code: 1001 }), CANCEL_GRACE);
      };
      timer = setTimer(cancel, timeout);
      return { answer, cancel };
    },
  };
}

/** @type {ReturnType<typeof createSystemPasskeys>} the app's one instance, set up by the first browser session (auth.cjs) */
let shared = createSystemPasskeys();
let configured = false;

/** Sets up the app's one instance; later calls (each browser session's) keep it, and the sheet it may have up. */
function configureSystemPasskeys(/** @type {Parameters<typeof createSystemPasskeys>[0]} */ o) {
  if (!configured) shared = createSystemPasskeys(o);
  configured = true;
  return shared;
}

const systemPasskeys = () => shared;

module.exports = { createSystemPasskeys, configureSystemPasskeys, systemPasskeys, addonPath, loadPasskeyAddon, CANCEL_GRACE };
