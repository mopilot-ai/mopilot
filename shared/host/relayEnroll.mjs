// Add by command's key exchange over the relay (#2709), shared by the app and the Host: the phone's pairing-code pattern. The
// one-time code is typed only into the far machine's terminal (the relay never sees it); keys derived from it seal the Host's
// counter-0 hello (its fresh X25519 keys, what it says about itself, a pairing code for the app) and the app's answer (its keys,
// or a refusal), so the relay can neither read nor forge either. Both ends then derive the pair root with `deriveRoot`, as at an
// enrollment over SSH.
import { fromBase64, toBase64, utf8 } from '../remote/envelope.mjs';

const LABEL = 'mopilot-host-enroll-v1';
/** The one-time code: 16 random bytes, base64url. */
export const CODE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The sealing keys of one enrollment, each direction its own.
 * @param {ReturnType<typeof import('../remote/crypto.mjs').createCrypto>} c @param {string} code @param {string} pairId
 */
export function enrollKeys(c, code, pairId) {
  return {
    p2m: c.hkdf(utf8(LABEL), utf8(code), `enroll|${pairId}|p2m`),
    m2p: c.hkdf(utf8(LABEL), utf8(code), `enroll|${pairId}|m2p`),
  };
}

const aad = (/** @type {string} */ pair, /** @type {string} */ dir) => utf8(`${LABEL}|${pair}|${dir}`);

/**
 * One enroll message as a counter-0 frame of the pair (the wire object).
 * @param {import('../remote/crypto.mjs').Primitives} prim @param {Uint8Array} key @param {string} pair @param {'p2m' | 'm2p'} dir @param {object} body
 */
export function sealEnroll(prim, key, pair, dir, body) {
  const nonce = prim.randomBytes(24);
  return {
    pair,
    dir,
    ctr: 0,
    nonce: toBase64(nonce),
    box: toBase64(prim.aeadSeal(key, nonce, utf8(JSON.stringify(body)), aad(pair, dir))),
  };
}

/**
 * The message inside a counter-0 frame, or null when it is not one sealed with `key` (a session hello, a forgery, a wrong code).
 * @param {import('../remote/crypto.mjs').Primitives} prim @param {Uint8Array} key @param {{ pair: string, dir: string, ctr: number, nonce: string, box: string }} f
 * @returns {Record<string, any> | null}
 */
export function openEnroll(prim, key, f) {
  if (f.ctr !== 0) return null;
  try {
    const plain = prim.aeadOpen(key, fromBase64(f.nonce), fromBase64(f.box), aad(f.pair, f.dir));
    const body = plain ? JSON.parse(new TextDecoder().decode(plain)) : null;
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
