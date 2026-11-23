// Phone-side pairing coordinator: QR validation, authenticated hello and reply, and commit through an injected secure store.
import { createCrypto, sameBytes } from './crypto.mjs';
import { decodeFrame, fromBase64, fromUtf8, toBase64, toHex, toWire, utf8 } from './envelope.mjs';

/** @typedef {{ phoneId: string, x: { pk: Uint8Array, sk: Uint8Array }, ed: { pk: Uint8Array } }} PhoneIdentity */
/**
 * The store must protect identity and pair secrets in platform secure storage, serialize its own writes and commit a pair
 * atomically. A missing, unavailable, corrupt or failed store rejects; it must never fall back to plaintext.
 * savePair commits the pair and removes its pending record atomically. An unresolved pending record must survive restart.
 * claimPending atomically claims an empty slot across all instances and processes. markJoining, clearPrepared and
 * savePair are atomic conditional writes against the unique claim owner and expected phase; stale owners must fail.
 * @typedef {{ getIdentity: () => Promise<PhoneIdentity>, getPending: () => Promise<PendingPair | null>, claimPending: (pending: PendingPair) => Promise<boolean>, markJoining: (owner: string) => Promise<void>, clearPrepared: (owner: string) => Promise<void>, clearRefused: (owner: string) => Promise<void>, savePair: (owner: string, pair: PhonePair) => Promise<void> }} SecurePhoneStore
 * @typedef {{ owner: string, pairId: string, relay: string, phase: 'prepared' | 'joining' }} PendingPair
 * @typedef {{ pairId: string, macId: string, relay: string, macPub: string, macEdPub: string, tx: { ctr: number, chain: string }, rx: { ctr: number, chain: string } }} PhonePair
 * The transport authenticates the same phone device identity before join and rejects errors; send resolves only on its
 * defined relay acknowledgement, not merely on a local socket write. This is not an end-to-end delivery guarantee.
 * @typedef {{ join: (relay: string, pair: string) => Promise<void>, send: (frame: object) => Promise<void> }} PairTransport
 * @typedef {{ phase: 'starting' | 'waiting' | 'committing', qr: ReturnType<typeof parseQr>, ready: Promise<{ error?: unknown }>, retire: () => void, retired?: boolean, receiving?: boolean, identity?: PhoneIdentity, eph?: { sk: Uint8Array, pk: Uint8Array }, pair?: string, owner?: string, key?: Uint8Array }} Attempt
 */

/** What the relay answers when it did not let this phone join the pair: no join happened, so no cleanup is owed. */
const JOIN_REFUSED = /^relay: (forbidden|taken|expired|pair_expired|unknown_pair|already_joined)$/;

/** @param {unknown} value @param {number} length */
function bytes(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length / 3) * 4) throw new Error('invalid pairing data');
  const b = fromBase64(value);
  if (b.length !== length) throw new Error('invalid pairing data');
  return b;
}

