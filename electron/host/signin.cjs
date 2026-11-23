// Signing in to a harness on a remote Host from the app: the Host runs the vendor flow (host/src/login.mjs), this relays its link to the Mac's browser and its code to the window, and the token stays on the Host.
const { clock } = require('../platform/ports/clock.cjs');
const { openable, onVendorSite } = require('../../shared/host/signinLinks.mjs');
const { GIT_LOGIN } = require('../../shared/host/gitLogin.mjs');
const { randomUUID } = require('node:crypto');

const POLL_MS = 1000;
/** How long the Host waits for a sign-in (LOGIN_MS in host/src/login.mjs); kept here so this domain imports nothing from a harness. */
const LOGIN_MS = 15 * 60_000;
/** The Host gives up on a sign-in after LOGIN_MS; the app waits a little longer before it calls the link expired. */
const EXPIRE_MS = LOGIN_MS + 30_000;
/** How long a sign-in that waits may go without a link or a code before it counts as one that opened no page (an agent that opens its page with an API the Host's opener can't see, or none at all): ended, never an endless wait. */
const NO_PAGE_MS = 20_000;
/** Status calls in a row that may fail before the Host counts as unreachable. */
const MAX_MISSES = 3;
/** How many links one sign-in may open on the Mac: a vendor flow shows one or two, so a Host that lists more is not running one. */
const MAX_OPENED = 3;

/** @typedef {'starting' | 'waiting' | 'signed-in' | 'failed' | 'cancelled' | 'expired' | 'unreachable'} SigninState */
/** @typedef {'no_page' | 'host_update' | null} SigninReason */
/** @typedef {{ hostId: string, harness: string, state: SigninState, codes: string[], error: string | null, reason: SigninReason }} SigninView */

/** @param {unknown} v */
const strings = (v) => (Array.isArray(v) ? v.filter((/** @type {unknown} */ s) => typeof s === 'string') : []);
/** A reachable Host that lacks a capability needs an update, not connection retries. @param {any} error */
const capabilityRefusal = (error) => ['feature_missing', 'unsupported'].includes(error?.code);

/**
 * @param {object} o
 * @param {(hostId: string, method: string, params: object, current?: () => boolean) => Promise<any>} o.call one request to a Host's control channel; rejects when it is unreachable or the Host answers an error
 * @param {(url: string) => unknown} o.openExternal opens a link in the Mac's browser
 * @param {(hostId: string, harness: string) => Promise<{ signedIn: boolean, account?: string }>} o.verify asks the Host itself, not a cached status, whether the harness is signed in now
 * @param {(hostId: string) => unknown} [o.refresh] re-reads the Host's status into the registry after a sign-in ended
 * @param {(view: SigninView) => void} [o.onChange]
 * @param {(error: unknown) => void} [o.report] where a failed refresh, cancel or browser open is reported; none of them changes how the sign-in ended
 * @param {number} [o.pollMs]
 * @param {number} [o.expireMs]
 * @param {number} [o.noPageMs]
 */
