// The Host's way in through the relay (#2709): for each app that enrolled it (`host.relayEnroll`, over the paired connection), an
// outbound WebSocket to that relay with the credential the app issued, and the encrypted session of shared/host/relaySession.mjs
// on it. Every stream the app opens is piped into this Host's own unix socket, so a connection through the relay is served exactly
// like one through an SSH tunnel (pairing auth, epochs, the ledger, the stream). Enrollments live in `<config dir>/relay.json`
// (0600; the credential and the pair root); a relay that closes with 4403 (the app removed this machine) deletes its enrollment.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../../shared/remote/envelope.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { createRelaySession, pipeSocket } from '../../shared/host/relaySession.mjs';

const require = createRequire(import.meta.url);
const { RelayClient } = require('../../electron/remote/relayClient.cjs');

/** The relay id of the app's side of every enrollment's pair (shared/remote/crypto.mjs deriveRoot binds both ids). */
export const APP_ID = 'app';

/** @typedef {{ relayUrl: string, hostId: string, secret: string, pairId: string, root: string, client?: string }} Enrollment `client`: the fingerprint of the phone this enrollment belongs to (P2); absent for the Mac app's own */

/** @param {string} configDir */
const fileOf = (configDir) => path.join(configDir, 'relay.json');

/** The enrollments kept on this machine; an unreadable file is reported and read as none. @param {string} configDir @param {(m: string) => void} [report] @returns {Enrollment[]} */
function readEnrollments(configDir, report = () => undefined) {
  try {
    const all = JSON.parse(fs.readFileSync(fileOf(configDir), 'utf8'));
    return Array.isArray(all?.links) ? all.links : [];
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') report(`relay: the enrollments in ${fileOf(configDir)} cannot be read`);
    return [];
  }
}

/** Writes the enrollments whole (0600). @param {string} configDir @param {Enrollment[]} all */
function writeEnrollments(configDir, all) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(configDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, links: all }), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(configDir));
}

/** Keeps one enrollment (replacing one of the same Host id), for a running Host's links to open on their next start. @param {string} configDir @param {Enrollment} e */
export function keepEnrollment(configDir, e) {
  writeEnrollments(configDir, [...readEnrollments(configDir).filter((x) => x.hostId !== e.hostId), e]);
}

/**
 * @param {object} o
 * @param {string} o.configDir
 * @param {string} o.socketPath this Host's own socket, which every stream is piped into
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 * @param {(url: string, headers: Record<string, string>) => any} [o.createSocket] a WebSocket-shaped socket (Node's own by default)
 * @param {(socketPath: string) => import('node:net').Socket} [o.connectLocal]
 * @param {(message: string) => void} [o.report]
 */
