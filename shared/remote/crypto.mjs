// Mobile Remote's cryptography over plain Uint8Array and an injected primitive set (electron/platform/sodiumPrimitives.cjs on the Mac; react-native-libsodium on the phone), so both ends run this one file against shared/remote/vectors.json: X25519 root key, HKDF-SHA256 per-direction keys, a counter-based symmetric ratchet, XChaCha20-Poly1305 sealing with the header as AAD, strictly increasing counters, and the pairing proof, transcript and safety number.
import { headerAad, toBase64, utf8 } from './envelope.mjs';

/**
 * The primitives this file needs; all keys, nonces and boxes are Uint8Array.
 * @typedef {object} Primitives
 * @property {(n: number) => Uint8Array} randomBytes
 * @property {(data: Uint8Array) => Uint8Array} sha256
 * @property {(key: Uint8Array, data: Uint8Array) => Uint8Array} hmacSha256
 * @property {(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array) => Uint8Array} aeadSeal XChaCha20-Poly1305 (IETF)
 * @property {(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => Uint8Array | null} aeadOpen null on a failed tag
 * @property {(sk: Uint8Array, pk: Uint8Array) => Uint8Array} x25519
 * @property {(sk: Uint8Array) => Uint8Array} x25519Base
 * @property {() => { pk: Uint8Array, sk: Uint8Array }} edKeypair
 * @property {(sk: Uint8Array, msg: Uint8Array) => Uint8Array} edSign
 * @property {(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean} edVerify
 */

export const NONCE_BYTES = 24;
/** The most counters a receiver walks over for one frame (frames lost on the way); more closes the pair's session. */
export const MAX_SKIP = 4096;
/** The most counters a receiver walks when it has asked to catch up after a gap: still bounded, and the frame must open under the pair's own chain, so the walk adds no trust. */
export const CATCH_UP_SKIP = 1 << 17;
/** The phone's own bound: a hash step costs it about 230 µs (measured on an iPhone, Dev build: 120000 steps took 27 s), so 32768 is about 7 s; further than that it says so and offers Pair again. */
export const PHONE_CATCH_UP_SKIP = 1 << 15;
const LABEL = 'mopilot-remote-v1';