/** @param {unknown} input @param {number} now @param {boolean} [allowInsecure] read a plain ws: relay as well (the build's trusted relay is one) */
function parseQr(input, now, allowInsecure = false) {
  if (typeof input === 'string') {
    if (input.length > 4096) throw new Error('invalid QR');
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error('invalid QR');
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid QR');
  const q = /** @type {Record<string, unknown>} */ (input);
  if (Number.isSafeInteger(q.v) && /** @type {number} */ (q.v) > 3) throw new Error('newer QR');
  // a computer from before the code was v3 cannot pair with this phone: say so, rather than that the code is unreadable
  if (Number.isSafeInteger(q.v) && /** @type {number} */ (q.v) < 3 && typeof q.macId === 'string') throw new Error('older QR');
  if (
    q.v !== 3 ||
    typeof q.macId !== 'string' ||
    !/^[A-Za-z0-9_-]{4,64}$/.test(q.macId) ||
    typeof q.relay !== 'string' ||
    q.relay.length > 2048 ||
    !Number.isSafeInteger(q.exp)
  )
    throw new Error('invalid QR');
  if (/** @type {number} */ (q.exp) <= now) throw new Error('expired QR');
  const url = new URL(q.relay);
  if ((url.protocol !== 'wss:' && !(allowInsecure && url.protocol === 'ws:')) || url.username || url.password || url.hash)
    throw new Error('invalid relay');
  return {
    macId: q.macId,
    relay: q.relay,
    exp: /** @type {number} */ (q.exp),
    macPub: bytes(q.macPub, 32),
    macEdPub: bytes(q.macEdPub, 32),
    macEphPub: bytes(q.macEphPub, 32),
    code: bytes(q.code, 32),
  };
}

/**
 * One coordinator owns one attempt. A second begin is refused until the first is retired; cancel invalidates pending
 * identity/join/send operations. During an atomic store commit cancellation is refused, so a completed write cannot be
 * reported as cancelled. No transport or secure-storage implementation is supplied by this module.
 * The relay URL must come from previously trusted configuration, including for a self-hosted relay; a QR cannot authorize
 * a new endpoint to receive account credentials. Compare the full normalized URL, including port, path and query.
 * @param {{ prim: import('./crypto.mjs').Primitives, store: SecurePhoneStore, transport: PairTransport, relayUrl: string, plainRelay?: boolean, now?: () => number }} o
 */
export function createPhonePairing(o) {
  const crypto = createCrypto(o.prim);
  const now = o.now ?? Date.now;
  /** @type {Attempt | null} */
  let current = null;
  const owns = (/** @type {Attempt} */ attempt) => {
    if (current !== attempt || attempt.retired) throw new Error('pairing cancelled');
  };
  return {
    async begin(/** @type {unknown} */ input, /** @type {string} */ name) {
      if (current) throw new Error('pairing busy');
      // plain ws: is read only when the build's dev host (a local, development-build-only relay) is the relay it trusts; a QR cannot lower it
      const qr = parseQr(input, now(), o.plainRelay === true && new URL(o.relayUrl).protocol === 'ws:');
      if (new URL(qr.relay).href !== new URL(o.relayUrl).href) throw new Error('untrusted relay');
      let ready = /** @type {() => void} */ (/** @type {unknown} */ (undefined));
      let failed = /** @type {(reason: unknown) => void} */ (/** @type {unknown} */ (undefined));
      /** @type {Promise<{ error?: unknown }>} */
      const started = new Promise((resolve) => {
        ready = () => resolve({});
        failed = (error) => resolve({ error });
      });
      const a = /** @type {Attempt} */ ({ phase: 'starting', qr, ready: started, retire: () => failed(new Error('pairing cancelled')) });
      current = a;
      try {
        if (await o.store.getPending()) throw new Error('pair cleanup required');
        owns(a);
        const identity = await o.store.getIdentity();
        owns(a);
        if (
          !/^[A-Za-z0-9_-]{4,64}$/.test(identity.phoneId) ||
          identity.x.pk.length !== 32 ||
          identity.x.sk.length !== 32 ||
          identity.ed.pk.length !== 32 ||
          !sameBytes(o.prim.x25519Base(identity.x.sk), identity.x.pk)
        )
          throw new Error('invalid identity');
        if (now() >= qr.exp) throw new Error('expired QR');
        const pair = crypto.pairId(qr.code);
        // an ephemeral key for this pairing alone: it lives in this attempt until the Mac's answer arrives, and is never stored
        const ephSk = o.prim.randomBytes(32);
        const eph = { sk: ephSk, pk: o.prim.x25519Base(ephSk) };
        a.eph = eph;
        // a Mac ephemeral key of low order would make the shared secret zero: refused before a number is shown
        try {
          o.prim.x25519(ephSk, qr.macEphPub);
        } catch {
          throw new Error('invalid pairing data');
        }
        const key = crypto.helloKey(identity.x.sk, qr.macPub, qr.code);
        const proof = crypto.pairProof(qr.code, qr.macPub, identity.x.pk);
        const hello = crypto.helloFrame(
          pair,
          key,
          identity.x.pk,
          utf8(
            JSON.stringify({
              v: 3,
              phoneId: identity.phoneId,
              name,
              edPub: toBase64(identity.ed.pk),
              proof: toBase64(proof),
              ephPub: toBase64(eph.pk),
            }),
          ),
        );
        const owner = toHex(o.prim.randomBytes(16));
        if (!(await o.store.claimPending({ owner, pairId: pair, relay: qr.relay, phase: 'prepared' })))
          throw new Error('pair cleanup required');
        if (a.retired) {
          await o.store.clearPrepared(owner);
          owns(a);
        }
        owns(a);
        await o.store.markJoining(owner);
        owns(a);
        try {
          await o.transport.join(qr.relay, pair);
        } catch (error) {
          if (error instanceof Error && JOIN_REFUSED.test(error.message)) await o.store.clearRefused(owner);
          throw error;
        }
        owns(a);
        if (now() >= qr.exp) throw new Error('expired QR');
        a.identity = identity;
        a.pair = pair;
        a.owner = owner;
        a.key = key;
        await o.transport.send(toWire(hello));
        owns(a);
        a.phase = 'waiting';
        ready();
        const transcript = crypto.pairTranscript({
          macId: qr.macId,
          phoneId: identity.phoneId,
          pairId: pair,
          macPub: qr.macPub,
          phonePub: identity.x.pk,
          macEdPub: qr.macEdPub,
          phoneEdPub: identity.ed.pk,
          macEphPub: qr.macEphPub,
          phoneEphPub: eph.pk,
        });
        return { pairId: pair, safetyNumber: crypto.safetyNumber(transcript) };
      } catch (error) {
        a.eph?.sk.fill(0);
        if (current === a) current = null;
        failed(error);
        throw error;
      }
    },
    cancel() {
      if (!current) return false;
      if (current.phase === 'committing') throw new Error('pairing commit in progress');
      current.retired = true;
      current.eph?.sk.fill(0);
      current.retire();
      if (current.phase === 'waiting') current = null;
      return true;
    },
    /** A pending record means relay and desktop cleanup may be required; it is never silently discarded (a join the relay refused leaves none). */
    pending: () => o.store.getPending(),
    /** A cancelled operation still awaiting a boundary remains visible and cannot be replaced. */
    status: () => (current ? (current.retired ? 'cancel-pending' : current.phase) : 'idle'),
    async finish(/** @type {string | object} */ wire) {
      const a = current;
      if (!a || a.phase === 'committing' || !a.identity || !a.pair || !a.owner || !a.key) throw new Error('no pending pairing');
      const f = decodeFrame(wire);
      if (f.pair !== a.pair || f.dir !== 'm2p' || f.ctr !== 0) throw new Error('invalid pairing reply');
      const plain = crypto.openReplyFrame(a.key, f);
      if (!plain) throw new Error('invalid pairing reply');
      const reply = JSON.parse(fromUtf8(plain));
      if (a.receiving) throw new Error('pairing reply busy');
      a.receiving = true;
      try {
        if (a.phase === 'starting') {
          const outcome = await a.ready;
          if ('error' in outcome) throw outcome.error;
          owns(a);
        }
        // made with the identity in begin(); the cast keeps the type check honest without a branch that cannot happen
        const eph = /** @type {{ sk: Uint8Array, pk: Uint8Array }} */ (a.eph);
        if (reply?.ok !== true || reply.pairId !== a.pair) {
          eph.sk.fill(0);
          current = null;
          throw new Error('pairing rejected');
        }
        let root;
        try {
          if (reply.v !== 3) throw new Error('invalid pairing data');
          root = crypto.deriveRoot(a.identity.x.sk, a.qr.macPub, eph.sk, a.qr.macEphPub, a.qr.macId, a.identity.phoneId, a.pair);
        } catch (error) {
          // an answer the Mac really sealed but that cannot be used ends this attempt: nothing else will come
          if (current === a) current = null;
          throw error;
        } finally {
          eph.sk.fill(0);
        }
        /** @type {PhonePair} */
        const pair = {
          pairId: a.pair,
          macId: a.qr.macId,
          relay: a.qr.relay,
          macPub: toBase64(a.qr.macPub),
          macEdPub: toBase64(a.qr.macEdPub),
          tx: { ctr: 0, chain: toHex(crypto.dirKey(root, 'p2m')) },
          rx: { ctr: 0, chain: toHex(crypto.dirKey(root, 'm2p')) },
        };
        a.phase = 'committing';
        try {
          await o.store.savePair(a.owner, pair);
        } finally {
          if (current === a) current = null;
        }
        return { pairId: pair.pairId, macId: pair.macId };
      } finally {
        a.receiving = false;
      }
    },
  };
}
