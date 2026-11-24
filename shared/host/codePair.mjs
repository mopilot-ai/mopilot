// Pairing two Macs by an 8-character code, the protocol layer (#5576, design revision 2; R2a): pure functions and two small state machines with no I/O, no clock and no storage, on top of the CPace module (shared/host/cpace.mjs) and the pairing crypto the phone already uses (shared/remote/crypto.mjs, injected as `crypto`). The relay's rendezvous (relay/src/rendezvous.mjs) carries the messages; the Host service that polls it, counts the attempts across restarts and asks the person is R2b.
//
// The code is 8 characters: the first 3 are the relay's public hint, the last 5 (`secret`, about 24.8 bits) are the password. ONLY the secret is the password (PRS): the hint is visible to the relay, so it is bound through `ci` (with the rendezvous id and the claim, which both sides know) and never put in PRS; a run whose two sides hold different hints fails at the confirmation.
//
// A run is exactly four messages, which is the shape the relay's turn rule forces:
//   m1  initiator A -> B   its CPace share and its associated data (its label, role, device key, an ephemeral X25519 key and a nonce)
//   m2  responder B -> A   its share, its associated data AND its confirmation tag, in one message
//   m3  A -> B             its confirmation tag AND the sealed pairing body (its name and its signature over the run's transcript hash, which proves it holds the device key it claims), in one message, sent only after A verified B's tag
//   m4  B -> A             the reply (accepted with B's own sealed body, or denied), sealed
// A side that splits a message is refused by the relay (409 wait), and the tests here fail if either side's machine would.
//
// What it never does (see the must-not list in the CPace module's header): hash or stretch the secret into a key, use ISK directly (each key is HKDF(ISK, ...) for its purpose, direction and both device keys), put the secret anywhere but PRS, keep a secret after a run failed, or pin the other side's key before its confirmation checked out.
//
// `sid` is EMPTY, on purpose. draft-irtf-cfrg-cpace-20 section 9.9: "Values for sid SHOULD NOT be reused since the composability guarantees established by the simulation-based proof rely on the uniqueness of session ids"; and section 3.1 asks for a pre-agreed sid only when "both parties have access to the same unique public octet string". Here the relay is untrusted and chooses both the rendezvous id and the claim epoch it relays, so no value both sides could agree before the first message is guaranteed unique. The draft's own answer for that case is the empty sid (section 9: "[BGHJ24] extends the analysis from [AHH21] by covering the case that no pre-agreed session identifier is available"; section 9.6: "If CPace was run with an empty string sid available as input"), whose uniqueness comes from the transcript (the fresh shares and the nonce each side puts in its own associated data). So: the fresh shares (a new scalar per run, section 9.9 "Secret scalars MUST NOT be reused", made inside cpace.mjs) make every run's ISK and transcript unique; the nonces keep each side's own contribution in the transcript even if the other side's were replayed; the rendezvous id and the claim epoch are in `ci` and in each side's associated data, which binds a run to one claim of one offer and makes a relay that swaps either cause only a mismatch, and nothing relies on them being unique or fresh.
import { CPACE_SPEC, initiate, lvCat, ownConfirmation, respond, sessionIdOf, verifyPeerConfirmation } from './cpace.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { fromBase64, toBase64, utf8 } from '../remote/envelope.mjs';

export const LABEL = 'mopilot-code-pair-v1';
/** CPace's session id is empty (see the header). */
const NO_SID = new Uint8Array(0);
/** The characters of a code: no 0, O, 1, I or L (the relay's own alphabet). */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const HINT_LENGTH = 3;
export const SECRET_LENGTH = 5;
/** Failed or abandoned runs a code survives: the third one burns it. */
export const MAX_RUNS = 3;
/** The longest name of a device that goes into a sealed body, in characters. */
export const MAX_NAME = 80;
/** The relay's offer ids and the claims one offer takes (relay/src/rendezvous.mjs). */
export const OFFER_ID = /^r_[A-Za-z0-9_-]{22}$/;
export const MAX_CLAIMS = 5;

