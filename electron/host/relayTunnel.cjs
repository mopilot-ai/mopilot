// A machine's tunnel through the relay (#2709), with the contract of sshTunnel.cjs: while a lease is held it listens on a local unix
// socket (in the owner-only tunnel folder) and pipes each connection into a stream of the encrypted session with the Host
// (shared/host/relaySession.mjs), carried on the host lane (relayLane.cjs). remote.cjs, the heartbeat and pairing auth connect to
// that socket exactly as to an SSH tunnel's. It is online while the session is open; it opens one whenever the lane is up and the
// Host is connected to the relay, and a session that ends (the Host left, a lost frame, no answer) closes every stream on it.
const { fs } = require('../platform/ports/fs.cjs');
const net = require('node:net');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { createRelaySession, pipeSocket } = require('../../shared/host/relaySession.mjs');
// the app's crypto runs in Electron, whose OpenSSL has no ChaCha20-Poly1305: sodium's (electron/platform/sodiumPrimitives.cjs) is the one that seals there
const { createSodiumPrimitives } = require('../platform/sodiumPrimitives.cjs');

/** How long to wait before opening a session again after one could not be opened. */
const RETRY_MS = 5000;

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./relayLane.cjs').createRelayLane>} o.lane
 * @param {{ pairId: string, root: Uint8Array }} o.enrollment
 * @param {string} o.localSocket where the tunnel listens while a lease is held
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 */
function createRelayTunnel({ lane, enrollment, localSocket, prim = createSodiumPrimitives() }) {
  /** @type {'online' | 'connecting' | 'offline'} */
  let state = 'offline';
  let reason = '';
  let refs = 0;
  /** @type {net.Server | null} */
  let server = null;
  /** @type {any} */
  let retry = null;
  let starting = false;
  /** @type {Set<(ok: boolean) => void>} */
  const waiting = new Set();
  /** @type {Set<(state: 'online' | 'connecting' | 'offline', reason: string) => void>} */
  const listeners = new Set();

  const session = createRelaySession({
    prim,
    root: enrollment.root,
    pair: enrollment.pairId,
    role: 'app',
    send: (f) => lane.send(f),
    onState: (_s, why) => update(why),
  });
  const offRoute = lane.route(enrollment.pairId, {
    onFrame: (f) => session.handleFrame(f),
    onPeer: (online) => {
      // the Host came (back) on a new socket: whatever session there was is gone on its side, so it is gone here too
      session.close(online ? 'The machine reconnected to the relay.' : 'The machine is not connected to the relay.');
      update();
    },
  });
  const offLane = lane.onChange(() => update());

  /** @param {'online' | 'connecting' | 'offline'} next @param {string} why */
  function setState(next, why) {
    if (next === state && why === reason) return;
    state = next;
    reason = why;
    if (next === 'online') for (const settle of [...waiting]) settle(true);
    for (const fn of [...listeners]) fn(next, why);
  }

  /** Works out the state from the lane, the Host's presence and the session, and opens a session when one can be. @param {string} [why] */
  function update(why = '') {
    if (refs === 0) return setState('offline', '');
    if (session.state === 'open') return setState('online', '');
    if (lane.state !== 'open') return setState('offline', 'The relay is not connected.');
    if (!lane.peerOnline(enrollment.pairId)) return setState('offline', 'The machine is not connected to the relay.');
    if (starting || retry) return setState(retry ? 'offline' : 'connecting', why || reason);
    // a session that fails while it starts calls back here: `starting` keeps that from starting another
    starting = true;
    setState('connecting', why);
    session.start().then(
      () => {
        starting = false;
        update();
      },
      (/** @type {Error} */ e) => {
        starting = false;
        // tried again after a pause; a change of the lane or the Host is seen then
        retry = clock.setTimeout(() => {
          retry = null;
          update();
        }, RETRY_MS);
        // released meanwhile: nothing to say (the release set it offline)
        if (refs) setState('offline', e.message);
      },
    );
  }

  function launch() {
    fs.rmSync(localSocket, { force: true });
    const s = net.createServer((local) => {
      if (session.state !== 'open') return void local.destroy();
      pipeSocket(session.openStream(), local);
    });
    s.on('error', (e) => noteIgnored('listen for a relay tunnel', e));
    s.listen(localSocket);
    server = s;
    lane.start();
    update();
  }

  function stop() {
    clock.clearTimeout(retry);
    retry = null;
    server?.close();
    server = null;
    fs.rmSync(localSocket, { force: true });
    session.close('The tunnel was closed.');
    setState('offline', '');
  }

  return {
    localSocket,
    kind: /** @type {const} */ ('relay'),
    /** The relay pair this tunnel carries. */
    pairId: enrollment.pairId,
    get state() {
      return state;
    },
    get reason() {
      return reason;
    },
    /** The round trip through the relay last measured, or null. */
    get latencyMs() {
      return session.latencyMs;
    },
    /** Whether a connection could go through the relay now (the lane is up and the Host is on it). */
    available: () => lane.state === 'open' && lane.peerOnline(enrollment.pairId),
    /** @param {(state: 'online' | 'connecting' | 'offline', reason: string) => void} fn */
    onState(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    acquire() {
      refs++;
      let released = false;
      let settle = /** @type {(ok: boolean) => void} */ (/** @type {any} */ (null));
      const ready = new Promise((resolve) => {
        settle = (ok) => (waiting.delete(settle), resolve(ok));
      });
      waiting.add(settle);
      if (refs === 1) launch();
      else if (state === 'online') settle(true);
      return {
        socketPath: localSocket,
        ready,
        release() {
          if (released) return;
          released = true;
          settle(false);
          if (--refs === 0) stop();
        },
      };
    },
    /** The connection through the tunnel broke: the session goes, and a new one is opened. @param {string} why */
    fail(why) {
      if (session.state !== 'closed') session.close(why);
    },
    close() {
      refs = 0;
      for (const settle of [...waiting]) settle(false);
      stop();
    },
    /** For good: the machine was removed. */
    dispose() {
      this.close();
      offRoute();
      offLane();
    },
    get leases() {
      return refs;
    },
  };
}

module.exports = { createRelayTunnel, RETRY_MS };
