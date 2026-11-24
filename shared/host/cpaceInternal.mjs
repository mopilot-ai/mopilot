// The inside of CPace (shared/host/cpace.mjs is its only door): the balanced password-authenticated key exchange, cipher suite CPACE-RISTR255-SHA512 in the initiator-responder setting, exactly as specified in draft-irtf-cfrg-cpace-20 (IRTF CFRG, March 2026): sections 6 (protocol), 7.1 and 7.3 (generator, ristretto255), 9.4 (key confirmation) and appendices A.1 to A.2 (string functions). It reproduces the draft's published test vectors (appendix B.3) byte for byte (tests/cpace.test.ts). One small pure module (this one, and the thin public wrapper that has no test-only options and no function that returns K): no I/O, no clock, no state beyond a call's own closure; the only source of randomness is the library's CSPRNG (`randomBytes`), which a test replaces with the draft's own scalars.
//
// Built only from @noble/curves 1.9.7 (ristretto255 point, decode, scalar multiplication, the RFC 9496 element derivation, `equalBytes`) and @noble/hashes 1.8.0 (SHA-512, HMAC, `randomBytes`), the audited libraries the app and the phone already ship, pinned in package.json. No curve arithmetic, hash construction, encoding of points or comparison is written here. The one function of the library this file relies on that its types mark deprecated is `Point.hashToCurve(64 bytes)`: in 1.9.7 it is RFC 9496's element derivation, which CPace's `calculate_generator` names (RFC 9380's `ristretto255_hasher.hashToCurve` is a different function and is not used); the test vector for the generator pins it.
//
// What this file adds to the draft, nothing else: a peer share equal to one's own is refused (a reflection), a zero scalar is sampled again, and the confirmation MAC of 9.4 is HMAC-SHA-512.
//
// MUST NOT, for every caller of this file (the independent review covers each caller, and a whole-repository guard is added with the first one):
//  - hash, HKDF or otherwise stretch the password (PRS) into a key, a slot or a routing id: only ISK, made here, seeds a key;
//  - use the password, K or ISK directly as an encryption or MAC key: derive from ISK with a KDF and a label (confirmationKey here is the draft's own);
//  - expose K (the draft's 9.3): this file never returns it;
//  - send the password, K, ISK or a scalar anywhere, log them, put them in a crash report or analytics, or keep a password to try again after a failed run: a failed run is over and needs a new code;
//  - compare a MAC or a share with `===` or Buffer.equals: use the public `verifyPeerConfirmation` / the library's constant-time `equalBytes`;
//  - run an exchange without a fresh session id `sid` that both sides agreed (CPace's security and its binding of the run to a session depend on it) and without the parties' identities in `ci` or `ad` (draft 9.1).
// How the caller binds a run (what goes into `ci` and `ad`) is the caller's, and is part of what the independent review covers.
// ONLY shared/host/cpace.mjs and its tests may import this file (tests/cpaceInternal.invariant.test.ts): the functions here return K, take a replacement for the CSPRNG and check a MAC in either direction, none of which a caller of the public module may do.
// Buffers are refused (copy into a Uint8Array): the library's own rule. A move to @noble/curves 2.x must re-pin the RFC 9496 element derivation `Point.hashToCurve` (the generator vector in tests/cpace.test.ts guards it).
import { ristretto255 } from '@noble/curves/ed25519';
import { equalBytes } from '@noble/curves/utils';
import { sha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { randomBytes } from '@noble/hashes/utils';

/** The draft this file implements, and the suite: named in every key-binding label the caller makes. */
export const CPACE_SPEC = 'draft-irtf-cfrg-cpace-20 CPACE-RISTR255-SHA512 initiator-responder';
/** G_Ristretto255.DSI (7.3). */
const DSI = new TextEncoder().encode('CPaceRistretto255');
const DSI_ISK = new TextEncoder().encode('CPaceRistretto255_ISK');
/** SHA-512's input block size (H.s_in_bytes). */
const S_IN_BYTES = 128;
const FIELD_SIZE_BYTES = 32;
const GROUP_SIZE_BITS = 252;
const Point = ristretto255.Point;

/** A run that must stop: an invalid or neutral point, a reflected share or a wrong confirmation. `code` is for the caller, never for a person. */
export class CpaceAbort extends Error {
  /** @param {'invalid_point' | 'neutral_point' | 'reflection' | 'bad_input' | 'used'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CpaceAbort';
    this.code = code;
  }
}

/** @param {Uint8Array[]} parts */
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

/** @param {unknown} v @param {string} what @returns {Uint8Array} */
const bytes = (v, what) => {
  if (!(v instanceof Uint8Array) || Object.getPrototypeOf(v) !== Uint8Array.prototype)
    throw new CpaceAbort('bad_input', `${what} must be a Uint8Array.`);
  return v;
};

/** The length of an octet string in front of it, LEB128 (draft A.1.1). @param {Uint8Array} data */
export function prependLen(data) {
  /** @type {number[]} */
  const length = [];
  let n = bytes(data, 'data').length;
  for (;;) {
    length.push(n < 128 ? n : (n & 0x7f) + 0x80);
    n = Math.floor(n / 128);
    if (n === 0) break;
  }
  return concat(Uint8Array.from(length), data);
}

/** The length-value encoding of strings (draft A.1.3). @param {...Uint8Array} args */
export const lvCat = (...args) => concat(...args.map(prependLen));

/** The string a generator is hashed from (draft A.2): the domain, the password and zero padding that fill the first hash block, the channel and the session id. @param {Uint8Array} dsi @param {Uint8Array} prs @param {Uint8Array} ci @param {Uint8Array} sid @param {number} sInBytes */
export function generatorString(dsi, prs, ci, sid, sInBytes) {
  const lenZpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(lenZpad), ci, sid);
}

/** G.calculate_generator (7.3): the generator point the password, the channel and the session id make. @param {{ prs: Uint8Array, ci: Uint8Array, sid: Uint8Array }} o */
export function calculateGenerator({ prs, ci, sid }) {
  const hashed = sha512(generatorString(DSI, bytes(prs, 'prs'), bytes(ci, 'ci'), bytes(sid, 'sid'), S_IN_BYTES));
  return Point.hashToCurve(hashed);
}

/** G.sample_scalar (7.3): 32 random bytes, the bits above 252 cleared, read as little endian; a zero (which would send the neutral element) is sampled again. @param {(n: number) => Uint8Array} [random] */
export function sampleScalar(random = randomBytes) {
  for (;;) {
    const b = Uint8Array.from(random(FIELD_SIZE_BYTES));
    if (b.length !== FIELD_SIZE_BYTES) throw new CpaceAbort('bad_input', 'The random source gave the wrong number of bytes.');
    // bits 252 to 255 are the top four of the last byte
    b[31] = /** @type {number} */ (b[31]) & (0xff >> (256 - GROUP_SIZE_BITS));
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(/** @type {number} */ (b[i]));
    if (y !== 0n) return y;
  }
}

/** G.scalar_mult: y times a decoded point, encoded. @param {bigint} y @param {InstanceType<typeof Point>} g */
export const scalarMult = (y, g) => g.multiply(y).toBytes();

/**
 * G.scalar_mult_vfy: the encoded point `x` times `y`, encoded; null (G.I) when `x` is not a canonical encoding of a group element or is the neutral element.
 * @param {bigint} y @param {Uint8Array} x @returns {Uint8Array | null}
 */
export function scalarMultVfy(y, x) {
  /** @type {InstanceType<typeof Point>} */
  let point;
  try {
    point = Point.fromBytes(bytes(x, 'x'));
  } catch (error) {
    if (error instanceof CpaceAbort) throw error;
    return null;
  }
  if (point.is0()) return null;
  // in a group of prime order a scalar from 1 to the order minus 1 (the library refuses any other: it throws) times a point that is not the neutral element is never the neutral element, so G.I needs no check on the product
  return point.multiply(y).toBytes();
}

/** transcript_ir (5.3): the initiator's message and then the responder's. @param {Uint8Array} ya @param {Uint8Array} ada @param {Uint8Array} yb @param {Uint8Array} adb */
export const transcriptIr = (ya, ada, yb, adb) => concat(lvCat(ya, ada), lvCat(yb, adb));

/** ISK (6.2): the intermediate session key, from the shared point, the session id and the whole transcript. @param {Uint8Array} sid @param {Uint8Array} k @param {Uint8Array} transcript */
export const intermediateKey = (sid, k, transcript) => sha512(concat(lvCat(DSI_ISK, sid, k), transcript));

/**
 * @typedef {object} Inputs
 * @property {Uint8Array} prs the password (the secret characters of the code, as bytes)
 * @property {Uint8Array} ci the channel identifier: what both sides must agree on and is not sent (draft 3.1)
 * @property {Uint8Array} sid the session id both sides agreed before the run
 * @property {Uint8Array} ad this party's associated data, sent in the clear and authenticated by the run (its identity, 9.1)
 */

/** The shared work of a run: this party's share. @param {Inputs} o @param {(n: number) => Uint8Array} [random] */
function share({ prs, ci, sid, ad }, random) {
  bytes(ad, 'ad');
  const g = calculateGenerator({ prs, ci, sid });
  const y = sampleScalar(random);
  return { y, Y: scalarMult(y, g), ad: Uint8Array.from(ad) };
}

/** @param {Uint8Array} mine @param {Uint8Array} theirs */
const refuseReflection = (mine, theirs) => {
  if (equalBytes(mine, theirs)) throw new CpaceAbort('reflection', 'The other side sent this side’s own message.');
};

/**
 * What a finished run gives the caller (never K): which side it was, the session id, ISK, the whole transcript, and both messages, so the confirmation helpers know which is whose.
 * @typedef {Readonly<{ role: 'initiator' | 'responder', sid: Uint8Array, isk: Uint8Array, transcript: Uint8Array, own: { Y: Uint8Array, ad: Uint8Array }, peer: { Y: Uint8Array, ad: Uint8Array } }>} Run
 */

/**
 * The initiator's first step: its message `{ Y, ad }` to send, and `finish` to call once, with the responder's message, for the run. The scalar is dropped when `finish` is called, whatever it answers.
 * @param {(n: number) => Uint8Array} random
 * @param {Inputs} o
 * @returns {{ message: { Y: Uint8Array, ad: Uint8Array }, finish: (peer: { Y: Uint8Array, ad: Uint8Array }) => Run }}
 */
export function initiateWith(random, o) {
  /** @type {{ y: bigint, Y: Uint8Array, ad: Uint8Array } | null} */
  let mine = share(o, random);
  const message = { Y: mine.Y, ad: mine.ad };
  return {
    message,
    finish(peer) {
      if (!mine) throw new CpaceAbort('used', 'This run was finished already.');
      const own = mine;
      mine = null;
      // each field of the peer's message is read once and copied: what is checked, what is decoded and what is bound into the transcript and the run are the same bytes, whatever the caller does with its own arrays afterwards
      const theirs = peerOf(peer);
      refuseReflection(own.Y, theirs.Y);
      const k = scalarMultVfy(own.y, theirs.Y);
      if (!k) throw new CpaceAbort('invalid_point', 'The other side sent an invalid or neutral point.');
      const transcript = transcriptIr(own.Y, own.ad, theirs.Y, theirs.ad);
      return runOf('initiator', o.sid, intermediateKey(o.sid, k, transcript), transcript, own, theirs);
    },
  };
}

/** The peer's message read once, as copies. @param {{ Y: Uint8Array, ad: Uint8Array }} peer */
function peerOf(peer) {
  const { Y, ad } = peer;
  return { Y: Uint8Array.from(bytes(Y, 'Y')), ad: Uint8Array.from(bytes(ad, 'ad')) };
}

/** A finished run that shares no array with the caller or with the messages it returned. @param {'initiator' | 'responder'} role @param {Uint8Array} sid @param {Uint8Array} isk @param {Uint8Array} transcript @param {{ Y: Uint8Array, ad: Uint8Array }} own @param {{ Y: Uint8Array, ad: Uint8Array }} peer @returns {Run} */
const runOf = (role, sid, isk, transcript, own, peer) =>
  Object.freeze({
    role,
    sid: Uint8Array.from(sid),
    isk,
    transcript,
    own: Object.freeze({ Y: Uint8Array.from(own.Y), ad: Uint8Array.from(own.ad) }),
    peer: Object.freeze({ Y: Uint8Array.from(peer.Y), ad: Uint8Array.from(peer.ad) }),
  });

/**
 * The responder's whole run: its message to send back and the run, from the initiator's message.
 * @param {(n: number) => Uint8Array} random
 * @param {Inputs} o @param {{ Y: Uint8Array, ad: Uint8Array }} peer
 * @returns {{ message: { Y: Uint8Array, ad: Uint8Array }, run: Run }}
 */
export function respondWith(random, o, peer) {
  const mine = share(o, random);
  const theirs = peerOf(peer);
  refuseReflection(mine.Y, theirs.Y);
  const k = scalarMultVfy(mine.y, theirs.Y);
  if (!k) throw new CpaceAbort('invalid_point', 'The other side sent an invalid or neutral point.');
  const transcript = transcriptIr(theirs.Y, theirs.ad, mine.Y, mine.ad);
  return {
    message: { Y: mine.Y, ad: mine.ad },
    run: runOf('responder', o.sid, intermediateKey(o.sid, k, transcript), transcript, mine, theirs),
  };
}

const SID_OUTPUT_LABEL = new TextEncoder().encode('CPaceSidOutput');

/** The public session identifier a run can produce (draft 9.6): H.hash(b"CPaceSidOutput" || transcript), unique for honest parties, the labelled hash of the whole transcript. @param {Uint8Array} transcript */
export const sidOutput = (transcript) => sha512(concat(SID_OUTPUT_LABEL, transcript));

const MAC_LABEL = new TextEncoder().encode('CPaceMac');

/** mac_key = H.hash(b"CPaceMac" || sid || ISK) (draft 9.4). @param {Uint8Array} sid @param {Uint8Array} isk */
export const confirmationKey = (sid, isk) => sha512(concat(MAC_LABEL, sid, isk));

/** The authenticator a party sends over the message it sent: MAC(mac_key, lv_cat(Y, AD)) with HMAC-SHA-512 (draft 9.4). @param {Uint8Array} macKey @param {Uint8Array} y @param {Uint8Array} ad */
export const confirmationTag = (macKey, y, ad) => hmac(sha512, macKey, lvCat(y, ad));

/** Whether `tag` is the one the message (y, ad) makes under `macKey`; compared in constant time. @param {Uint8Array} macKey @param {Uint8Array} y @param {Uint8Array} ad @param {Uint8Array} tag */
export const verifyTag = (macKey, y, ad, tag) => tag instanceof Uint8Array && equalBytes(confirmationTag(macKey, y, ad), tag);