/** A run that must stop. `code` is for the caller, never for a person. */
export class CodePairError extends Error {
  /** @param {'bad_code' | 'bad_message' | 'bad_confirmation' | 'bad_body' | 'bad_proof' | 'unrecorded' | 'out_of_turn' | 'burned'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CodePairError';
    this.code = code;
  }
}

const concat = (/** @type {Uint8Array[]} */ ...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

/** A base64url text (no padding) of bytes: the relay's box characters. @param {Uint8Array} bytes */
export const b64u = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** The bytes of a base64url text, or null: only the one canonical spelling of each (no stray trailing bits), so a message has one text. @param {unknown} text */
export function unb64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return b64u(bytes) === text ? bytes : null;
}

/**
 * The 5 secret characters, drawn uniformly (bytes at or above the largest multiple of the alphabet's size are thrown away, so no character is likelier than another).
 * @param {(n: number) => Uint8Array} random
 */
export function newSecret(random) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < SECRET_LENGTH)
    for (const byte of random(16)) if (byte < limit && out.length < SECRET_LENGTH) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** What the person typed as a hint and a secret, or null: case and spaces and dashes do not matter, every character must be of the alphabet (so a typo that is no character burns no attempt). @param {unknown} text */
export function parseCode(text) {
  const clean = typeof text === 'string' ? text.toUpperCase().replace(/[\s-]/g, '') : '';
  if (clean.length !== HINT_LENGTH + SECRET_LENGTH || [...clean].some((c) => !ALPHABET.includes(c))) return null;
  return { hint: clean.slice(0, HINT_LENGTH), secret: clean.slice(HINT_LENGTH) };
}

/** A code as it is shown: 4-4. @param {string} hint @param {string} secret */
export const formatCode = (hint, secret) => `${(hint + secret).slice(0, 4)}-${(hint + secret).slice(4)}`;

/** The channel both sides must agree on and never send: the protocol, the suite, the hint, the offer, the claim and the roles in their order. @param {string} hint @param {string} rendezvousId @param {number} claims */
export const ciOf = (hint, rendezvousId, claims) =>
  lvCat(utf8(LABEL), utf8(CPACE_SPEC), utf8(hint), utf8(rendezvousId), utf8(String(claims)), utf8('initiator'), utf8('responder'));

/** The hint, the offer and the claim a machine is given, or a refusal before anything is made. @param {string} hint @param {string} rendezvousId @param {number} claims */
function checkOffer(hint, rendezvousId, claims) {
  if (typeof hint !== 'string' || ![...hint].every((ch) => ALPHABET.includes(ch)) || hint.length !== HINT_LENGTH)
    throw new CodePairError('bad_code', 'That is not a hint.');
  if (typeof rendezvousId !== 'string' || !OFFER_ID.test(rendezvousId)) throw new CodePairError('bad_code', 'That is not an offer.');
  if (!Number.isInteger(claims) || claims < 1 || claims > MAX_CLAIMS) throw new CodePairError('bad_code', 'That is not a claim.');
}

/**
 * One side's associated data: protocol label, role, its device key, its ephemeral key, a nonce of its own, and the offer and claim it believes it is in (the other side compares them).
 * @param {'initiator' | 'responder'} role @param {{ device: Uint8Array, eph: Uint8Array, nonce: Uint8Array, rendezvousId: string, claims: number }} o
 */
export const adOf = (role, { device, eph, nonce, rendezvousId, claims }) =>
  lvCat(utf8(LABEL), utf8(role), device, eph, nonce, utf8(rendezvousId), utf8(String(claims)));

/** The fields of an associated data, or null when it is not one of this role's. @param {Uint8Array} ad @param {'initiator' | 'responder'} role */
export function parseAd(ad, role) {
  const parts = [];
  let at = 0;
  while (at < ad.length) {
    let length = 0;
    let shift = 0;
    for (;;) {
      const b = ad[at++];
      if (b === undefined || shift > 21) return null;
      length += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (b < 128) break;
    }
    if (at + length > ad.length) return null;
    parts.push(ad.slice(at, at + length));
    at += length;
  }
  if (parts.length !== 7) return null;
  const [label, who, device, eph, nonce, offer, claim] =
    /** @type {[Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]} */ (parts);
  const text = (/** @type {Uint8Array} */ b) => new TextDecoder().decode(b);
  if (text(label) !== LABEL || text(who) !== role) return null;
  if (device.length !== 32 || eph.length !== 32 || nonce.length !== 16) return null;
  return { device, eph, nonce, rendezvousId: text(offer), claims: text(claim) };
}

