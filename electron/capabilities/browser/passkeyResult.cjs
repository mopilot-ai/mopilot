// Turns passkeys.node's answer into what the page's wrapper builds a PublicKeyCredential from, after checking it is
// the answer to the request that was sent: the client data's type, challenge and origin, and the authenticator
// data's RP ID hash. An answer that doesn't match, or an error, becomes the DOMException Chromium would give.
const crypto = require('node:crypto');

const NOT_ALLOWED = { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' };
/** ASAuthorizationErrorMatchedExcludedCredential (macOS 15): the authenticator already holds an excluded credential. */
const MATCHED_EXCLUDED = 1006;

/**
 * One CBOR item at `at` (the subset WebAuthn uses: integers, byte and text strings, arrays, maps, simple values).
 * @returns {[unknown, number]} the value and the offset after it
 */
function cbor(buf, at = 0, depth = 0) {
  if (depth > 16 || at >= buf.length) throw new Error('bad CBOR');
  const head = buf[at];
  const major = head >> 5;
  const info = head & 31;
  let n;
  let next = at + 1;
  if (info < 24) n = info;
  else if (info === 24) [n, next] = [buf.readUInt8(next), next + 1];
  else if (info === 25) [n, next] = [buf.readUInt16BE(next), next + 2];
  else if (info === 26) [n, next] = [buf.readUInt32BE(next), next + 4];
  else throw new Error('bad CBOR length');
  if (major === 0) return [n, next];
  if (major === 1) return [-1 - n, next];
  if (major === 2 || major === 3) {
    if (next + n > buf.length) throw new Error('bad CBOR string');
    const s = buf.subarray(next, next + n);
    return [major === 2 ? Buffer.from(s) : s.toString('utf8'), next + n];
  }
  if (major === 4 || major === 5) {
    /** @type {unknown[]} */
    const list = [];
    const map = new Map();
    for (let i = 0; i < n; i++) {
      let k;
      let v;
      [k, next] = cbor(buf, next, depth + 1);
      if (major === 4) list.push(k);
      else {
        [v, next] = cbor(buf, next, depth + 1);
        map.set(k, v);
      }
    }
    return [major === 4 ? list : map, next];
  }
  if (major === 7 && info < 24) return [info === 20 ? false : info === 21 ? true : null, next];
  throw new Error('bad CBOR type');
}

/** A COSE public key as SPKI DER and its algorithm (getPublicKey / getPublicKeyAlgorithm). */
function coseToSpki(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const b64u = (k) => Buffer.from(cose.get(k)).toString('base64url');
  const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521', 6: 'Ed25519' }[cose.get(-1)];
  const jwk =
    kty === 2
      ? { kty: 'EC', crv, x: b64u(-2), y: b64u(-3) }
      : kty === 3
        ? { kty: 'RSA', n: b64u(-1), e: b64u(-2) }
        : kty === 1
          ? { kty: 'OKP', crv, x: b64u(-2) }
          : null;
  if (!jwk) throw new Error('unsupported COSE key');
  const spki = crypto.createPublicKey({ key: /** @type {any} */ (jwk), format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return { publicKey: spki.toString('base64url'), publicKeyAlgorithm: alg };
}

/**
 * Authenticator data's parts: the RP ID hash, and for a new credential its public key.
 * @param {Buffer} data
 */
function authenticatorData(data) {
  if (data.length < 37) throw new Error('short authenticator data');
  const flags = data[32];
  const out = {
    rpIdHash: data.subarray(0, 32),
    key: /** @type {{ publicKey: string | null, publicKeyAlgorithm: unknown } | null} */ (null),
  };
  if (flags & 0x40) {
    const idLength = data.readUInt16BE(53);
    const [cose] = cbor(data, 55 + idLength);
    if (!(cose instanceof Map)) throw new Error('bad credential key');
    try {
      out.key = coseToSpki(cose);
    } catch {
      // a key Node can't read (an unknown curve): the credential exists on the authenticator, so it is still
      // delivered, with getPublicKey() null, as Chromium does; the site reads the key from attestationObject
      out.key = { publicKey: null, publicKeyAlgorithm: typeof cose.get(3) === 'number' ? cose.get(3) : null };
    }
  }
  return out;
}

/** The DOMException for an AuthenticationServices error. */
const failure = (answer) =>
  answer?.code === MATCHED_EXCLUDED
    ? {
        name: 'InvalidStateError',
        message:
          'The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.',
      }
    : NOT_ALLOWED;

/**
 * The page's credential (base64url fields), or the error to reject with.
 * @param {any} answer passkeys.node's answer (base64 fields)
 * @param {{ type: string, challenge: string, origin: string, rpId: string }} expect
 * @returns {{ credential: Record<string, any> } | { error: { name: string, message: string } }}
 */
function pageAnswer(answer, expect) {
  if (!answer?.ok) return { error: failure(answer) };
  try {
    const raw = (k) => {
      if (typeof answer[k] !== 'string' || !answer[k]) throw new Error(`no ${k}`);
      return Buffer.from(answer[k], 'base64');
    };
    const clientDataJSON = raw('clientDataJSON');
    const client = JSON.parse(clientDataJSON.toString('utf8'));
    if (client.type !== expect.type || client.challenge !== expect.challenge || client.origin !== expect.origin)
      throw new Error('client data is for another request');
    const rpIdHash = crypto.createHash('sha256').update(expect.rpId).digest();
    const id = raw('credentialId');
    const response = { clientDataJSON: clientDataJSON.toString('base64url') };
    if (expect.type === 'webauthn.create') {
      if (answer.kind !== 'create') throw new Error('not a registration');
      const attestationObject = raw('attestationObject');
      const [att] = cbor(attestationObject);
      const authData = att instanceof Map ? att.get('authData') : null;
      if (!Buffer.isBuffer(authData)) throw new Error('no authData');
      const parsed = authenticatorData(authData);
      if (!parsed.rpIdHash.equals(rpIdHash) || !parsed.key) throw new Error('authenticator data is for another site');
      Object.assign(response, {
        attestationObject: attestationObject.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        transports: Array.isArray(answer.transports) ? answer.transports.filter((t) => typeof t === 'string') : [],
        ...parsed.key,
      });
    } else {
      if (answer.kind !== 'get') throw new Error('not an assertion');
      const authData = raw('authenticatorData');
      if (!authenticatorData(authData).rpIdHash.equals(rpIdHash)) throw new Error('authenticator data is for another site');
      Object.assign(response, {
        authenticatorData: authData.toString('base64url'),
        signature: raw('signature').toString('base64url'),
        userHandle:
          typeof answer.userHandle === 'string' && answer.userHandle
            ? Buffer.from(answer.userHandle, 'base64').toString('base64url')
            : null,
      });
    }
    return {
      credential: {
        id: id.toString('base64url'),
        type: 'public-key',
        authenticatorAttachment: answer.attachment === 'platform' ? 'platform' : 'cross-platform',
        response,
      },
    };
  } catch {
    // a malformed or mismatched answer is never half-delivered
    return { error: NOT_ALLOWED };
  }
}

module.exports = { pageAnswer, cbor, coseToSpki, authenticatorData, NOT_ALLOWED };
