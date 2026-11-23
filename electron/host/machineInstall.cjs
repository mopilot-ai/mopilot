// Installing a missing agent on one of the user's machines: the machine's Host runs the install (host/src/agentInstall.mjs), this starts it over the machine's shared remote Host, follows it by polling, and re-reads the machine when it ends, so the agent shows as needing sign-in or ready. One install per machine and agent: a second click or window joins it.
const { clock } = require('../platform/ports/clock.cjs');
const { INSTALL_WORDS, installText: textOf } = require('../../shared/host/installWords.mjs');

const POLL_MS = 1000;
/** How long a machine may take to answer before its connection is given up. */
const CONNECT_MS = 15_000;
/** The Host stops an install after 10 minutes (INSTALL_MS in host/src/agentInstall.mjs) and one may wait behind another; the app gives up a little after two. */
const EXPIRE_MS = 21 * 60_000;
/** Status calls in a row that may fail before the machine counts as unreachable. */
const MAX_MISSES = 3;

/** @typedef {'queued' | 'running' | 'installed' | 'failed' | 'cancelled' | 'unreachable'} InstallState */
/** @typedef {{ hostId: string, harness: string, state: InstallState, line: string, error: string | null, version: string | null }} InstallView */

/** A refusal with a `code` the window can act on. @param {string} message @param {string} [code] */
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});
const messageOf = (/** @type {any} */ e) => textOf(String(e?.message || e)) || 'The machine did not answer.';

/**
 * @param {object} o
 * @param {{ list: () => any[], check: () => Promise<unknown> }} o.registry the machines and a re-read of their status
 * @param {(id: string) => any} o.hostFor a machine's remote Host (machines.cjs: one per machine, shared with chat sends); null when it cannot be had
 * @param {(view: InstallView) => void} [o.onChange] told how each install stands, at every change
 * @param {(error: unknown) => void} [o.report] where a failed refresh or cancel is reported; neither changes how an install ended
 * @param {number} [o.pollMs]
 * @param {number} [o.expireMs]
 * @param {number} [o.connectMs]
 */
