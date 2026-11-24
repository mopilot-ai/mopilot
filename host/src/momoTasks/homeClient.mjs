// MoMo's home as a client of another Host: it dials the machine over a transport it is given (the end-to-end relay session in the product, a fake in tests), proves its home key with the same challenge the app answers, says hello, and stamps every request with the home's lease. One connection per machine, made again when it was lost; a connection or a request that never answers is given up, and a machine that could not be reached is not tried again at once.
import { createRequire } from 'node:module';
import { HostRefusal } from '../hostFs.mjs';
import { helloParams } from '../../../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { authenticate } = require('../../../electron/host/pairingClient.cjs');

/**
 * What a dialer gives: the line protocol of the other Host as requests and the events it pushes.
 * @typedef {{ id: string, name: string, link: string, hostId: string }} Machine
 * @typedef {{ request: (method: string, params?: object) => Promise<any>, onEvent: (fn: (event: any) => void) => () => void, onClose: (fn: () => void) => void, close: () => void }} Transport
 */

/** The codes a Host answers a connection it does not serve, read as "MoMo is not allowed here". */
const NOT_ALLOWED = new Set(['unknown_client', 'home_not_allowed']);
/** How long making a connection (dial, proof, hello) may take, and how long one request may wait for its answer. */
export const OPEN_MS = 20_000;
export const REQUEST_MS = 60_000;
/** The wait before a machine that could not be reached is tried again: it starts here, doubles with each failure, and stops at the cap. */
export const BACKOFF_MS = 30_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Waits for `work` at most `ms`; past that it gives up with a failure that has no code (the connection, not the Host). @template T @param {Promise<T>} work @param {number} ms @param {() => void} onTimeout */
function within(work, ms, onTimeout) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('timed out'));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} o
 * @param {() => Promise<{ publicKey: string, sign: (purpose: string, hostId: string, nonce: string) => string }>} o.identity
 * @param {() => { homeId: string, leaseEpoch: number } | null} o.stamp the home's lease now (null: this Host is not the running home)
 * @param {(machine: Machine) => Promise<Transport>} o.dial
 * @param {number} [o.openMs]
 * @param {number} [o.requestMs]
 * @param {() => number} [o.now]
 */
