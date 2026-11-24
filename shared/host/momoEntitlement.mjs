// MoMo's server-signed entitlement (#5474): the token the account service issues for an invited account and a Host verifies offline, so a paired device cannot claim MoMo by asserting it. Ed25519 and key ids as the signed Host update manifest (./updateSignature.mjs), with its own signing label so no other signature of this app is a token.
import { createPublicKey, sign, verify } from 'node:crypto';
import { keyIdOf } from './updateSignature.mjs';

/** A token lives 12 hours and its client renews it after 6, so a withdrawal reaches an online Host within about 6.5 hours; an offline one stops at `exp` plus its grace (12 hours when entitlements are required, 72 otherwise). */
export const ENTITLEMENT_TTL_MS = 12 * 3_600_000;
/** The longest `exp - iat` a Host accepts: a token made to live longer is not the issuer's. */
export const ENTITLEMENT_MAX_VALIDITY_MS = 24 * 3_600_000;
/** How long past `exp` a Host keeps MoMo going while it cannot reach a new token (its own clock only). */
export const ENTITLEMENT_GRACE_MS = 72 * 3_600_000;
/** The grace of a Host that requires entitlements. */
export const ENTITLEMENT_REQUIRED_GRACE_MS = 12 * 3_600_000;
/** How far ahead of the Host's clock an `iat` may be. */
export const ENTITLEMENT_SKEW_MS = 5 * 60_000;
/** A client asks for a new token when the one it holds has less than this left. */
export const ENTITLEMENT_REFRESH_BELOW_MS = 6 * 3_600_000;
export const ENTITLEMENT_MAX_BYTES = 2048;
const HOST_ID = /^[0-9a-f]{32}$/;
const KEY_ID = /^[0-9a-f]{64}$/;
const LABEL = 'mopilot-momo-entitlement\nv1\n';

/** The typed reasons a Host does not take an entitlement; the clients show each with its fix (shared/momoView.ts). */
export const ENTITLEMENT_FAILURES = {
  entitlement_missing: 'This Host needs a signed MoMo entitlement and the app sent none.',
  entitlement_invalid: 'The MoMo entitlement is not valid.',
  entitlement_unknown_key: 'The MoMo entitlement is signed by a key this Host does not know; update MoPilot on this machine.',
  entitlement_wrong_host: 'The MoMo entitlement was issued for another Host.',
  entitlement_stale: 'The MoMo entitlement is older than one this Host already took.',
  entitlement_expired: 'The MoMo entitlement ran out and this Host could not get a new one.',
  entitlement_revoked: 'MoMo access for this account was withdrawn.',
  clock_skew: "This machine's date or time is not the account service's; check the clock.",
  not_invited: 'This account is not invited to MoMo.',
  entitlement_unwritable: "This machine could not save MoMo's access, so MoMo stays off here.",
};

/** @typedef {{ kid: string, sub: string, features: string[], aud: string, iat: number, exp: number }} Entitlement */
/** @typedef {{ id: string, pem: string }} TrustedKey */

const b64 = (/** @type {Buffer | string} */ v) => Buffer.from(v).toString('base64url');
const bytesOf = (/** @type {Entitlement} */ e) => Buffer.from(JSON.stringify([e.kid, e.sub, e.features, e.aud, e.iat, e.exp]));
const signedBytes = (/** @type {Buffer} */ payload) => Buffer.concat([Buffer.from(LABEL), payload]);

/**
 * The token for `claims`. `privateKey` is an Ed25519 key (PEM or KeyObject); `claims.kid` must be the id of its public half.
 * @param {Entitlement} claims
 * @param {import('node:crypto').KeyObject | string} privateKey
 */
export function signEntitlement(claims, privateKey) {
  const payload = bytesOf(claims);
  return `v1.${b64(payload)}.${b64(sign(null, signedBytes(payload), privateKey))}`;
}

/**
 * The claims of a token whose signature a trusted, unrevoked key made; never throws.
 * @param {unknown} token
 * @param {{ keys: TrustedKey[], revoked?: string[] }} o
 * @returns {{ ok: true, claims: Entitlement } | { ok: false, code: 'entitlement_invalid' | 'entitlement_unknown_key' }}
 */
export function verifyEntitlement(token, { keys, revoked = [] }) {
  const bad = /** @type {const} */ ({ ok: false, code: 'entitlement_invalid' });
  try {
    if (typeof token !== 'string' || token.length > ENTITLEMENT_MAX_BYTES) return bad;
    const [v, p, s, ...rest] = token.split('.');
    if (v !== 'v1' || !p || !s || rest.length) return bad;
    // an Ed25519 signature is 64 bytes: exactly its canonical 86 characters, never trailing characters a lenient decoder drops
    const sig = Buffer.from(s, 'base64url');
    if (s.length !== 86 || b64(sig) !== s) return bad;
    const payload = Buffer.from(p, 'base64url');
    const a = JSON.parse(payload.toString());
    if (!Array.isArray(a) || a.length !== 6) return bad;
    const [kid, sub, features, aud, iat, exp] = a;
    const shaped =
      KEY_ID.test(kid) &&
      typeof sub === 'string' &&
      sub.length > 0 &&
      sub.length <= 128 &&
      Array.isArray(features) &&
      features.length <= 16 &&
      features.every((/** @type {unknown} */ f) => typeof f === 'string') &&
      HOST_ID.test(aud) &&
      Number.isSafeInteger(iat) &&
      Number.isSafeInteger(exp) &&
      exp > iat;
    // a token whose bytes are not the canonical ones of its claims is not what the issuer signed
    if (!shaped || !payload.equals(bytesOf({ kid, sub, features, aud, iat, exp }))) return bad;
    const key = keys.find((k) => k.id === kid);
    // a well-formed token of a key this Host has not been given (a rotation it has not taken yet) is not a forgery: its fix is the update
    if (revoked.includes(kid) || (key && keyIdOf(key.pem) !== kid)) return bad;
    if (!key) return { ok: false, code: 'entitlement_unknown_key' };
    if (!verify(null, signedBytes(payload), createPublicKey(key.pem), sig)) return bad;
    return { ok: true, claims: { kid, sub, features, aud, iat, exp } };
  } catch {
    return bad;
  }
}

/** @param {string} publicKeyPem */
export const entitlementKeyId = (publicKeyPem) => keyIdOf(publicKeyPem);