function createMachineInstall({
  registry,
  hostFor,
  onChange = () => undefined,
  report = () => undefined,
  pollMs = POLL_MS,
  expireMs = EXPIRE_MS,
  connectMs = CONNECT_MS,
}) {
  /** One attempt per (machine, agent); a start while one runs joins it, and an attempt no longer in the map is retired. @type {Map<string, any>} */
  const attempts = new Map();
  /** Where each machine was when an install last asked for it: a record that moved is another machine. @type {Map<string, string>} */
  const places = new Map();
  const keyOf = (/** @type {string} */ hostId, /** @type {string} */ harness) => `${hostId}\n${harness}`;
  const live = (/** @type {any} */ a) => attempts.get(a.key) === a && !a.over;
  /** @param {any} a @returns {InstallView} */
  const view = (a) => ({ hostId: a.hostId, harness: a.harness, state: a.state, line: a.line, error: a.error, version: a.version });

  /** The machine's remote Host once it answers, or a refusal. `asking` is the install that asks: it is for the machine there now, so a move does not retire it. @param {string} id @param {any} [asking] */
  async function remoteFor(id, asking) {
    const record = registry.list().find((r) => r.id === id);
    if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
    const place = `${record.address}\n${record.socketPath}`;
    // another machine now answers to this id: the installs begun on the old one are moot
    if (places.has(id) && places.get(id) !== place) retire(id, asking);
    places.set(id, place);
    const host = hostFor(id);
    if (!host) throw refusal('Host is not available for this account.', 'not_allowed');
    let timer;
    try {
      await Promise.race([
        host.connect(),
        new Promise((_, reject) => {
          timer = clock.setTimeout(() => reject(refusal('Could not reach the machine over SSH.')), connectMs);
        }),
      ]);
    } finally {
      clock.clearTimeout(timer);
    }
    return host;
  }

  /** End `a` with `state` (every caller ends only a live attempt). The machine is read again, so the agent's row shows what it is now. @param {any} a @param {InstallState} state @param {string | null} [error] */
  function finish(a, state, error = null) {
    a.over = true;
    a.state = state;
    a.error = error;
    a.line = '';
    // the poll waiting for its next turn wakes and sees it ended, rather than waiting forever
    clock.clearTimeout(a.timer);
    a.wake?.();
    // the row should already say what the agent is now when the window hears the install ended
    void Promise.resolve()
      .then(() => (state === 'installed' ? registry.check() : undefined))
      .catch(report)
      .finally(() => onChange(view(a)));
  }

  /** Best effort: the install may already be over, or the machine gone. @param {any} a */
  const stopOnHost = (a) =>
    remoteFor(a.hostId)
      .then((host) => host.installCancel({ harness: a.harness }))
      .catch(report);

  /** @param {any} a @param {unknown} status @returns {boolean} whether it ended */
  function follow(a, status) {
    const s = /** @type {any} */ (status);
    // a Host that restarted lost the install it had under way
    if (s === null || typeof s !== 'object' || typeof s.state !== 'string') {
      finish(a, 'failed', INSTALL_WORDS.lost);
      return true;
    }
    if (s.state === 'done') {
      a.version = textOf(s.version) || null;
      finish(a, 'installed');
      return true;
    }
    if (s.state === 'failed') return finish(a, 'failed', textOf(s.error) || INSTALL_WORDS.failed), true;
    if (s.state === 'cancelled') return finish(a, 'cancelled'), true;
    const state = s.state === 'queued' ? 'queued' : 'running';
    const line = textOf(s.line);
    if (state !== a.state || line !== a.line) {
      a.state = state;
      a.line = line;
      onChange(view(a));
    }
    return false;
  }

  /** @param {any} a */
  async function run(a) {
    let host;
    let first;
    try {
      host = await remoteFor(a.hostId, a);
      if (!live(a)) return;
      first = await host.install({ harness: a.harness });
    } catch (e) {
      if (!live(a)) return;
      // an older Host has no install: say what to do, not the wire's words
      const old = /** @type {any} */ (e)?.code === 'feature_missing';
      return finish(a, old ? 'failed' : 'unreachable', old ? INSTALL_WORDS.oldHost : messageOf(e));
    }
    if (!live(a) || follow(a, first)) return;
    // the deadline counts from when it runs: waiting behind another install on the machine is not running
    let deadline = clock.now() + expireMs;
    let misses = 0;
    for (;;) {
      await new Promise((resolve) => {
        a.wake = resolve;
        a.timer = clock.setTimeout(resolve, pollMs);
      });
      if (!live(a)) return;
      if (clock.now() >= deadline) {
        await stopOnHost(a);
        return finish(a, 'failed', INSTALL_WORDS.tooLong);
      }
      let status;
      try {
        status = await host.installStatus({ harness: a.harness });
        misses = 0;
      } catch (e) {
        if (!live(a)) return;
        if (++misses >= MAX_MISSES) return finish(a, 'unreachable', messageOf(e));
        continue;
      }
      if (!live(a) || follow(a, status)) return;
      if (a.state === 'queued') deadline = clock.now() + expireMs;
    }
  }

  /** Another machine answers to the id: what was under way for the old one ends quietly. @param {string} hostId @param {any} [keep] */
  function retire(hostId, keep) {
    for (const a of attempts.values()) if (a.hostId === hostId && !a.over && a !== keep) finish(a, 'cancelled');
  }

  return {
    /**
     * Install `harness` on the machine, or join the install under way; returns how it stands at once, and each change goes to `onChange`.
     * Refused for a machine not in the list, one that is offline, or an agent it does not list as one it can install.
     * @param {string} id @param {string} harness @returns {InstallView}
     */
    start(id, harness) {
      const key = keyOf(id, harness);
      const running = attempts.get(key);
      if (running && !running.over) return view(running);
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
      if (record.status === 'offline') throw refusal(`${record.name} is offline.`, 'host_unreachable');
      const listed = Array.isArray(record.harnesses) ? record.harnesses.find((/** @type {any} */ h) => h?.id === harness) : null;
      if (!listed || listed.detected || listed.installable !== true)
        throw refusal('That machine cannot install that agent from here.', 'invalid');
      /** @type {any} */
      const a = { key, hostId: id, harness, state: 'queued', line: '', error: null, version: null, over: false, timer: null };
      attempts.set(key, a);
      onChange(view(a));
      void run(a);
      return view(a);
    },
    /** How the latest install of the agent on that machine stands; null when none was started. @param {string} id @param {string} harness */
    status(id, harness) {
      const a = attempts.get(keyOf(id, harness));
      return a ? view(a) : null;
    },
    /** Stop the install here and on the machine; false when none was under way. @param {string} id @param {string} harness */
    cancel(id, harness) {
      const a = attempts.get(keyOf(id, harness));
      if (!a || a.over) return false;
      finish(a, 'cancelled');
      void stopOnHost(a);
      return true;
    },
    /** The machine is leaving the list: its installs end and the machine is told to stop them; call before the registry drops the record. @param {string} id */
    forget(id) {
      const stops = [];
      for (const a of attempts.values()) {
        if (a.hostId !== id || a.over) continue;
        finish(a, 'cancelled');
        stops.push(stopOnHost(a));
      }
      places.delete(id);
      return stops.length > 0 ? Promise.all(stops).then(() => undefined) : null;
    },
    /** Host access was lost, or the app is closing: nothing is followed any more (the machines finish what they started). */
    dispose() {
      for (const a of attempts.values()) if (!a.over) finish(a, 'cancelled');
    },
  };
}

module.exports = { createMachineInstall, EXPIRE_MS };