export function createHomeClient({ identity, stamp, dial, openMs = OPEN_MS, requestMs = REQUEST_MS, now = Date.now }) {
  /** @type {Map<string, Promise<{ transport: Transport, listeners: Map<string, (event: any) => void> }>>} */
  const sessions = new Map();
  /** Machines that could not be reached: nothing is dialled before `until`. @type {Map<string, { until: number, delay: number }>} */
  const backoff = new Map();
  const away = () => new HostRefusal('momo_home_away', "MoMo's home is not running on this machine.");
  /** Bumped when every connection closes: a dial that was in flight then is closed when it lands, never handed out. */
  let generation = 0;
  /** The connections made and open now, to close with the rest. @type {Set<Transport>} */
  const established = new Set();

  /** @param {Machine} machine */
  function failedToReach(machine) {
    const delay = Math.min((backoff.get(machine.id)?.delay ?? BACKOFF_MS / 2) * 2, BACKOFF_MAX_MS);
    backoff.set(machine.id, { until: now() + delay, delay });
  }

  /** @param {Machine} machine @param {{ homeId: string, leaseEpoch: number }} home */
  function open(machine, home) {
    const gen = generation;
    /** @type {Transport | undefined} */
    let transport;
    /** Set when the attempt took too long: a connection that lands after that is closed, not used. */
    let gaveUp = false;
    const attempt = (async () => {
      try {
        transport = await dial(machine);
      } catch (error) {
        throw new HostRefusal('machine_offline', `${machine.name} is offline.`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      // closed while it was being dialled (a move, a Reset): nothing is handed out, and nothing is signed
      if (gaveUp) transport.close();
      if (gen !== generation || gaveUp) throw new HostRefusal('machine_offline', `${machine.name} is offline.`);
      // the proof is made only for the Host this machine had when MoMo was allowed there: another Host answering is not that machine
      const challenged = await transport.request('host.challenge');
      if (challenged?.hostId !== machine.hostId)
        throw new HostRefusal('machine_changed', `That isn't the machine MoMo was allowed to use as ${machine.name}. Allow it again.`);
      const proof = Object.create(await identity(), { pin: { value: { expected: machine.hostId } } });
      await authenticate(transport.request, /** @type {any} */ (proof));
      await transport.request('host.hello', { ...helloParams(), home });
      if (gen !== generation) throw new HostRefusal('machine_offline', `${machine.name} is offline.`);
      return transport;
    })();
    const made = within(attempt, openMs, () => void (gaveUp = true)).then(
      (/** @type {Transport} */ ready) => {
        backoff.delete(machine.id);
        /** @type {Map<string, (event: any) => void>} */
        const listeners = new Map();
        ready.onEvent((event) => void listeners.get(event?.chatId)?.(event));
        established.add(ready);
        ready.onClose(() => {
          established.delete(ready);
          if (sessions.get(machine.id) === made) sessions.delete(machine.id);
        });
        return { transport: ready, listeners };
      },
      (/** @type {any} */ error) => {
        transport?.close();
        const refusal = refusalOf(machine, error, false);
        // only a machine that could not be reached is waited out: an answer from the Host (not allowed, another Host) is not a failure to reach it
        if (refusal.code === 'machine_offline') failedToReach(machine);
        throw refusal;
      },
    );
    // a failed attempt is not kept: a later call dials again once the wait is over
    made.catch(() => sessions.get(machine.id) === made && sessions.delete(machine.id));
    sessions.set(machine.id, made);
    return made;
  }

  /**
   * The refusal a failure is told as. A code the Host gave stays; "not served" is not allowed; a failure with no code is the connection: before the request was sent it is plainly offline, after it, the request may have been taken (`machine_lost`).
   * @param {{ name: string }} machine @param {any} error @param {boolean} sent whether the request had been sent
   */
  function refusalOf(machine, error, sent) {
    if (NOT_ALLOWED.has(error?.code)) return new HostRefusal('machine_not_allowed', `MoMo isn't allowed to use ${machine.name} yet.`);
    if (typeof error?.code === 'string') return error;
    return sent
      ? new HostRefusal('machine_lost', `The connection to ${machine.name} was lost, so it may have started.`)
      : new HostRefusal('machine_offline', `${machine.name} is offline.`);
  }

  /** The home's lease now, and the connection to a machine (made if there is none, unless it could not be reached a moment ago). @param {Machine} machine */
  async function sessionOf(machine) {
    const home = stamp();
    if (!home) throw away();
    const waiting = sessions.has(machine.id) ? undefined : backoff.get(machine.id);
    if (waiting && now() < waiting.until) throw new HostRefusal('machine_offline', `${machine.name} is offline.`);
    return { home, session: await (sessions.get(machine.id) ?? open(machine, home)) };
  }

  return {
    /**
     * One request to a machine, carrying the home's lease. A refusal keeps the Host's own code; a request the Host does not serve this home is `machine_not_allowed`; a connection that cannot be made is `machine_offline`, and one lost, or silent past the limit, after the request was sent `machine_lost`.
     * @param {Machine} machine @param {string} method @param {Record<string, unknown>} [params]
     */
    async call(machine, method, params = {}) {
      const { home, session } = await sessionOf(machine);
      try {
        // a connection that never answers is closed, so the next call makes a new one
        return await within(session.transport.request(method, { ...params, home }), requestMs, () => {
          session.transport.close();
          void sessions.get(machine.id)?.then((s) => s === session && sessions.delete(machine.id));
        });
      } catch (error) {
        throw refusalOf(machine, error, true);
      }
    },
    /**
     * Hear the events of one chat on a machine (the frames of its journal); one listener per chat.
     * @param {Machine} machine @param {string} chatId @param {(event: any) => void} fn
     */
    async listen(machine, chatId, fn) {
      const { session } = await sessionOf(machine);
      session.listeners.set(chatId, fn);
    },
    /** @param {string} machineId @param {string} chatId */
    async unlisten(machineId, chatId) {
      (await sessions.get(machineId))?.listeners.delete(chatId);
    },
    /** Every connection closes (a move begins, Reset). */
    async close() {
      // a dial still in flight closes itself when it lands (its generation is past); the open connections close now
      generation++;
      sessions.clear();
      backoff.clear();
      for (const transport of [...established]) transport.close();
      established.clear();
    },
  };
}
