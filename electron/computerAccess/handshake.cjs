// Computer access (#1364): the X25519 identity keys and the per-connection handshake between a client MoPilot and this Mac.
//
// Each install has one static X25519 key. A connection runs a Noise-KK-like handshake:
//   client -> host  { t: 'hello', v, s: client static, e: client ephemeral, n: client nonce, pair? }
//   host -> client  { t: 'welcome', v, s: host static, e: host ephemeral, n: host nonce, mac: host confirmation }
//   client -> host  { t: 'confirm', mac: client confirmation }
// Both sides derive the session keys from DH(e_c, e_h) | DH(e_c, s_h) | DH(s_c, e_h) | DH(s_c, s_h), salted with the
// transcript hash (versions, both nonces, both ephemeral and both static keys). Only holders of the static private keys
// the other side pinned derive the same keys; the ephemeral keys give each connection keys of its own (forward secrecy,
// and frames of an earlier connection can't be replayed into this one). A pairing connection also mixes in the one-time
// secret of the pairing offer, so only someone who has the offer can finish it, and both sides show a verification
// code read from the transcript. Nothing is trusted before both confirmations check.
const crypto = require('node:crypto');
const { sameText } = require('../platform/timingSafe.cjs');

const VERSION = 1;
const LABEL = 'mopilot-access/1';
/** A raw X25519 key, base64url (32 bytes). */
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/**
 * A raw X25519 key in its one canonical base64url form: 43 characters have spare low bits in the last one, so two
 * spellings of the same bytes would compare unequal as text (pinned keys are compared as text).
 * @param {unknown} x
 */
const isKey = (x) => typeof x === 'string' && KEY_TEXT.test(x) && Buffer.from(x, 'base64url').toString('base64url') === x;
/** A nonce, hex (16 bytes). */
const NONCE = /^[0-9a-f]{32}$/;
/** A confirmation MAC, hex (32 bytes). */
const MAC = /^[0-9a-f]{64}$/;
/** How long a device name may be. */
const NAME_MAX = 64;

class HandshakeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * A new static or ephemeral key pair: `x` the public key, `d` the private key (both raw, base64url).
 * @returns {{ x: string, d: string }}
 */
function newKeyPair() {
  const jwk = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  return { x: String(jwk.x), d: String(jwk.d) };
}

/** Whether `k` is a stored key pair this module can use. */
function isKeyPair(k) {
  return !!k && typeof k === 'object' && isKey(k.x) && isKey(k.d);
}

/** X25519 of our private key `pair` and their public key `x`. */
function dh(pair, x) {
  const privateKey = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: pair.x, d: pair.d }, format: 'jwk' });
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
  return crypto.diffieHellman({ privateKey, publicKey });
}

/**
 * The fingerprint of a public key a person or a pairing offer compares: the first 16 bytes of its SHA-256, hex.
 * @param {string} x
 */
function fingerprint(x) {
  return crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, 32);
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

/** The transcript both sides hash: every public value of the handshake, in one fixed order. */
function transcriptOf({ cs, ce, cn, hs, he, hn, pair, name }) {
  // a pairing's device name is part of it, so the name the host shows is the one the device sent
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([LABEL, VERSION, pair ? 'pair' : 'connect', cs, ce, cn, hs, he, hn, pair ? name : null]))
    .digest();
}

/**
 * The connection's keys: one AES-256-GCM key per direction and one confirmation key per side.
 * @param {Buffer} ikm @param {Buffer} transcript @param {string | null} psk the pairing offer's one-time secret
 */
function keysOf(ikm, transcript, psk) {
  const material = psk ? Buffer.concat([ikm, Buffer.from(psk, 'utf8')]) : ikm;
  const okm = Buffer.from(crypto.hkdfSync('sha256', material, transcript, `${LABEL} keys`, 128));
  return {
    toHost: okm.subarray(0, 32),
    toClient: okm.subarray(32, 64),
    confirmHost: okm.subarray(64, 96),
    confirmClient: okm.subarray(96, 128),
  };
}

/**
 * The 6-digit verification code both sides of a pairing show, read from the transcript: a person compares them, so a
 * device that pairs in the middle shows a different code.
 * @param {Buffer} transcript
 */
