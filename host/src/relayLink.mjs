// The Host's way in through the relay (#2709): for each app that enrolled it (`host.relayEnroll`, over the paired connection), an
// outbound WebSocket to that relay with the credential the app issued, and the encrypted session of shared/host/relaySession.mjs
// on it. Every stream the app opens is piped into this Host's own unix socket, so a connection through the relay is served exactly
// like one through an SSH tunnel (pairing auth, epochs, the ledger, the stream). Enrollments live in `<config dir>/relay.json`
// (0600; the credential and the pair root); a relay that closes with 4403 (the app removed this machine) deletes its enrollment.
// A controller removed here keeps its link as a tombstone (relayTombstone.mjs) until the other Mac removes the pair, or for TOMBSTONE_MS.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCrypto } from '../../shared/remote/crypto.mjs';
import { fromBase64, toBase64 } from '../../shared/remote/envelope.mjs';
import { createNodePrimitives } from '../../shared/remote/nodePrimitives.mjs';
import { createRelaySession, pipeSocket } from '../../shared/host/relaySession.mjs';
import { SWEEP_MS, expired, refuseStream, staleTombstones } from './relayTombstone.mjs';

const require = createRequire(import.meta.url);
const { RelayClient } = require('../../electron/remote/relayClient.cjs');

/** The relay id of the app's side of every enrollment's pair (shared/remote/crypto.mjs deriveRoot binds both ids). */
export const APP_ID = 'app';

/** @typedef {{ relayUrl: string, hostId: string, secret: string, pairId: string, root: string, client?: string, kind?: 'controller', retiredAt?: number }} Enrollment `client`: the fingerprint of the phone this enrollment belongs to (P2); absent for the Mac app's own. `kind`: 'controller' for a link a Mac paired by code brought. `retiredAt`: when its controller was removed (a tombstone) */

/** Whether a link is a controller's (made by pairing by code), so removing a controller may retire it: never the Mac app's own or a phone's. @param {Enrollment} e */
const controllerOwned = (e) => e.kind === 'controller' && e.client === undefined;

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