export function createRelayLinks({
  configDir,
  socketPath,
  prim = createNodePrimitives(),
  createSocket = (url, headers) => new /** @type {any} */ (globalThis.WebSocket)(url, { headers }),
  connectLocal = (p) => net.connect(p),
  report = () => undefined,
}) {
  const c = createCrypto(prim);
  /** @type {Map<string, { enrollment: Enrollment, relay: any, session: ReturnType<typeof createRelaySession> }>} */
  const links = new Map();
  let closed = false;

  const read = () => readEnrollments(configDir, report);
  const write = (/** @type {Enrollment[]} */ all) => writeEnrollments(configDir, all);

  /** @param {Enrollment} enrollment */
  function open(enrollment) {
    const relay = new RelayClient({
      url: () => enrollment.relayUrl,
      getToken: async () => `mh1.${enrollment.hostId}.${enrollment.secret}`,
      createSocket,
    });
    const session = createRelaySession({
      prim,
      root: fromBase64(enrollment.root),
      pair: enrollment.pairId,
      role: 'host',
      send: (f) => relay.state === 'open' && relay.sendFrame(f) === 'sent',
      onStream: (stream) => pipeSocket(stream, connectLocal(socketPath)),
    });
    relay.on('frame', (/** @type {any} */ f) => session.handleFrame(f));
    relay.on('event', (/** @type {any} */ e) => {
      // the app went, or came back on a new socket (its session is gone with the old one)
      if (e?.ev === 'peer') session.close(e.online ? 'The app reconnected.' : 'The app went away.');
      if (e?.ev === 'pair.removed') forgetLocal(enrollment.hostId);
    });
    relay.on('error', (/** @type {any} */ e) => {
      if (e?.code === 'peer_offline') session.close('The app went away.');
    });
    relay.on('state', (/** @type {string} */ s) => {
      if (s !== 'open') session.close('The relay connection ended.');
      // the app removed this machine: its credential is gone for good
      if (s === 'revoked') forgetLocal(enrollment.hostId);
    });
    links.set(enrollment.hostId, { enrollment, relay, session });
    relay.start();
  }

  /** @param {string} hostId */
  function forgetLocal(hostId) {
    const link = links.get(hostId);
    links.delete(hostId);
    link?.session.close('This machine was removed from the app.');
    link?.relay.stop();
    const left = read().filter((e) => e.hostId !== hostId);
    write(left);
    return !!link;
  }

  return {
    /** Opens a link for every enrollment kept. */
    start() {
      for (const e of read()) if (!links.has(e.hostId)) open(e);
    },
    /**
     * `host.relayEnroll`: keeps the app's credential and the pair root both ends derive from fresh X25519 keys of each (the
     * exchange rides the paired, authenticated Host connection), and opens the link. Enrolling the same Host id again replaces it.
     * @param {{ relayUrl: string, hostId: string, secret: string, pairId: string, appPub: string, appEphPub: string, client?: string }} p
     */
    enroll(p) {
      if (closed) throw new Error('The Host is stopping.');
      const sk = prim.randomBytes(32);
      const ephSk = prim.randomBytes(32);
      const root = c.deriveRoot(sk, fromBase64(p.appPub), ephSk, fromBase64(p.appEphPub), APP_ID, p.hostId, p.pairId);
      const enrollment = {
        relayUrl: p.relayUrl,
        hostId: p.hostId,
        secret: p.secret,
        pairId: p.pairId,
        root: toBase64(root),
        ...(p.client && { client: p.client }),
      };
      if (links.has(p.hostId)) forgetLocal(p.hostId);
      write([...read().filter((e) => e.hostId !== p.hostId), enrollment]);
      open(enrollment);
      return { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(ephSk)) };
    },
    /** `host.relayForget`: drops one enrollment (the app removed the machine while it could still reach it). @param {{ hostId: string }} p */
    forget: (p) => ({ removed: forgetLocal(p.hostId) }),
    /** `host.relayStatus`: each enrollment's relay and connection state, never its secret. */
    status: () => ({
      links: [...links.values()].map(({ enrollment, relay, session }) => ({
        hostId: enrollment.hostId,
        relayUrl: enrollment.relayUrl,
        relay: relay.state,
        ...(enrollment.client && { client: enrollment.client }),
        session: session.state,
      })),
    }),
    /** The phone enrollments (those that name a client): where a push goes. Never the Mac app's, which has no push token. @returns {{ hostId: string, pairId: string, root: Uint8Array }[]} */
    pushTargets: () =>
      [...links.values()]
        .filter((l) => l.enrollment.client)
        .map((l) => ({ hostId: l.enrollment.hostId, pairId: l.enrollment.pairId, root: fromBase64(l.enrollment.root) })),
    /** One push request on that enrollment's own relay link (P4); resolves with the relay's status. @param {string} hostId @param {{ pair: string, kind: string, ref: string, sealed?: string, card?: string, sealedBody?: string, sealedStamp?: string }} req */
    push(hostId, req) {
      const link = links.get(hostId);
      return link ? link.relay.pushRequest(req) : Promise.reject(new Error('That enrollment is gone'));
    },
    close() {
      closed = true;
      for (const { relay, session } of links.values()) {
        session.close('The Host is stopping.');
        relay.stop();
      }
      links.clear();
    },
  };
}