function verificationCode(transcript) {
  const n = crypto.createHash('sha256').update(transcript).update('code').digest().readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** A device name as one line, cut short. */
function deviceName(v) {
  // control characters become spaces; bidi overrides, isolates and other invisible format characters (Cf) go, so a
  // name can't be made to read as another (an RTL override turning "enohPi" into "iPhone")
  const s =
    typeof v === 'string'
      ? v
          .replace(/[\p{Cc}]/gu, ' ')
          .replace(/[\p{Cf}]/gu, '')
          .trim()
      : '';
  return [...s].slice(0, NAME_MAX).join('') || 'Unnamed device';
}

/**
 * The client starts a connection. `pair`: the device name and the pairing offer's secret when this connection pairs.
 * @param {{ identity: { x: string, d: string }, pair?: { name: string, secret: string } | null }} o
 */
function clientHello({ identity, pair = null }) {
  const eph = newKeyPair();
  const n = crypto.randomBytes(16).toString('hex');
  const message = {
    t: 'hello',
    v: VERSION,
    s: identity.x,
    e: eph.x,
    n,
    ...(pair ? { pair: true, name: deviceName(pair.name) } : {}),
  };
  return { message, state: { identity, eph, n, pair } };
}

/**
 * The host answers a hello. `known(x)`: whether `x` is a paired device's key (a plain connection is refused
 * otherwise). `pairSecret()`: the one-time secret of the pairing offer open right now, else null (a pairing
 * hello is refused then).
 * @param {{ identity: { x: string, d: string }, hello: any, known: (x: string) => boolean, pairSecret: () => string | null }} o
 */
function hostRespond({ identity, hello, known, pairSecret }) {
  const h = hello && typeof hello === 'object' ? hello : {};
  if (h.t !== 'hello' || h.v !== VERSION) throw new HandshakeError('protocol', 'Not a computer access hello');
  if (!isKey(h.s) || !isKey(h.e) || !NONCE.test(h.n)) throw new HandshakeError('protocol', 'A malformed hello');
  const pair = h.pair === true;
  const psk = pair ? pairSecret() : null;
  if (pair && !psk) throw new HandshakeError('no_pairing', 'This Mac is not pairing a device right now');
  if (!pair && !known(h.s)) throw new HandshakeError('unknown_device', 'This device is not paired with this Mac');
  const eph = newKeyPair();
  const n = crypto.randomBytes(16).toString('hex');
  const name = pair ? deviceName(h.name) : null;
  const transcript = transcriptOf({ cs: h.s, ce: h.e, cn: h.n, hs: identity.x, he: eph.x, hn: n, pair, name });
  let ikm;
  try {
    ikm = Buffer.concat([dh(eph, h.e), dh(identity, h.e), dh(eph, h.s), dh(identity, h.s)]);
  } catch {
    throw new HandshakeError('protocol', 'A hello key is not a valid X25519 key');
  }
  const keys = keysOf(ikm, transcript, psk);
  const message = { t: 'welcome', v: VERSION, s: identity.x, e: eph.x, n, mac: hmac(keys.confirmHost, transcript) };
  return {
    message,
    state: { keys, transcript, client: h.s, pair, name },
  };
}

/**
 * The client checks the host's welcome and confirms. `hostKey`: the host's pinned key; for a pairing, the
 * offer's `fingerprint` of it instead.
 * @param {{ state: any, welcome: any, hostKey?: string | null, fingerprint?: string | null }} o
 */
function clientFinish({ state, welcome, hostKey = null, fingerprint: fp = null }) {
  const w = welcome && typeof welcome === 'object' ? welcome : {};
  if (w.t !== 'welcome' || w.v !== VERSION) throw new HandshakeError('protocol', 'Not a computer access welcome');
  if (!isKey(w.s) || !isKey(w.e) || !NONCE.test(w.n) || !MAC.test(w.mac)) throw new HandshakeError('protocol', 'A malformed welcome');
  const pair = !!state.pair;
  if (pair ? !fp || !sameText(fingerprint(w.s), fp) : !hostKey || !sameText(w.s, hostKey))
    throw new HandshakeError('wrong_host', 'The computer that answered is not the one paired');
  const name = pair ? deviceName(state.pair.name) : null;
  const transcript = transcriptOf({ cs: state.identity.x, ce: state.eph.x, cn: state.n, hs: w.s, he: w.e, hn: w.n, pair, name });
  let ikm;
  try {
    ikm = Buffer.concat([dh(state.eph, w.e), dh(state.eph, w.s), dh(state.identity, w.e), dh(state.identity, w.s)]);
  } catch {
    throw new HandshakeError('protocol', 'A welcome key is not a valid X25519 key');
  }
  const keys = keysOf(ikm, transcript, pair ? state.pair.secret : null);
  if (!sameText(w.mac, hmac(keys.confirmHost, transcript))) throw new HandshakeError('unauthorized', 'The computer did not prove its key');
  return {
    message: { t: 'confirm', mac: hmac(keys.confirmClient, transcript) },
    session: { send: keys.toHost, recv: keys.toClient },
    host: w.s,
    code: pair ? verificationCode(transcript) : null,
  };
}

/**
 * The host checks the client's confirmation: the connection is now trusted.
 * @param {{ state: any, confirm: any }} o
 */
function hostFinish({ state, confirm }) {
  const c = confirm && typeof confirm === 'object' ? confirm : {};
  if (c.t !== 'confirm' || !sameText(c.mac, hmac(state.keys.confirmClient, state.transcript)))
    throw new HandshakeError('unauthorized', 'The device did not prove its key');
  return {
    session: { send: state.keys.toClient, recv: state.keys.toHost },
    client: state.client,
    pair: state.pair,
    name: state.name,
    code: state.pair ? verificationCode(state.transcript) : null,
  };
}

module.exports = {
  VERSION,
  HandshakeError,
  newKeyPair,
  isKeyPair,
  isKey,
  fingerprint,
  deviceName,
  verificationCode,
  clientHello,
  hostRespond,
  clientFinish,
  hostFinish,
};