export class RemoteCryptoError extends Error {
  /** @param {'auth' | 'replay' | 'rewind' | 'gap' | 'lost' | 'header' | 'state'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const concat = (/** @type {Uint8Array[]} */ ...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

/** Equal contents, without stopping at the first difference. @param {Uint8Array} a @param {Uint8Array} b */
export function sameBytes(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

/** @param {Primitives} p */
export function createCrypto(p) {
  /** HKDF-SHA256 (RFC 5869) @param {Uint8Array} salt @param {Uint8Array} ikm @param {string} info @param {number} [len] */
  const hkdf = (salt, ikm, info, len = 32) => {
    const prk = p.hmacSha256(salt, ikm);
    /** @type {Uint8Array} */
    let t = new Uint8Array(0);
    const out = [];
    for (let i = 1; out.length * 32 < len; i++) {
      t = p.hmacSha256(prk, concat(t, utf8(info), Uint8Array.of(i)));
      out.push(t);
    }
    return concat(...out).slice(0, len);
  };

  /**
   * The root key of a pair: X25519 between the two identity keys and X25519 between two ephemeral keys made for this pairing
   * (deleted once the root exists), bound to both device ids and the pair id. The ephemeral half is why a later leak of an
   * identity key opens nothing recorded, and why pairing the same two devices again gives a new root. Both ends pass their own
   * secret keys and the other's public keys, static first.
   * @param {Uint8Array} ownSk @param {Uint8Array} peerPk @param {Uint8Array} ownEphSk @param {Uint8Array} peerEphPk
   * @param {string} macId @param {string} phoneId @param {string} pairId
   */
  function deriveRoot(ownSk, peerPk, ownEphSk, peerEphPk, macId, phoneId, pairId) {
    const fixed = p.x25519(ownSk, peerPk);
    const fresh = p.x25519(ownEphSk, peerEphPk);
    // a low-order public key makes the shared secret all zeros: no secret went into the root
    if (fixed.every((b) => b === 0) || fresh.every((b) => b === 0)) throw new RemoteCryptoError('auth', 'a public key of low order');
    return hkdf(utf8(LABEL), concat(fixed, fresh), `root|2|${macId}|${phoneId}|${pairId}`);
  }

  /** The chain a direction starts from. @param {Uint8Array} root @param {'p2m' | 'm2p'} dir */
  const dirKey = (root, dir) => hkdf(utf8(LABEL), root, `dir|${dir}`);

  /** The chain `n` counters on, without the message keys nobody reads: what a receiver walks to reach a frame. @param {Uint8Array} chain @param {number} n */
  const advance = (chain, n) => {
    let c = chain;
    for (let i = 0; i < n; i++) c = p.hmacSha256(c, Uint8Array.of(2));
    return c;
  };

  /** One step of the ratchet: this counter's message key, and the chain for the next. @param {Uint8Array} chain */
  const step = (chain) => ({ key: p.hmacSha256(chain, Uint8Array.of(1)), next: p.hmacSha256(chain, Uint8Array.of(2)) });

  /**
   * Seals messages in one direction of one pair. `ctr` is the last counter used; `chain` makes the next one's key.
   * @param {{ pair: string, dir: 'p2m' | 'm2p', chain: Uint8Array, ctr?: number }} s
   */
  function createSender({ pair, dir, chain, ctr = 0 }) {
    let state = { chain, ctr };
    return {
      /** The sealed frame for `plain` (a nonce can be forced for vectors). @param {Uint8Array} plain @param {Uint8Array} [nonce] */
      seal(plain, nonce = p.randomBytes(NONCE_BYTES)) {
        const next = state.ctr + 1;
        const { key, next: chainNext } = step(state.chain);
        const box = p.aeadSeal(key, nonce, plain, headerAad(pair, dir, next));
        state = { chain: chainNext, ctr: next };
        return { pair, dir, ctr: next, nonce, box };
      },
      state: () => ({ ctr: state.ctr, chain: state.chain }),
      /** The state `n` counters on, for a checkpoint a crash can resume from without ever reusing a counter. @param {number} n */
      peek(n) {
        let c = state.chain;
        for (let i = 0; i < n; i++) c = step(c).next;
        return { ctr: state.ctr + n, chain: c };
      },
    };
  }

  /**
   * Opens messages of one direction of one pair. A counter must be above every accepted one; frames lost before it are skipped
   * (their keys are gone with them). A frame that fails its tag changes nothing, so a forged one can't move the ratchet.
   * @param {{ pair: string, dir: 'p2m' | 'm2p', chain: Uint8Array, ctr?: number }} s
   */
  function createReceiver({ pair, dir, chain, ctr = 0 }) {
    let state = { chain, ctr };
    return {
      /** @param {{ pair: string, dir: string, ctr: number, nonce: Uint8Array, box: Uint8Array }} f @param {{ maxSkip?: number }} [opts] `maxSkip`: the walk allowed past the saved counter (default MAX_SKIP) */
      open(f, { maxSkip = MAX_SKIP } = {}) {
        if (f.pair !== pair || f.dir !== dir) throw new RemoteCryptoError('header', 'the frame is for another pair or direction');
        if (f.ctr === state.ctr) throw new RemoteCryptoError('replay', 'the counter was seen');
        if (f.ctr < state.ctr) throw new RemoteCryptoError('rewind', 'the counter went back');
        if (f.ctr - state.ctr > maxSkip) throw new RemoteCryptoError('gap', 'too many frames are missing');
        const { key, next } = step(advance(state.chain, f.ctr - state.ctr - 1));
        const plain = p.aeadOpen(key, f.nonce, f.box, headerAad(pair, dir, f.ctr));
        if (!plain) throw new RemoteCryptoError('auth', 'the frame does not open');
        state = { chain: next, ctr: f.ctr };
        return plain;
      },
      state: () => ({ ctr: state.ctr, chain: state.chain }),
    };
  }

  /**
   * The transcript of a pairing (version 3): a hash over everything either end contributed, so the number the people compare covers
   * the Mac's and the phone's ids, identity keys, Ed25519 keys and ephemeral keys and the pair id (which the one-time code names). Fields are
   * length-prefixed, in fixed roles (the Mac's, then the phone's), under a label of its own. Both ends know every field before the Mac
   * asks to confirm: the QR carries the Mac's half and the hello the phone's.
   * @param {{ macId: string, phoneId: string, pairId: string, macPub: Uint8Array, phonePub: Uint8Array, macEdPub: Uint8Array, phoneEdPub: Uint8Array, macEphPub: Uint8Array, phoneEphPub: Uint8Array }} t
   */
  function pairTranscript(t) {
    const key = (/** @type {Uint8Array} */ k) => {
      if (k.length !== 32) throw new RemoteCryptoError('state', 'a pairing key is not 32 bytes');
      return k;
    };
    const field = (/** @type {Uint8Array} */ b) => concat(Uint8Array.of(b.length >> 8, b.length & 255), b);
    return p.sha256(
      concat(
        utf8(`${LABEL}|transcript|3|`),
        ...[
          utf8(t.macId),
          utf8(t.phoneId),
          utf8(t.pairId),
          key(t.macPub),
          key(t.phonePub),
          key(t.macEdPub),
          key(t.phoneEdPub),
          key(t.macEphPub),
          key(t.phoneEphPub),
        ].map(field),
      ),
    );
  }

  /** What both ends show to be sure they pair with each other: twenty digits (about 66 bits) of a hash of the pairing transcript, five groups of four. @param {Uint8Array} transcript */
  function safetyNumber(transcript) {
    const h = p.sha256(concat(utf8(`${LABEL}|safety|3|`), transcript));
    let digits = '';
    // five bytes (below 2^53) per group keeps the remainder's bias near 10^-8
    for (let g = 0; g < 5; g++) {
      const o = g * 5;
      const n = h[o] * 2 ** 32 + (((h[o + 1] << 24) | (h[o + 2] << 16) | (h[o + 3] << 8) | h[o + 4]) >>> 0);
      digits += String(n % 10_000).padStart(4, '0');
    }
    return digits;
  }

  /** The proof that a phone saw the QR: HMAC of the one-time code over both public keys. */
  const pairProof = (/** @type {Uint8Array} */ code, /** @type {Uint8Array} */ macPub, /** @type {Uint8Array} */ phonePub) =>
    p.hmacSha256(code, concat(utf8(`${LABEL}|proof|`), macPub, phonePub));

  /** The key of the hello exchange (the pair request and its answer): the DH of the two keys, bound to the one-time code. */
  const helloKey = (/** @type {Uint8Array} */ ownSk, /** @type {Uint8Array} */ peerPk, /** @type {Uint8Array} */ code) =>
    hkdf(code, p.x25519(ownSk, peerPk), 'hello');

  /** The id of a pair, from the one-time code both ends hold: the relay learns it when the Mac registers the pair, before any phone joins. */
  const pairId = (/** @type {Uint8Array} */ code) =>
    `p_${toBase64(p.sha256(concat(utf8(`${LABEL}|pair|`), code)).slice(0, 16))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;

  const helloAad = (/** @type {string} */ pair, /** @type {'p2m' | 'm2p'} */ dir) => utf8(`${LABEL}|hello|${pair}|${dir}`);

  /**
   * The phone's pair request as a frame (counter 0, which no session frame uses): the box is the phone's public key, in the
   * clear because the Mac needs it to make the hello key, then the request sealed under that key.
   * @param {string} pair @param {Uint8Array} key @param {Uint8Array} phonePub @param {Uint8Array} plain @param {Uint8Array} [nonce]
   */
  function helloFrame(pair, key, phonePub, plain, nonce = p.randomBytes(NONCE_BYTES)) {
    return {
      pair,
      dir: /** @type {const} */ ('p2m'),
      ctr: 0,
      nonce,
      box: concat(phonePub, p.aeadSeal(key, nonce, plain, helloAad(pair, 'p2m'))),
    };
  }

  /** The phone's public key out of a hello frame, or null when the box is too short to hold one. @param {{ box: Uint8Array }} f */
  const helloPub = (f) => (f.box.length > 32 ? f.box.slice(0, 32) : null);

  /** The request inside a hello frame, or null when the key doesn't open it. @param {Uint8Array} key @param {{ pair: string, nonce: Uint8Array, box: Uint8Array }} f */
  const openHelloFrame = (key, f) => p.aeadOpen(key, f.nonce, f.box.slice(32), helloAad(f.pair, 'p2m'));

  /** The Mac's answer to a hello, a frame of counter 0 in the other direction. @param {string} pair @param {Uint8Array} key @param {Uint8Array} plain @param {Uint8Array} [nonce] */
  function replyFrame(pair, key, plain, nonce = p.randomBytes(NONCE_BYTES)) {
    return {
      pair,
      dir: /** @type {const} */ ('m2p'),
      ctr: /** @type {0} */ (0),
      nonce,
      box: p.aeadSeal(key, nonce, plain, helloAad(pair, 'm2p')),
    };
  }

  /** @param {Uint8Array} key @param {{ pair: string, nonce: Uint8Array, box: Uint8Array }} f */
  const openReplyFrame = (key, f) => p.aeadOpen(key, f.nonce, f.box, helloAad(f.pair, 'm2p'));

  return {
    hkdf,
    deriveRoot,
    dirKey,
    createSender,
    createReceiver,
    advance,
    pairTranscript,
    safetyNumber,
    pairProof,
    helloKey,
    pairId,
    helloFrame,
    helloPub,
    openHelloFrame,
    replyFrame,
    openReplyFrame,
    prim: p,
  };
}

/**
 * The chain a receiver reaches by walking forward from its saved state, with the work bounded per saved counter instead of per time. The
 * walker caches the chain at every `stride` counters past the base it walks from, and one more point, the furthest target it walked to (the
 * tail, replaced only by a further one); a later walk resumes from the largest cached point at or below its target. Cached values are only
 * ever derived from the saved state, so they are the true chain: a frame with a forged counter can only make later real frames cheaper, never
 * change what they open under. Frames repeating one target, or only going further, cost at most `cap` steps plus one `stride` in all; a
 * target below the tail resumes from the aligned point under it, at most `stride` steps for that frame. The cache is dropped whenever the
 * saved state (the counter or the chain bytes of `base`) changes. `yieldFn` runs every `chunk` steps (default `stride`): a caller whose steps
 * are slow yields more often than it spaces its checkpoints.
 * @param {(chain: Uint8Array, n: number) => Uint8Array} advance createCrypto's `advance`
 * @param {{ stride?: number, cap?: number, chunk?: number }} [o]
 */
export function createWalker(advance, { stride = 1024, cap = CATCH_UP_SKIP, chunk = stride } = {}) {
  /**
   * The cache of one saved base, replaced (never edited) when the base changes, so a walk that is yielding keeps the one it began with.
   * @type {{ ctr: number, chain: Uint8Array, points: Map<number, Uint8Array>, tail: { ctr: number, chain: Uint8Array } | null } | null}
   */
  let cache = null;
  const same = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    /**
     * Drops every cached point and the base: called once a frame opened and was saved, because a chain value at counter k derives every later
     * key, so nothing at or below the new saved counter may stay in memory. Points are kept only for counters ahead of the saved state.
     */
    reset() {
      cache = null;
    },
    /** The counters of the cached points (the base, every stride and the tail), ascending; for tests. @returns {number[]} */
    points() {
      return cache ? [...cache.points.keys(), ...(cache.tail ? [cache.tail.ctr] : [])].sort((a, b) => a - b) : [];
    },
    /**
     * The chain after `targetCtr` counters (the one that makes counter `targetCtr + 1`'s key), or null when the target is behind the base or
     * more than `cap` past it, or `alive` turned false while walking. `yieldFn` runs between chunks of at most `stride` steps.
     * @param {{ ctr: number, chain: Uint8Array }} base
     * @param {number} targetCtr
     * @param {{ yieldFn?: () => Promise<void>, alive?: () => boolean }} [o]
     * @returns {Promise<Uint8Array | null>}
     */
    async walkTo(base, targetCtr, { yieldFn, alive } = {}) {
      if (targetCtr < base.ctr || targetCtr - base.ctr > cap) return null;
      if (!cache || cache.ctr !== base.ctr || !same(cache.chain, base.chain))
        cache = { ctr: base.ctr, chain: base.chain, points: new Map([[base.ctr, base.chain]]), tail: null };
      const mine = cache;
      let at = base.ctr;
      for (const k of mine.points.keys()) if (k <= targetCtr && k > at) at = k;
      let chain = /** @type {Uint8Array} */ (mine.points.get(at));
      if (mine.tail && mine.tail.ctr <= targetCtr && mine.tail.ctr > at) ({ ctr: at, chain } = mine.tail);
      while (at < targetCtr) {
        if (alive && !alive()) return null;
        const next = Math.min(targetCtr, at + chunk, base.ctr + (Math.floor((at - base.ctr) / stride) + 1) * stride);
        chain = advance(chain, next - at);
        at = next;
        if ((at - base.ctr) % stride === 0) mine.points.set(at, chain);
        if (yieldFn) await yieldFn();
      }
      if (!mine.points.has(at) && (!mine.tail || at > mine.tail.ctr)) mine.tail = { ctr: at, chain };
      return chain;
    },
  };
}