/** Whether the enrollments file can be told apart from a Host that has none: absent, or a readable file of the known shape. An unreadable one hides what is enrolled, so a check that an id is not taken cannot pass on it. @param {string} configDir */
function enrollmentsKnown(configDir) {
  try {
    return Array.isArray(JSON.parse(fs.readFileSync(fileOf(configDir), 'utf8'))?.links);
  } catch (e) {
    return /** @type {any} */ (e).code === 'ENOENT';
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

/** Makes enrollments tombstones by Host id (a removed controller's link answers only that it was removed), for a command that runs while no Host is serving (a Host that is running reads them on its next start); an unreadable file is left alone and reported by the throw. @param {string} configDir @param {string[]} hostIds @param {number} now @returns {number} how many became tombstones */
export function retireEnrollments(configDir, hostIds, now) {
  if (!enrollmentsKnown(configDir)) throw new Error(`The relay links in ${fileOf(configDir)} cannot be read.`);
  const all = readEnrollments(configDir);
  const hit = all.filter((e) => hostIds.includes(e.hostId) && e.retiredAt === undefined && controllerOwned(e));
  if (hit.length)
    writeEnrollments(
      configDir,
      all.map((e) => (hit.includes(e) ? { ...e, retiredAt: now } : e)),
    );
  return hit.length;
}

/**
 * @param {object} o
 * @param {string} o.configDir
 * @param {string} o.socketPath this Host's own socket, which every stream is piped into
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 * @param {(url: string, headers: Record<string, string>) => any} [o.createSocket] a WebSocket-shaped socket (Node's own by default)
 * @param {(socketPath: string) => import('node:net').Socket} [o.connectLocal]
 * @param {(message: string) => void} [o.report]
 * @param {() => number} [o.now] @param {(fn: () => void, ms: number) => () => void} [o.every] a repeating timer that does not keep the process up; returns the way to stop it
 */
export function createRelayLinks({
  configDir,
  socketPath,
  prim = createNodePrimitives(),
  createSocket = (url, headers) => new /** @type {any} */ (globalThis.WebSocket)(url, { headers }),
  connectLocal = (p) => net.connect(p),
  report = () => undefined,
  now = Date.now,
  every = (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return () => clearInterval(t);
  },
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
      onStream: (stream) => {
        if (enrollment.retiredAt === undefined) return pipeSocket(stream, connectLocal(socketPath));
        // a tombstone never reaches the Host's socket: each stream only hears that this client was removed, while it is in its time
        if (!expired(enrollment, now())) return refuseStream(stream);
        stream.reset();
        forgetLocal(enrollment.hostId, 'expired');
      },
    });
    relay.on('frame', (/** @type {any} */ f) => session.handleFrame(f));
    relay.on('event', (/** @type {any} */ e) => {
      // the app went, or came back on a new socket (its session is gone with the old one)
      if (e?.ev === 'peer') session.close(e.online ? 'The app reconnected.' : 'The app went away.');
      if (e?.ev === 'pair.removed') forgetLocal(enrollment.hostId, 'pair_removed');
    });
    relay.on('error', (/** @type {any} */ e) => {
      if (e?.code === 'peer_offline') session.close('The app went away.');
    });
    relay.on('state', (/** @type {string} */ s) => {
      if (s !== 'open') session.close('The relay connection ended.');
      // the app removed this machine: its credential is gone for good
      if (s === 'revoked') forgetLocal(enrollment.hostId, 'revoked');
    });
    links.set(enrollment.hostId, { enrollment, relay, session });
    relay.start();
  }

  /** @type {(e: { kind: 'link.retired' | 'link.forgotten', outcome: string }) => void} */
  let tell = () => undefined;
  /** @param {string} hostId @param {string} [outcome] why it goes, for a tombstone's audit line */
  function forgetLocal(hostId, outcome = 'forgotten') {
    const link = links.get(hostId);
    links.delete(hostId);
    link?.session.close('This machine was removed from the app.');
    link?.relay.stop();
    const all = read();
    // a file that cannot be read is left as it is: writing what was read (nothing) would drop every other link
    if (enrollmentsKnown(configDir)) write(all.filter((e) => e.hostId !== hostId));
    if ((link?.enrollment ?? all.find((e) => e.hostId === hostId))?.retiredAt !== undefined) tell({ kind: 'link.forgotten', outcome });
    return !!link;
  }

  /** Forgets every tombstone past its time, and the oldest past the most kept. */
  function sweep() {
    for (const t of staleTombstones(read(), now())) forgetLocal(t.hostId, t.outcome);
  }
  /** @type {(() => void) | null} */
  let stopSweep = null;

  return {
    /** Opens a link for every enrollment kept (a tombstone past its time is forgotten instead), and looks for old tombstones now and then. */
    start() {
      sweep();
      for (const e of read()) if (!links.has(e.hostId)) open(e);
      stopSweep ??= every(sweep, SWEEP_MS);
    },
    /**
     * `host.relayEnroll`: keeps the app's credential and the pair root both ends derive from fresh X25519 keys of each (the
     * exchange rides the paired, authenticated Host connection), and opens the link. Enrolling the same Host id again replaces it.
     * `createOnly` (pairing by code, where the other Mac chose the host id): an id that is already enrolled is another client's link and is refused, never replaced.
     * @param {{ relayUrl: string, hostId: string, secret: string, pairId: string, appPub: string, appEphPub: string, client?: string }} p @param {{ createOnly?: boolean }} [o]
     */
    enroll(p, { createOnly = false } = {}) {
      if (closed) throw new Error('The Host is stopping.');
      if (createOnly && !enrollmentsKnown(configDir)) throw new Error('The relay links kept on this Host cannot be read.');
      if (createOnly && (links.has(p.hostId) || read().some((e) => e.hostId === p.hostId)))
        throw new Error('That relay link is already there.');
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
        ...(createOnly && { kind: /** @type {const} */ ('controller') }),
      };
      if (links.has(p.hostId)) forgetLocal(p.hostId);
      write([...read().filter((e) => e.hostId !== p.hostId), enrollment]);
      open(enrollment);
      return { hostPub: toBase64(prim.x25519Base(sk)), hostEphPub: toBase64(prim.x25519Base(ephSk)) };
    },
    /** `host.relayForget`: drops one enrollment (the app removed the machine while it could still reach it). @param {{ hostId: string }} p */
    forget: (p) => ({ removed: forgetLocal(p.hostId) }),
    /**
     * Its controller was removed here: the link becomes a tombstone (kept on disk, so a restart keeps it), and the session on it ends, so the other Mac's next connection hears the refusal. One already retired keeps its time. A link that is not a controller's (the Mac app's own, a phone's) is refused and left as it is.
     * @param {{ hostId: string }} p @returns {{ retired: boolean, refused?: 'not_controller' }}
     */
    retire({ hostId }) {
      // a file that cannot be read hides what is kept: nothing is made a tombstone or overwritten, and the reset stops on the throw
      if (!enrollmentsKnown(configDir)) throw new Error(`The relay links in ${fileOf(configDir)} cannot be read.`);
      const all = read();
      const kept = all.find((e) => e.hostId === hostId);
      // not on disk (never kept there): nothing can be kept as a tombstone, so a controller's link still open goes
      if (!kept) {
        const live = links.get(hostId);
        if (live && controllerOwned(live.enrollment)) forgetLocal(hostId);
        return { retired: false };
      }
      if (!controllerOwned(kept)) return { retired: false, refused: 'not_controller' };
      if (kept.retiredAt !== undefined) return { retired: true };
      const retiredAt = now();
      write(all.map((e) => (e === kept ? { ...e, retiredAt } : e)));
      const link = links.get(hostId);
      if (link) {
        link.enrollment.retiredAt = retiredAt;
        link.session.close('This client was removed.');
      }
      tell({ kind: 'link.retired', outcome: 'kept' });
      sweep();
      return { retired: true };
    },
    /**
     * The fallback when `retire` could not write (a file that cannot be read): the controller's open link refuses from now on in this process, nothing written, and that is told (`unsaved`).
     * @param {{ hostId: string }} p
     */
    retireLive({ hostId }) {
      const link = links.get(hostId);
      if (!link || !controllerOwned(link.enrollment)) return { retired: false };
      if (link.enrollment.retiredAt === undefined) {
        link.enrollment.retiredAt = now();
        link.session.close('This client was removed.');
        tell({ kind: 'link.retired', outcome: 'unsaved' });
      }
      return { retired: true };
    },
    /** Hear each tombstone made or forgotten (the Host's audit record). @param {typeof tell} fn */
    onTombstone(fn) {
      tell = fn;
    },
    /** `host.relayStatus`: each enrollment's relay and connection state, never its secret. */
    status: () => ({
      links: [...links.values()].map(({ enrollment, relay, session }) => ({
        hostId: enrollment.hostId,
        relayUrl: enrollment.relayUrl,
        relay: relay.state,
        ...(enrollment.client && { client: enrollment.client }),
        ...(enrollment.retiredAt !== undefined && { retired: true }),
        session: session.state,
      })),
    }),
    /** The phone enrollments (those that name a client): where a push goes. Never the Mac app's, which has no push token. @returns {{ hostId: string, pairId: string, root: Uint8Array }[]} */
    pushTargets: () =>
      [...links.values()]
        .filter((l) => l.enrollment.client && l.enrollment.retiredAt === undefined)
        .map((l) => ({ hostId: l.enrollment.hostId, pairId: l.enrollment.pairId, root: fromBase64(l.enrollment.root) })),
    /** One push request on that enrollment's own relay link (P4); resolves with the relay's status. @param {string} hostId @param {{ pair: string, kind: string, ref: string, sealed?: string, card?: string, sealedBody?: string, sealedStamp?: string }} req */
    push(hostId, req) {
      const link = links.get(hostId);
      return link ? link.relay.pushRequest(req) : Promise.reject(new Error('That enrollment is gone'));
    },
    close() {
      closed = true;
      stopSweep?.();
      for (const { relay, session } of links.values()) {
        session.close('The Host is stopping.');
        relay.stop();
      }
      links.clear();
    },
  };
}