/** One message as the text the relay carries. @param {Record<string, string>} fields */
const wire = (fields) => b64u(utf8(JSON.stringify(fields)));
/** The fields of a message, each a base64url text decoded, or null. @param {unknown} text @param {string[]} names */
function unwire(text, names) {
  const raw = unb64u(text);
  if (!raw) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(raw));
    if (!json || typeof json !== 'object' || Array.isArray(json) || Object.keys(json).sort().join() !== [...names].sort().join())
      return null;
    /** @type {Record<string, Uint8Array>} */
    const out = {};
    for (const n of names) {
      const bytes = unb64u(json[n]);
      if (!bytes) return null;
      out[n] = bytes;
    }
    return out;
  } catch {
    return null;
  }
}

/** Characters a name may not carry because they change how text is laid out, hide it or draw as nothing: control characters, bidirectional controls, zero-width and invisible format characters, Unicode tag characters, Hangul fillers, the combining grapheme joiner and the blank braille pattern. */
const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
/** A short name of a device that is safe to show (it is on the Allow prompt): no layout or hidden characters, cut to MAX_NAME characters. @param {unknown} name */
const nameOf = (name) => (typeof name === 'string' ? [...name.replace(HIDDEN, '')].slice(0, MAX_NAME).join('') : '');

/**
 * The key schedule of a finished PAKE run, all from ISK: one key per direction (bound to the purpose, the offer and both device keys), the pair root, which also mixes in a fresh X25519 exchange of the two ephemeral keys, the labelled hash of the transcript that is the AAD of every sealed body, and the safety number. Exported for its tests: the machines below are its only callers.
 * @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} c
 * @param {{ isk: Uint8Array, transcript: Uint8Array }} run @param {Uint8Array} deviceA @param {Uint8Array} deviceB @param {Uint8Array} ownEphSecret @param {Uint8Array} peerEph @param {string} rendezvousId
 */
export function deriveKeys(c, run, deviceA, deviceB, ownEphSecret, peerEph, rendezvousId) {
  const info = (/** @type {string} */ what) => `${LABEL}|${CPACE_SPEC}|${what}|${rendezvousId}|${b64u(deviceA)}|${b64u(deviceB)}`;
  // a key of low order gives zeros (Node's OpenSSL path) or an error (libsodium's): both are a refusal, never a root with no secret in it
  /** @type {Uint8Array} */
  let fresh;
  try {
    fresh = c.prim.x25519(ownEphSecret, peerEph);
  } catch (error) {
    throw new CodePairError('bad_message', `The other side’s ephemeral key was refused: ${error}`);
  }
  if (fresh.every((b) => b === 0)) throw new CodePairError('bad_message', 'The other side’s ephemeral key has low order.');
  const salt = utf8(LABEL);
  // the draft's labelled hash of the whole transcript (9.6), not a bare hash of it
  const transcriptHash = sessionIdOf(/** @type {import('./cpace.mjs').Run} */ (run));
  return {
    toB: c.hkdf(salt, run.isk, info('a2b')),
    toA: c.hkdf(salt, run.isk, info('b2a')),
    root: c.hkdf(c.hkdf(salt, run.isk, info('root-salt')), fresh, info('root')),
    transcriptHash,
    /** both devices see the same words: the confirmed transcript and both long-term keys. */
    safety: c.safetyNumber(concat(transcriptHash, deviceA, deviceB)),
  };
}

/** What a device signs to prove it holds the key it claims: this run's transcript hash, for its own role. @param {'initiator' | 'responder'} role @param {Uint8Array} transcriptHash */
const proofMessage = (role, transcriptHash) => lvCat(utf8(`${LABEL}|device-proof`), utf8(role), transcriptHash);

