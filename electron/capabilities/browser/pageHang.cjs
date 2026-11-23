// Whether a built-in browser page stopped responding (a script on it busy-looping), for every harness: browser calls on it fail at once with that reason instead of each waiting out its timeout, and the pane offers Wait, Reload and Close tab.
//
// Electron's 'unresponsive' comes only from input the page doesn't take within its hang timeout, and not at all for
// CDP's commands, so an agent's call that waits on the page gets the page checked: a trivial script that doesn't
// run within PROBE_MS means the page is hung. The same check answering later means it responds again. A page held by
// one of its own dialogs (pageDialogs.cjs, or a frame's over CDP) is waiting for its answer, not hung. Neither is a page
// still waiting on its server's first response: a CDP command queues behind the pending navigation (measured: the
// check answered only when a 12 s page committed), so it says nothing about the page's script.
// Every page is taken by its native webContents (keyOf): these are Electron's events and members, which a backend's
// wrapper does not all carry, and a command on the wrapper and a hang the pane saw on the webContents are one page.
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');
const { keyOf } = require('./pageKey.cjs');

/** How long a command waits on a page before the page is checked. */
const SUSPECT_MS = 3_000;
/** How long the check waits for the page to run a trivial script. */
const PROBE_MS = 3_000;

/**
 * Runs a trivial script on the page: over its CDP session while an agent holds it, else in its main frame.
 * @param {any} wc
 */
const defaultProbe = (wc) =>
  wc.debugger?.isAttached?.()
    ? wc.debugger.sendCommand('Runtime.evaluate', { expression: '0', returnByValue: true })
    : wc.mainFrame.executeJavaScript('0');

/** Events: 'change' (wc, hung) when a page stops responding or responds again. */
class PageHang extends EventEmitter {
  /**
   * @param {{ blocked?: (wc: any) => boolean, probe?: (wc: any) => Promise<unknown>, probeMs?: number }} [o]
   *   blocked: the page waits on a dialog of its own; probe: the check (defaultProbe)
   */
  constructor(o = {}) {
    super();
    this.blocked = o.blocked ?? (() => false);
    this.probe = o.probe ?? defaultProbe;
    this.probeMs = o.probeMs ?? PROBE_MS;
    /** webContents id -> 'hung' | 'checking' */
    this.state = new Map();
    /** pages watched for Electron's own events */
    this.watched = new WeakSet();
    // every command waiting on a page listens for its hang (untilHung)
    this.setMaxListeners(0);
  }

  /** Whether the page is known to have stopped responding. */
  hung(/** @type {any} */ contents) {
    const wc = keyOf(contents);
    return !!wc && this.state.get(wc.id) === 'hung';
  }

  /** Follows a page's own hang events, and lets go of it when its renderer or the page goes. */
  watch(/** @type {any} */ contents) {
    const wc = keyOf(contents);
    if (!wc || this.watched.has(wc)) return;
    this.watched.add(wc);
    wc.on('unresponsive', () => {
      if (!this.blocked(wc)) this.#set(wc, true);
    });
    wc.on('responsive', () => this.#set(wc, false));
    // a new renderer (a reload after the old one was stopped) starts responsive
    wc.on('render-process-gone', () => this.#set(wc, false));
    wc.once('destroyed', () => this.state.delete(wc.id));
  }

  /**
   * A command has waited on the page for SUSPECT_MS: check whether it runs at all. One check at a time per page;
   * a check that runs late is the page responding again.
   */
  suspect(/** @type {any} */ contents) {
    const wc = keyOf(contents);
    // a crashed renderer is not a busy script: its calls say "crashed, reload it" (browserDispatch.cjs)
    if (!wc || wc.isDestroyed() || wc.isCrashed?.() || this.state.has(wc.id) || this.blocked(wc)) return;
    this.watch(wc);
    this.state.set(wc.id, 'checking');
    const run = this.#check(wc);
    let waited = false;
    const decide = () => {
      if (run.answered || this.state.get(wc.id) !== 'checking') return;
      // a page that went, or now waits on its own dialog, says nothing about its script
      if (wc.isDestroyed() || this.blocked(wc)) return this.state.delete(wc.id);
      // the check is queued behind a navigation still waiting on its server: decide a full PROBE_MS after the response
      // is in, so a page that commits answers it, and a renderer busy when the page arrives is still found
      const waiting = !!wc.isWaitingForResponse?.();
      if (waiting || waited) {
        waited = waiting;
        const again = setTimeout(decide, this.probeMs);
        again.unref?.();
        return;
      }
      this.#set(wc, true);
    };
    const timer = setTimeout(decide, this.probeMs);
    timer.unref?.();
  }

  /**
   * Runs the check once. Only a check that runs means the page responds: one that fails (CDP detached at the turn's
   * end, the page navigating) says nothing about its script, so a hung page is checked again a little later.
   */
  #check(/** @type {any} */ wc) {
    const run = { answered: false };
    let check;
    try {
      check = Promise.resolve(this.probe(wc));
    } catch (error) {
      check = Promise.reject(error);
    }
    check.then(
      () => {
        run.answered = true;
        if (this.state.get(wc.id) === 'hung') this.#set(wc, false);
        else if (this.state.get(wc.id) === 'checking') this.state.delete(wc.id);
      },
      (error) => {
        run.answered = true;
        noteIgnored('check whether a browser page responds', error);
        if (this.state.get(wc.id) === 'checking') this.state.delete(wc.id);
        else if (this.state.get(wc.id) === 'hung') {
          const again = setTimeout(() => {
            if (this.state.get(wc.id) === 'hung' && !wc.isDestroyed()) this.#check(wc);
          }, this.probeMs);
          again.unref?.();
        }
      },
    );
    return run;
  }

  #set(/** @type {any} */ wc, /** @type {boolean} */ hung) {
    const was = this.state.get(wc.id) === 'hung';
    if (hung) this.state.set(wc.id, 'hung');
    else this.state.delete(wc.id);
    if (was !== hung) this.emit('change', wc, hung);
  }
}

/**
 * `p`, a command sent to page `wc`, for every caller of a page's CDP (the browser host's tabs, the legacy panel
 * tools): it fails with `error()` at once on a page known to be hung, or as soon as the page is found hung while it
 * waits; one that waits SUSPECT_MS gets the page checked.
 * @template T
 * @param {PageHang | null | undefined} hang
 * @param {any} contents the page: a backend's wrapper or its webContents
 * @param {() => Promise<T>} send
 * @param {() => Error} error
 * @returns {Promise<T>}
 */
function untilHung(hang, contents, send, error) {
  if (!hang) return send();
  const wc = keyOf(contents);
  if (hang.hung(wc)) return Promise.reject(error());
  /** @type {Promise<T>} */
  let p;
  try {
    p = Promise.resolve(send());
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const stop = (/** @type {any} */ w, /** @type {boolean} */ hung) => {
      if (keyOf(w) !== wc || !hung) return;
      // the command may never answer: it stops waiting here
      done();
      reject(error());
    };
    const timer = setTimeout(() => hang.suspect(wc), SUSPECT_MS);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      hang.removeListener('change', stop);
    };
    hang.on('change', stop);
    p.then(resolve, reject);
    p.then(done, done);
  });
}

module.exports = { PageHang, untilHung, SUSPECT_MS, PROBE_MS };
