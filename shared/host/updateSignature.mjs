// The signature on a Host update manifest: Ed25519 over the facts that make an update safe to take (which Host it is for, which build, when it stops being good, and its place in the order of builds), so a manifest that is not the publisher's, was made for another Host, is old, or had its archive or address changed on the way is refused before anything is downloaded.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

/** How long a signed manifest may be good for at most: an old one stolen from a mirror stops working. */
export const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
const HOST_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{64}$/;

/** A key a Host that has not heard from it for this long refuses for updates: the app must pair again. */
export const STALE_KEY_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * `keyId` (a v3 manifest) names the key that signed it; `nextKey` (PEM) is a key the Host is to trust from now on, and `revoke` the ids of keys it is to stop trusting (key rotation). All of them are signed.
 * @typedef {{ version: string, sha256: string, url: string, hostId: string, seq: number, notAfter: number, keyId?: string, nextKey?: string, revoke?: string[] }} Facts
 * @typedef {{ id: string, pem: string, lastSeen?: number | null }} TrustedKey a key a Host trusts, and when it last heard from it
 */

/** The id of a public key: the hash of its base64 SPKI DER, which is also a paired client's fingerprint. @param {string} publicKeyPem */
export function keyIdOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der.toString('base64')).digest('hex');
}

/** Whether a v3 manifest's `nextKey` is an Ed25519 public key (PEM) and its `revoke` a list of key ids; both may be left out. @param {Record<string, any>} m */
function keyChangesOk(m) {
  if (m.nextKey !== undefined) {
    try {
      if (typeof m.nextKey !== 'string' || createPublicKey(m.nextKey).asymmetricKeyType !== 'ed25519') return false;
    } catch {
      return false;
    }
  }
  return (
    m.revoke === undefined ||
    (Array.isArray(m.revoke) &&
      m.revoke.length <= 20 &&
      m.revoke.every((/** @type {unknown} */ id) => typeof id === 'string' && KEY_ID.test(id)))
  );
}

/** The bytes that are signed, with a label that no other message of this app uses: v2 for a manifest that does not name its key, v3 for one that does (it also covers the key's id, the key to add and the keys to drop). @param {Facts} m */
const messageOf = (m) =>
  Buffer.from(
    (typeof m.keyId === 'string'
      ? [
          'mopilot-host-update',
          'v3',
          m.hostId,
          m.version,
          m.seq,
          m.notAfter,
          m.sha256,
          m.url,
          m.keyId,
          m.nextKey ?? '',
          `${m.revoke ?? ''}`,
        ]
      : ['mopilot-host-update', 'v2', m.hostId, m.version, m.seq, m.notAfter, m.sha256, m.url]
    ).join('\n'),
  );

/**
 * The signature to put in the manifest as `signature`.
 * @param {Facts} manifest `hostId` is the Host it is for (its challenge names it), `seq` grows with every build signed for it, `notAfter` is when it stops being good (ms since 1970)
 * @param {import('node:crypto').KeyObject | string} privateKey an Ed25519 private key (PEM)
 */
export function signManifest(manifest, privateKey) {
  return sign(null, messageOf(manifest), privateKey).toString('base64');
}

/**
 * Whether `manifest.signature` is a valid signature of its facts by `publicKeyPem`; anything malformed is false, never an error.
 * @param {Partial<Facts> & { signature?: unknown }} manifest
 * @param {string} publicKeyPem
 */
export function verifyManifest(manifest, publicKeyPem) {
  try {
    if (typeof manifest.signature !== 'string') return false;
    return verify(
      null,
      messageOf(/** @type {Facts} */ (manifest)),
      createPublicKey(publicKeyPem),
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Whether this Host may take the manifest: signed by one of its keys (a v3 manifest by the key it names), made for it, still good, and newer than what it already has. A key this Host has not heard from for 180 days is not taken. A refusal says why.
 * @param {Record<string, any>} manifest
 * @param {{ keys: (string | TrustedKey)[], hostId: string, now: number, floor: { seq: number, sha256: string } | null }} o `keys`: the Host's trusted keys, as PEM or with their ids; `floor` is the newest build this Host has taken: a manifest older than it is a rollback, one equal to it must be that same build
 * @returns {{ ok: true, keyId: string } | { ok: false, message: string }}
 */
export function checkManifest(manifest, { keys, hostId, now, floor }) {
  const shaped =
    typeof manifest.version === 'string' &&
    SHA256.test(manifest.sha256) &&
    typeof manifest.url === 'string' &&
    HOST_ID.test(manifest.hostId) &&
    Number.isSafeInteger(manifest.seq) &&
    manifest.seq > 0 &&
    Number.isSafeInteger(manifest.notAfter);
  const trusted = keys.map((k) => (typeof k === 'string' ? { id: keyIdOf(k), pem: k } : k));
  // a manifest that names its key is checked against that key alone; one that does not (v2) against each
  const signer = shaped
    ? trusted.find((k) => (typeof manifest.keyId === 'string' ? k.id === manifest.keyId : true) && verifyManifest(manifest, k.pem))
    : undefined;
  if (!signer) return { ok: false, message: 'The update manifest is not signed by a key this Host trusts; nothing was downloaded.' };
  if (signer.lastSeen != null && now - signer.lastSeen > STALE_KEY_MS)
    return {
      ok: false,
      message:
        'This Host has not heard from the app that signed the update for 180 days; pair the app with it again. Nothing was downloaded.',
    };
  // a v3 manifest's key changes are checked before anything is taken: a key it adds must be an Ed25519 public key, the keys it drops ids
  if (typeof manifest.keyId === 'string' && !keyChangesOk(manifest))
    return { ok: false, message: 'The update manifest names a key this Host cannot use; nothing was downloaded.' };
  if (manifest.hostId !== hostId) return { ok: false, message: 'The update manifest was signed for another Host; nothing was downloaded.' };
  if (manifest.notAfter < now) return { ok: false, message: 'The update manifest has expired; sign a new one. Nothing was downloaded.' };
  if (manifest.notAfter > now + MAX_VALIDITY_MS)
    return { ok: false, message: 'The update manifest is good for too long to trust; sign a new one. Nothing was downloaded.' };
  if (floor && (manifest.seq < floor.seq || (manifest.seq === floor.seq && manifest.sha256 !== floor.sha256)))
    return { ok: false, message: 'The update is older than the one this Host already has; nothing was downloaded.' };
  return { ok: true, keyId: signer.id };
}
