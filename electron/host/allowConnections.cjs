// "Allow connections" told to this Mac's own Host (R2b of #5576): the switch (Mobile Remote consent) is the app's, the Host keeps a copy for pairing by code and makes no code while it is off; the app tells it over the Host's CLI connection (the token beside its socket) when the switch changes and each time the Host comes online.
const net = require('node:net');
const { fs } = require('../platform/ports/fs.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const frames = require('../../shared/host/frames.mjs');
const { helloParams } = require('../../shared/host/schema.mjs');
const { LOCAL_HOST_ID } = require('../../shared/host/localMachine.mjs');

/** How long the Host has to answer both requests. */
const TELL_MS = 15_000;
const METHOD = 'host.codePair.connections';

/** A refusal from the Host or the socket, with the Host's `code` when it sent one. @param {string} message @param {string} [code] */
const refusal = (message, code) => Object.assign(new Error(message), code ? { code } : {});

/**
 * Says hello as the CLI and, when the Host pairs by code, tells it whether connections are allowed and this app's own key (the one client off does not keep out). Resolves the Host's answer, or null for a Host that does not pair by code (it has nothing to keep).
 * @param {string} socketPath @param {boolean} open @param {string} app the fingerprint of this app's own key ('' when it has none: no client is exempt)
 * @param {{ connect?: (socketPath: string) => import('node:net').Socket, readToken?: (socketPath: string) => string, timeoutMs?: number }} [o]
 * @returns {Promise<{ open: boolean, cancelled: number } | null>}
 */
function tellHost(
  socketPath,
  open,
  app,
  { connect = net.connect, readToken = (p) => fs.readFileSync(`${p}.token`, 'utf8'), timeoutMs = TELL_MS } = {},
) {
  // no token, no CLI: the Host would take this connection for a stranger's
  const token = readToken(socketPath);
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = frames.createDecoder();
    let done = false;
    /** @param {(v: any) => void} settle @param {any} v */
    const finish = (settle, v) => {
      if (done) return;
      done = true;
      clock.clearTimeout(guard);
      socket.destroy();
      settle(v);
    };
    const guard = clock.setTimeout(() => finish(reject, refusal('This Mac’s Host did not answer.', 'host_unreachable')), timeoutMs);
    const send = (/** @type {number} */ id, /** @type {string} */ method, /** @type {object} */ params) =>
      socket.write(frames.encodeControl({ id, method, params, token }));
    socket.on('error', (e) => finish(reject, refusal(e.message)));
    socket.on('close', () => finish(reject, refusal('This Mac’s Host closed the connection.')));
    socket.once('connect', () => send(1, 'host.hello', helloParams()));
    socket.on('data', (chunk) => {
      try {
        for (const f of decoder.push(chunk)) {
          if (f.kind !== 'control') continue;
          const m = f.message;
          // the Host's refusals are a sentence and a code (host/src/server.mjs)
          if (m.error !== undefined) return finish(reject, refusal(String(m.error), m.code));
          if (m.id === 1) {
            const features = m.result?.agreed?.features;
            // a Host built without pairing by code (or older) has no copy to keep
            if (!Array.isArray(features) || !features.includes('codePair')) return finish(resolve, null);
            send(2, METHOD, { open, ...(app ? { app } : {}) });
          } else if (m.id === 2) return finish(resolve, m.result);
        }
      } catch {
        finish(reject, refusal('This Mac’s Host sent something this app cannot read.'));
      }
    });
  });
}

/**
 * @param {object} o
 * @param {() => { row: (id: string) => { socketPath?: string } | undefined, selfFingerprint: () => string } | null} o.machines the machine list (null before it is made): this Mac's own Host's socket, and this app's own key
 * @param {() => { enabled: () => boolean, onChange: (fn: () => void) => () => void } | undefined} o.consent the switch (electron/remote/consent.cjs); none is off
 * @param {(error: unknown) => void} o.report a telling that failed
 * @param {typeof tellHost} [o.tell]
 */
function createAllowConnections({ machines, consent, report, tell = tellHost }) {
  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  /** Whether this Mac's Host answered at the last snapshot. */
  let up = false;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** Tells the Host the switch as it is now; a change while one telling runs is told once more after it (the last word is the switch's). */
  function push() {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        // a telling never fails its caller: what goes wrong, reading the list included, is reported
        try {
          const list = machines();
          const at = list?.row(LOCAL_HOST_ID)?.socketPath;
          if (!list || !at) break;
          await tell(at, consent()?.enabled() === true, list.selfFingerprint());
        } catch (error) {
          report(error);
        }
      } while (again);
    })().finally(() => {
      running = null;
      // a change that came after the last telling began and before this one ended its turn
      if (again) void push();
    });
    return running;
  }
  return {
    push,
    /**
     * Tells this Mac's own Host again once `work` settles (a key rotation switches this app's key: the Host must know the new one, or "off" would keep this app out), and answers what `work` answered.
     * @template T @param {Promise<T>} work @returns {Promise<T>}
     */
    after: (work) => work.finally(() => void push()),
    /**
     * A machine-list snapshot: this Mac's Host that comes to answer (the first look included) is told, after the snapshot's own turn (the list may still be being made). From then on every change of the switch is told too.
     * @param {{ machines: { id: string, status: string }[] }} snapshot
     */
    rows(snapshot) {
      const status = snapshot.machines.find((m) => m.id === LOCAL_HOST_ID)?.status;
      const was = up;
      up = !!status && status !== 'offline';
      if (!up || was) return;
      unsubscribe ??= consent()?.onChange(() => void push()) ?? null;
      queueMicrotask(() => void push());
    },
    /** Tells this Mac's own Host the switch and this app's key at `socketPath` now, before this app pairs with it; a telling that fails is reported (the pairing then says why). @param {string} socketPath */
    async beforePair(socketPath) {
      try {
        await tell(socketPath, consent()?.enabled() === true, machines()?.selfFingerprint() ?? '');
      } catch (error) {
        report(error);
      }
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

module.exports = { createAllowConnections, tellHost };