function createSignin({
  call,
  openExternal,
  verify,
  refresh = () => undefined,
  onChange = () => undefined,
  report = () => undefined,
  pollMs = POLL_MS,
  expireMs = EXPIRE_MS,
  noPageMs = NO_PAGE_MS,
}) {
  /** One attempt per (Host, harness); a second start joins it, and an attempt that is no longer the one in the map is retired. @type {Map<string, any>} */
  const attempts = new Map();
  /** Host cancellations that must settle before a replacement can start on the same target. @type {Map<string, Promise<unknown>>} */
  const stopping = new Map();
  const keyOf = (/** @type {string} */ hostId, /** @type {string} */ harness) => `${hostId}\n${harness}`;
  const live = (/** @type {any} */ a) => attempts.get(a.key) === a && !a.over;
  const view = (/** @type {any} */ a) => ({
    hostId: a.hostId,
    harness: a.harness,
    state: a.state,
    codes: [...a.codes],
    // a page was opened here: it may ask for a code to be typed back (`input`)
    link: a.opened.size > 0,
    // the first page opened, so the row can open it again (it passed openable and the vendor-site check)
    url: a.opened.values().next().value ?? null,
    // the sites of links that were not opened because they are not where this sign-in goes
    blocked: [...a.blocked],
    error: a.error,
    // why it failed, when the window can offer specific recovery
    reason: a.reason,
    ...(a.harness === GIT_LOGIN ? { attemptId: a.attemptId, recoveryKeys: [...a.recoveryKeys] } : {}),
  });

  /** End `a` with `state`; a retired attempt says nothing. @param {any} a @param {SigninState} state @param {string | null} [error] @param {SigninReason} [reason] */
  function finish(a, state, error = null, reason = null) {
    if (a.over) return;
    a.over = true;
    a.state = state;
    a.error = error;
    a.reason = reason;
    clock.clearTimeout(a.timer);
    a.settle(view(a));
    onChange(view(a));
    void Promise.resolve(refresh(a.hostId)).catch(report);
  }

  /** @param {any} a @param {any} error @param {boolean} needsUpdate */
  function finishRefusal(a, error, needsUpdate) {
    finish(
      a,
      needsUpdate ? 'failed' : 'unreachable',
      String(error?.message || error),
      needsUpdate && a.harness === GIT_LOGIN ? 'host_update' : null,
    );
  }

  /** @param {any} a */
  const sleep = (a) =>
    new Promise((resolve) => {
      a.timer = clock.setTimeout(resolve, pollMs);
    });

  /** Best effort: the sign-in may already be over, or the Host gone. @param {any} a */
  const stopOnHost = (a) => {
    const previous = stopping.get(a.key);
    const request = () => call(a.hostId, 'loginCancel', { harness: a.harness });
    const stop = (previous ? previous.then(request) : request()).catch(report).finally(() => {
      if (stopping.get(a.key) === stop) stopping.delete(a.key);
    });
    stopping.set(a.key, stop);
    return stop;
  };

  /** @param {any} a @param {unknown} status */
  function relay(a, status) {
    const s = /** @type {any} */ (status);
    const opened = a.opened.size;
    const blocked = a.blocked.size;
    for (const link of strings(s.links)) {
      const url = openable(link);
      if (!url || a.opened.has(url)) continue;
      if (!onVendorSite(a.harness, url)) {
        a.blocked.add(new URL(url).hostname);
        continue;
      }
      if (a.opened.size >= MAX_OPENED) continue;
      a.opened.add(url);
      // a phone's sign-in is opened by the phone, in its own browser: the page is recorded (the view carries it) but not opened here
      if (a.openHere) void Promise.resolve(openExternal(url)).catch(report);
    }
    const codes = strings(s.codes);
    if (
      a.opened.size !== opened ||
      a.blocked.size !== blocked ||
      codes.length !== a.codes.length ||
      codes.some((c, i) => c !== a.codes[i])
    ) {
      a.codes = codes;
      onChange(view(a));
    }
  }

  /** The Host says it is done: believe it only when a fresh read of the Host agrees, and never an answer meant for an attempt that was replaced. @param {any} a */
  async function confirm(a) {
    let answer;
    try {
      answer = await verify(a.hostId, a.harness);
    } catch (e) {
      return live(a) && finish(a, 'failed', `Could not confirm the sign-in: ${String(/** @type {any} */ (e)?.message || e)}`);
    }
    if (!live(a)) return;
    if (!answer?.signedIn) return finish(a, 'failed', 'The machine says it is not signed in.');
    if (a.expectAccount && answer.account !== a.expectAccount) {
      return finish(a, 'failed', `Signed in as a different account than ${a.expectAccount}.`);
    }
    finish(a, 'signed-in');
  }

  /** @param {any} a @param {string | undefined} methodId */
  async function run(a, methodId) {
    try {
      const stop = stopping.get(a.key);
      if (stop) await stop;
      if (!live(a)) return;
      await call(a.hostId, 'login', { harness: a.harness, methodId }, () => live(a));
    } catch (e) {
      return live(a) && finishRefusal(a, e, capabilityRefusal(e));
    }
    const deadline = clock.now() + expireMs;
    let misses = 0;
    while (live(a)) {
      let status;
      try {
        status = await call(a.hostId, 'loginStatus', { harness: a.harness });
        misses = 0;
      } catch (e) {
        if (!live(a)) return;
        if (capabilityRefusal(e)) return finishRefusal(a, e, true);
        if (++misses >= MAX_MISSES) return finish(a, 'unreachable', String(/** @type {any} */ (e)?.message || e));
      }
      if (!live(a)) return;
      if (status !== undefined) {
        const s = /** @type {any} */ (status);
        // a Host that restarted lost the sign-in it had under way
        if (s === null || typeof s !== 'object' || typeof s.state !== 'string') {
          return finish(a, 'failed', 'The machine lost the sign-in. Start it again.');
        }
        relay(a, s);
        if (s.state === 'waiting' && a.state === 'starting') {
          a.state = 'waiting';
          a.waitingSince = clock.now();
          onChange(view(a));
        }
        if (s.state === 'done') return confirm(a);
        if (s.state === 'failed') return finish(a, 'failed', typeof s.error === 'string' && s.error ? s.error : 'The sign-in failed.');
        if (s.state === 'cancelled') return finish(a, 'cancelled');
        // the vendor's code ran out: one click starts again with a new one
        if (s.state === 'expired') return finish(a, 'expired', 'That code expired. Get a new one.');
        // waiting with nothing to show: no page will open, so the person is told rather than left waiting
        if (
          a.state === 'waiting' &&
          a.opened.size === 0 &&
          a.blocked.size === 0 &&
          a.codes.length === 0 &&
          clock.now() - a.waitingSince >= noPageMs
        ) {
          await stopOnHost(a);
          return finish(a, 'failed', 'No sign-in page or code came from the machine.', 'no_page');
        }
        if (clock.now() >= deadline) {
          await stopOnHost(a);
          return finish(a, 'expired', 'That code expired. Get a new one.');
        }
      }
      await sleep(a);
    }
  }

  return {
    /**
     * Start the sign-in on the Host, or join the one already under way for that harness. Resolves with how it ended.
     * `openHere` false: the sign-in's page is not opened on this Mac (the caller opens `url` itself); a sign-in already under way keeps how it was started.
     * @param {{ hostId: string, harness: string, methodId?: string, expectAccount?: string, recoveryKey?: string, openHere?: boolean }} p
     * @returns {Promise<SigninView>}
     */
    start({ hostId, harness, methodId, expectAccount, recoveryKey, openHere = true }) {
      const key = keyOf(hostId, harness);
      const running = attempts.get(key);
      if (running && !running.over) {
        if (recoveryKey && !running.recoveryKeys.has(recoveryKey)) {
          running.recoveryKeys.add(recoveryKey);
          onChange(view(running));
        }
        return running.done;
      }
      /** @type {any} */
      const a = {
        key,
        attemptId: randomUUID(),
        recoveryKeys: new Set(recoveryKey ? [recoveryKey] : []),
        hostId,
        harness,
        state: 'starting',
        codes: [],
        error: null,
        reason: null,
        waitingSince: 0,
        over: false,
        opened: new Set(),
        openHere,
        blocked: new Set(),
        expectAccount,
        timer: null,
      };
      a.done = new Promise((resolve) => {
        a.settle = resolve;
      });
      attempts.set(key, a);
      onChange(view(a));
      void run(a, methodId);
      return a.done;
    },
    /** How the latest sign-in of the harness on that Host stands; null when none was started. @param {string} hostId @param {string} harness */
    status(hostId, harness) {
      const a = attempts.get(keyOf(hostId, harness));
      return a ? view(a) : null;
    },
    /** Current views for a window that opens after the sign-in started. */
    views: () => [...attempts.values()].map(view),
    /** Stop waiting, and stop the sign-in on the Host; false when none was under way. @param {string} hostId @param {string} harness */
    cancel(hostId, harness) {
      const a = attempts.get(keyOf(hostId, harness));
      if (!a || a.over) return false;
      finish(a, 'cancelled');
      void stopOnHost(a);
      return true;
    },
    /**
     * One line the person typed for the sign-in under way (the code a page asks to be pasted back); false when none is under way or the Host did not take it. An older Host's refusal rejects.
     * @param {string} hostId @param {string} harness @param {string} text
     */
    async input(hostId, harness, text) {
      const a = attempts.get(keyOf(hostId, harness));
      if (!a || a.over) return false;
      const answer = await call(hostId, 'loginInput', { harness, text });
      return answer?.accepted === true;
    },
    /** The Host is going away from the list: every sign-in under way for it ends, and the Host is told to stop each one. Resolves when it has been told, or could not be; null when none was under way. @param {string} hostId */
    cancelHost(hostId) {
      const stops = [];
      for (const a of attempts.values()) {
        if (a.hostId !== hostId || a.over) continue;
        finish(a, 'cancelled');
        stops.push(stopOnHost(a));
      }
      return stops.length > 0 ? Promise.all(stops).then(() => undefined) : null;
    },
    /** The accounts on a Host changed: every sign-in under way for it, and the read it has in flight, is retired. @param {string} hostId */
    retire(hostId) {
      for (const a of attempts.values()) if (a.hostId === hostId && !a.over) finish(a, 'cancelled');
    },
    dispose() {
      for (const a of attempts.values()) if (!a.over) finish(a, 'cancelled');
    },
  };
}

module.exports = { createSignin, openable, onVendorSite, EXPIRE_MS, MAX_OPENED, NO_PAGE_MS };