/** @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} c @param {Uint8Array} key @param {Uint8Array} aad @param {object} body */
function seal(c, key, aad, body) {
  const nonce = randomBytes(24);
  return b64u(concat(nonce, c.prim.aeadSeal(key, nonce, utf8(JSON.stringify(body)), aad)));
}
/** The body a sealed plain text holds: an object, or null. @param {Uint8Array} plain */
export function bodyOf(plain) {
  try {
    const body = JSON.parse(new TextDecoder().decode(plain));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
/** The body of a sealed text, or null. @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} c @param {Uint8Array} key @param {Uint8Array} aad @param {Uint8Array} sealed */
function unseal(c, key, aad, sealed) {
  if (sealed.length < 24 + 16) return null;
  const plain = c.prim.aeadOpen(key, sealed.slice(0, 24), sealed.slice(24), aad);
  return plain ? bodyOf(plain) : null;
}

/**
 * How many runs ONE code survives: ONE budget per offer on the controlled Mac and ONE per typed code on the controlling Mac (the caller keys it so: a second budget for the same code is a second chance the code does not have). Counted when a run STARTS, before its first message is made; there is no refund. A run that ends in a confirmation spends the code (`confirmed()`), and a failed, dropped or abandoned one stays counted, so the third start burns it. `persist({ started, spent })` is called BEFORE `begin()` says yes and when the code is spent (the Host makes it durable there, before a message leaves); if it throws on a start the run is not started and nothing is counted. `restore` brings back what was persisted, so a restart in the middle of a code keeps its count and a spent code stays spent; a stored value that is not exactly `{ started: 0..max, spent: boolean }` is read as a spent code (fail closed).
 * @param {{ max?: number, persist?: (state: { started: number, spent: boolean }) => void, restore?: unknown }} [o]
 */
export function createRunBudget({ max = MAX_RUNS, persist, restore } = {}) {
  // what was stored comes back only if it is exactly a count from 0 to the maximum and a boolean; anything else (a corrupt or foreign file, a number out of range, a missing field) is read as a code that is SPENT, never as three more guesses
  const stored = /** @type {{ started?: unknown, spent?: unknown }} */ (restore);
  const sound =
    restore !== undefined &&
    restore !== null &&
    typeof restore === 'object' &&
    Number.isInteger(stored.started) &&
    /** @type {number} */ (stored.started) >= 0 &&
    /** @type {number} */ (stored.started) <= max &&
    typeof stored.spent === 'boolean';
  let started = restore === undefined ? 0 : sound ? /** @type {number} */ (stored.started) : max;
  let spent = restore === undefined ? false : sound ? /** @type {boolean} */ (stored.spent) : true;
  return {
    /** A run begins: false (and the code is burned) when the budget is gone. */
    begin() {
      if (spent || started >= max) return false;
      persist?.({ started: started + 1, spent });
      started++;
      return true;
    },
    /** The run ended in a confirmation: the code did its one job and is spent (in memory first, then written: a write that fails does not un-spend it). */
    confirmed() {
      spent = true;
      persist?.({ started, spent });
    },
    get burned() {
      return spent || started >= max;
    },
    get left() {
      return spent ? 0 : Math.max(0, max - started);
    },
  };
}

/** @typedef {ReturnType<typeof createRunBudget>} RunBudget */
/** @typedef {{ pub: Uint8Array, name: string, sign: (message: Uint8Array) => Uint8Array }} Device this Mac's Ed25519 device key, its name, and the way it signs (the private key stays with its owner) */

/**
 * The controlling Mac's side (A, the initiator): `first()` is m1 (and starts a run of the typed code's budget), `second(m2)` checks the responder's tag and returns m3, `finish(m4)` opens the reply and checks the other Mac's proof that it holds its key. Each step runs once and in order; any failure ends the run, and a failed run is never retried with the same typed code: its budget is one of three and the screen says to get a new code from the other Mac.
 * @param {object} o
 * @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} o.crypto
 * @param {string} o.secret the 5 characters typed @param {string} o.hint the 3 typed @param {string} o.rendezvousId @param {number} o.claims
 * @param {Device} o.device @param {RunBudget} o.budget the typed code's runs
 */
export function createInitiator({ crypto: c, secret, hint, rendezvousId, claims, device, budget }) {
  checkOffer(hint, rendezvousId, claims);
  const ephSecret = randomBytes(32);
  const ephPub = c.prim.x25519Base(ephSecret);
  const nonce = randomBytes(16);
  let step = 0;
  /** @type {ReturnType<typeof initiate> | null} */
  let started = null;
  /** @type {{ keys: ReturnType<typeof deriveKeys>, peer: NonNullable<ReturnType<typeof parseAd>> } | null} */
  let derived = null;
  const stop = (/** @type {CodePairError} */ error) => {
    step = 99;
    started = null;
    derived = null;
    return error;
  };
  return {
    /** m1. */
    first() {
      if (step !== 0) throw new CodePairError('out_of_turn', 'This run already began.');
      step = 1;
      /** @type {boolean} */
      let counted;
      try {
        counted = budget.begin();
      } catch (error) {
        // the count could not be written, so the run does not start (and nothing is left of it)
        throw stop(new CodePairError('unrecorded', `The count of this code could not be written: ${error}`));
      }
      if (!counted) throw stop(new CodePairError('burned', 'This code has been used as often as it may be.'));
      started = initiate({
        prs: utf8(secret),
        ci: ciOf(hint, rendezvousId, claims),
        sid: NO_SID,
        ad: adOf('initiator', { device: device.pub, eph: ephPub, nonce, rendezvousId, claims }),
      });
      return wire({ Y: b64u(started.message.Y), ad: b64u(started.message.ad) });
    },
    /** m3, from m2: verifies the responder's tag first and only then reveals its own. @param {string} m2 */
    second(m2) {
      if (step !== 1) throw stop(new CodePairError('out_of_turn', 'Not the turn of the second message.'));
      step = 2;
      const f = /** @type {{ Y: Uint8Array, ad: Uint8Array, tag: Uint8Array } | null} */ (unwire(m2, ['Y', 'ad', 'tag']));
      const peerAd = f ? parseAd(f.ad, 'responder') : null;
      if (!f || !peerAd) throw stop(new CodePairError('bad_message', 'The reply is not one of this protocol.'));
      // an offer or claim that is not the one this side is in (a relay that swapped it) is a mismatch, found before any key is made
      if (peerAd.rendezvousId !== rendezvousId || peerAd.claims !== String(claims))
        throw stop(new CodePairError('bad_message', 'The reply is for another offer.'));
      try {
        const run = /** @type {NonNullable<typeof started>} */ (started).finish({ Y: f.Y, ad: f.ad });
        started = null;
        if (!verifyPeerConfirmation(run, f.tag)) throw new CodePairError('bad_confirmation', 'The code did not match.');
        // the code did its job: it is spent whatever the person says next
        budget.confirmed();
        const keys = deriveKeys(c, run, device.pub, peerAd.device, ephSecret, peerAd.eph, rendezvousId);
        derived = { keys, peer: peerAd };
        const proof = b64u(device.sign(proofMessage('initiator', keys.transcriptHash)));
        const sealed = seal(c, keys.toB, keys.transcriptHash, { name: nameOf(device.name), claims, proof });
        return wire({ tag: b64u(ownConfirmation(run)), sealed });
      } catch (error) {
        // a failure anywhere in this step ends the run and leaves nothing of it
        throw stop(error instanceof CodePairError ? error : new CodePairError('bad_message', String(error)));
      }
    },
    /** What the person compares with the other Mac, once the responder's tag checked out. */
    get safety() {
      return derived?.keys.safety ?? null;
    },
    /** The end of the run, from m4: the pair root and the other Mac's key and name once it proved it holds that key, or that it was denied. @param {string} m4 */
    finish(m4) {
      if (step !== 2) throw stop(new CodePairError('out_of_turn', 'Not the turn of the last message.'));
      step = 3;
      const f = /** @type {{ sealed: Uint8Array } | null} */ (unwire(m4, ['sealed']));
      const keysAndPeer = /** @type {NonNullable<typeof derived>} */ (derived);
      const body = f ? unseal(c, keysAndPeer.keys.toA, keysAndPeer.keys.transcriptHash, f.sealed) : null;
      if (!body) throw stop(new CodePairError('bad_body', 'The answer could not be opened.'));
      const { keys, peer } = keysAndPeer;
      derived = null;
      if (body.denied === true) return { denied: /** @type {const} */ (true) };
      if (!provedBy(c, peer.device, 'responder', keys.transcriptHash, body.proof))
        throw stop(new CodePairError('bad_proof', 'The other Mac did not prove it holds its key.'));
      return {
        denied: /** @type {const} */ (false),
        root: keys.root,
        peerDevice: peer.device,
        peerName: nameOf(body.name),
        safety: keys.safety,
      };
    },
  };
}

/** The group order of Ed25519: a canonical signature has S below it. */
const ED_ORDER = ed25519.CURVE.n;

/** Whether `bytes` is the one canonical encoding of an Ed25519 point of large order: the library refuses a y that is not below the field prime, and a point of small order is refused here whatever the primitive set does with it. @param {Uint8Array} bytes */
function strongPoint(bytes) {
  try {
    const point = ed25519.Point.fromHex(bytes);
    return !point.isSmallOrder() && Buffer.from(point.toBytes()).equals(Buffer.from(bytes));
  } catch {
    return false;
  }
}

/**
 * Whether `proof` is the signature of the claimed device key over this run's proof message. Checked here, not left to the primitive set (libsodium and Node's OpenSSL differ on keys and nonces of small order): the key must be a canonical point of large order, so must the signature's R, and its S must be below the group order.
 * @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} c @param {Uint8Array} device @param {'initiator' | 'responder'} role @param {Uint8Array} transcriptHash @param {unknown} proof
 */
export function provedBy(c, device, role, transcriptHash, proof) {
  const signature = unb64u(proof);
  if (!signature || signature.length !== 64 || device.length !== 32 || !strongPoint(device) || !strongPoint(signature.slice(0, 32)))
    return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(/** @type {number} */ (signature[i]));
  return s < ED_ORDER && c.prim.edVerify(device, proofMessage(role, transcriptHash), signature);
}

/**
 * The controlled Mac's side (B, the responder) for ONE claim of an offer: `receive(m1)` counts the run in the code's budget BEFORE it makes m2 and is m2, `receive3(m3)` checks the initiator's tag, opens its body and checks its proof of holding its key (and so is the moment to ask the person), `answer(accept)` is m4. A new claim is a new responder; the budget is the code's.
 * @param {object} o
 * @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} o.crypto
 * @param {string} o.secret @param {string} o.hint @param {string} o.rendezvousId @param {number} o.claims the claim this run answers
 * @param {Device} o.device this Host's key, name and signer @param {RunBudget} o.budget the offered code's runs
 */
export function createResponder({ crypto: c, secret, hint, rendezvousId, claims, device, budget }) {
  checkOffer(hint, rendezvousId, claims);
  const ephSecret = randomBytes(32);
  const ephPub = c.prim.x25519Base(ephSecret);
  const nonce = randomBytes(16);
  let step = 0;
  /** @type {import('./cpace.mjs').Run | null} */
  let run = null;
  /** @type {{ keys: ReturnType<typeof deriveKeys>, peer: NonNullable<ReturnType<typeof parseAd>>, name: string } | null} */
  let derived = null;
  const stop = (/** @type {CodePairError} */ error) => {
    step = 99;
    run = null;
    derived = null;
    return error;
  };
  return {
    /** m2, from m1. The run is counted (and made durable by the budget's `persist`) before any part of m2 exists. @param {string} m1 */
    receive(m1) {
      if (step !== 0) throw stop(new CodePairError('out_of_turn', 'Not the turn of the first message.'));
      step = 1;
      /** @type {boolean} */
      let counted;
      try {
        counted = budget.begin();
      } catch (error) {
        // the count could not be written, so the run does not start (and nothing is left of it)
        throw stop(new CodePairError('unrecorded', `The count of this code could not be written: ${error}`));
      }
      if (!counted) throw stop(new CodePairError('burned', 'This code has been used as often as it may be.'));
      const f = /** @type {{ Y: Uint8Array, ad: Uint8Array } | null} */ (unwire(m1, ['Y', 'ad']));
      const peerAd = f ? parseAd(f.ad, 'initiator') : null;
      if (!f || !peerAd) throw stop(new CodePairError('bad_message', 'The message is not one of this protocol.'));
      if (peerAd.rendezvousId !== rendezvousId || peerAd.claims !== String(claims))
        throw stop(new CodePairError('bad_message', 'The message is for another offer.'));
      try {
        const answered = respond(
          {
            prs: utf8(secret),
            ci: ciOf(hint, rendezvousId, claims),
            sid: NO_SID,
            ad: adOf('responder', { device: device.pub, eph: ephPub, nonce, rendezvousId, claims }),
          },
          { Y: f.Y, ad: f.ad },
        );
        run = answered.run;
        derived = { keys: deriveKeys(c, run, peerAd.device, device.pub, ephSecret, peerAd.eph, rendezvousId), peer: peerAd, name: '' };
        return wire({ Y: b64u(answered.message.Y), ad: b64u(answered.message.ad), tag: b64u(ownConfirmation(run)) });
      } catch (error) {
        // a failure anywhere in this step (a point of low order included) ends the run and leaves no ISK behind
        throw stop(error instanceof CodePairError ? error : new CodePairError('bad_message', String(error)));
      }
    },
    /** The initiator's tag is checked before its body is opened, and its body must prove that it holds the device key it claims; what it says of itself is for the person to see. @param {string} m3 @returns {{ peerDevice: Uint8Array, peerName: string, safety: string }} */
    receive3(m3) {
      if (step !== 1) throw stop(new CodePairError('out_of_turn', 'Not the turn of the third message.'));
      step = 2;
      try {
        const f = /** @type {{ tag: Uint8Array, sealed: Uint8Array } | null} */ (unwire(m3, ['tag', 'sealed']));
        if (!f) throw new CodePairError('bad_message', 'The message is not one of this protocol.');
        const mine = /** @type {{ run: import('./cpace.mjs').Run, derived: NonNullable<typeof derived> }} */ ({ run, derived });
        if (!verifyPeerConfirmation(mine.run, f.tag)) throw new CodePairError('bad_confirmation', 'The code did not match.');
        // the other Mac knew the code: it is spent whatever follows
        budget.confirmed();
        const body = unseal(c, mine.derived.keys.toB, mine.derived.keys.transcriptHash, f.sealed);
        if (!body) throw new CodePairError('bad_body', 'The body could not be opened.');
        if (!provedBy(c, mine.derived.peer.device, 'initiator', mine.derived.keys.transcriptHash, body.proof))
          throw new CodePairError('bad_proof', 'The other Mac did not prove it holds its key.');
        mine.derived.name = nameOf(body.name);
        return { peerDevice: mine.derived.peer.device, peerName: mine.derived.name, safety: mine.derived.keys.safety };
      } catch (error) {
        // whatever fails here ends the run: answer() can never be called on a half-checked one
        throw stop(error instanceof CodePairError ? error : new CodePairError('bad_message', String(error)));
      }
    },
    /** m4, and the pair root when the person accepted. The caller adds the other Mac's key to its table only now. @param {boolean} accept */
    answer(accept) {
      if (step !== 2) throw stop(new CodePairError('out_of_turn', 'Not the turn of the answer.'));
      step = 3;
      const { keys, peer, name } = /** @type {NonNullable<typeof derived>} */ (derived);
      derived = null;
      run = null;
      const body = accept
        ? { name: nameOf(device.name), proof: b64u(device.sign(proofMessage('responder', keys.transcriptHash))) }
        : { denied: true };
      const sealed = seal(c, keys.toA, keys.transcriptHash, body);
      return { message: wire({ sealed }), ...(accept ? { root: keys.root, peerDevice: peer.device, peerName: name } : {}) };
    },
  };
}
