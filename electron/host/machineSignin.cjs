// Signing in to a harness on one of the user's machines: createSignin (signin.cjs) over each machine's remote Host, over the machine's shared remote Host (machines.cjs hostFor), with the refresh, retire and cancel that a machine leaving, being replaced, or Host access ending call for.
const { createSignin } = require('./signin.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { GIT_HOST, GIT_LOGIN } = require('../../shared/host/gitLogin.mjs');
const { isLocal } = require('./localHost.cjs');
const { isLocalHostId } = require('../../shared/host/localMachine.mjs');

/** How long a machine may take to answer before its connection is given up. */
const CONNECT_MS = 15_000;

/** A refusal with a `code` the window can act on. @param {string} message @param {string} [code] */
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/**
 * @param {object} o
 * @param {{ list: () => any[], check: () => Promise<unknown> }} o.registry the machines and a re-read of their status
 * @param {(id: string) => ReturnType<typeof import('./remote.cjs').createRemoteHost> | null} o.hostFor a machine's remote Host (machines.cjs: one per machine, shared with chat sends); null when it cannot be had
 * @param {(url: string) => unknown} o.openExternal opens a sign-in link in the Mac's browser
 * @param {(view: any) => void} o.onChange told how each sign-in stands, at every change
 * @param {(error: unknown) => void} o.report where a failed refresh, cancel or browser open is reported; none of them changes how a sign-in ended
 */
function createMachineSignin({ registry, hostFor, openExternal, onChange, report }) {
  /** Where each machine was when a sign-in last asked for it: a record that moved is another machine. @type {Map<string, string>} */
  const places = new Map();

  /** Note where the machine is now; another machine answering to this id makes the sign-ins begun on the old one moot. @param {string} id @param {{ address: string, socketPath?: string }} record */
  function notice(id, record) {
    const place = `${record.address}\n${record.socketPath}`;
    if (places.has(id) && places.get(id) !== place) signin.retire(id);
    places.set(id, place);
  }

  /** The machine's remote Host once it answers, or a refusal. The connection is shared with chat sends, so a machine that does not answer in time only ends this call. @param {string} id */
  async function remoteFor(id) {
    const record = registry.list().find((r) => r.id === id);
    if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
    // a machine with only a relay path (`relay:<host id>`) needs no socket of its own: its relay tunnel ends at the Host's socket
    if (!record.socketPath && !record.address.startsWith('relay:')) throw refusal('This machine has no Host socket on record.');
    notice(id, record);
    const place = places.get(id);
    const host = hostFor(id);
    if (!host) throw refusal('Host is not available for this account.', 'not_allowed');
    let timer;
    try {
      await Promise.race([
        host.connect(),
        new Promise((_, reject) => {
          timer = clock.setTimeout(() => reject(refusal('Could not reach the machine over SSH.')), CONNECT_MS);
        }),
      ]);
    } finally {
      clock.clearTimeout(timer);
    }
    const latest = registry.list().find((r) => r.id === id);
    if (!latest || latest.address !== record.address || latest.socketPath !== record.socketPath) {
      // A replacement may already own this id by the time the old connection answers.
      if (places.get(id) === place) signin.retire(id);
      throw refusal('The machine changed during sign-in. Start it again.');
    }
    return host;
  }

  const signin = createSignin({
    // signin.cjs asks for `login`, `loginStatus` and `loginCancel`: the remote Host's own methods of those names
    call: async (id, method, params, current = () => true) => {
      const host = await remoteFor(id);
      if (!current()) throw refusal('The sign-in was cancelled.');
      return /** @type {any} */ (host)[method](params);
    },
    openExternal,
    // a fresh read of the machine itself, never the registry's last heartbeat
    verify: async (id, harness) => {
      if (harness === GIT_LOGIN) {
        const status = await (await remoteFor(id)).status({ signIn: [GIT_HOST] });
        return { signedIn: status?.gitSignIn?.[GIT_HOST] === 'yes' };
      }
      const status = await (await remoteFor(id)).status();
      const found = Array.isArray(status?.harnesses) ? status.harnesses.find((/** @type {any} */ h) => h?.id === harness) : null;
      return { signedIn: found?.signedIn === true };
    },
    refresh: () => registry.check(),
    onChange,
    report,
  });

  return {
    /**
     * Start signing in to a harness the machine lists; returns how the sign-in stands at once, and each change is pushed to `onChange`.
     * @param {string} id @param {string} harness @param {string} [recoveryKey] the interrupted operation, never sent to the Host
     * @param {boolean} [openHere] false for a phone's sign-in: its page is the phone's to open, not this Mac's
     */
    start(id, harness, recoveryKey, openHere = true) {
      if (recoveryKey !== undefined && (typeof recoveryKey !== 'string' || !recoveryKey || recoveryKey.length > 2048))
        throw refusal('The interrupted operation is no longer available. Try it again.', 'invalid');
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
      if (harness === GIT_LOGIN && (isLocalHostId(id) || isLocal(record.address)))
        throw refusal('Pick a remote machine to sign in to GitHub.', 'invalid');
      if (harness !== GIT_LOGIN && !record.harnesses.some((/** @type {any} */ h) => h.id === harness && h.detected))
        throw refusal('That machine does not list that agent.', 'invalid');
      // a move is noticed before the new sign-in exists: noticed by its own first call, it would retire that sign-in too
      notice(id, record);
      void signin.start({ hostId: id, harness, recoveryKey, openHere });
      return /** @type {NonNullable<ReturnType<typeof signin.status>>} */ (signin.status(id, harness));
    },
    status: signin.status,
    views: signin.views,
    cancel: signin.cancel,
    input: signin.input,
    /** The machine is leaving the list: its sign-ins end and the machine is told to stop them. Resolves when it has been told, or could not be (null when none was under way); call before the registry drops the record. @param {string} id */
    forget(id) {
      places.delete(id);
      return signin.cancelHost(id);
    },
    /** Host access was lost, or the app is closing: no sign-in waits. */
    dispose() {
      signin.dispose();
    },
  };
}

module.exports = { createMachineSignin };
