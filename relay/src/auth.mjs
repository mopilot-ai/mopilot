// Account authentication: verifies the ES256 desktop JWT web/lib/desktop.ts issues (the relay holds only the public key
// or a JWKS URL) and the short-lived signed requests web/ sends: a Trusted device revoked, an account deleted, an account's
// relay access switched off or on.
import { createPublicKey } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * @param {{ publicKeyPem: string, jwksUrl: string, issuer: string, audience: string, revokeAudience: string, purgeAudience?: string, accessAudience?: string, clockToleranceS?: number }} auth
 * @param {{ keyResolver?: Parameters<typeof jwtVerify>[1], clockTolerance?: number }} [opts]
 */
export function createVerifier(auth, opts = {}) {
  const key = opts.keyResolver ?? (auth.publicKeyPem ? createPublicKey(auth.publicKeyPem) : createRemoteJWKSet(new URL(auth.jwksUrl)));
  const check = async (/** @type {string} */ token, /** @type {string} */ audience, /** @type {number} */ clockTolerance) => {
    const { payload } = await jwtVerify(token, /** @type {any} */ (key), {
      issuer: auth.issuer,
      audience,
      algorithms: ['ES256'],
      clockTolerance,
    });
    if (typeof payload.sub !== 'string' || typeof payload.did !== 'string' || typeof payload.exp !== 'number') throw new Error('claims');
    return payload;
  };
  return {
    /**
     * @returns {Promise<{ userId: string, deviceId: string, kind: 'desktop' | 'phone', expMs: number, iatMs: number } | null>} `iatMs`: when the token was issued (0 when it does not say)
     */
    async verify(/** @type {string} */ token) {
      try {
        const p = await check(token, auth.audience, opts.clockTolerance ?? auth.clockToleranceS ?? 5);
        // tokens issued before phones existed have no `dk`: they are desktops
        return {
          userId: String(p.sub),
          deviceId: String(p.did),
          kind: p.dk === 'phone' ? 'phone' : 'desktop',
          expMs: Number(p.exp) * 1000,
          iatMs: typeof p.iat === 'number' ? p.iat * 1000 : 0,
        };
      } catch {
        return null;
      }
    },
    /** A revocation token is signed by the same key for another audience, so an access token can never revoke. */
    async verifyRevocation(/** @type {string} */ token) {
      try {
        // a revocation token is minutes old at most: it gets the smallest tolerance whatever the access tokens are given
        const p = await check(token, auth.revokeAudience, 5);
        return { userId: String(p.sub), deviceId: String(p.did) };
      } catch {
        return null;
      }
    },
    /**
     * The account service switched an account's relay access off or on (claim `st`). Its own audience, so no device token can do
     * it; `iat` is when the switch was made, which orders it against the relay tokens issued around it.
     * @returns {Promise<{ userId: string, disabled: boolean, atMs: number } | null>}
     */
    async verifyAccess(/** @type {string} */ token) {
      try {
        const p = await check(token, auth.accessAudience ?? 'relay-access', 5);
        if ((p.st !== 'disabled' && p.st !== 'enabled') || typeof p.iat !== 'number') return null;
        return { userId: String(p.sub), disabled: p.st === 'disabled', atMs: p.iat * 1000 };
      } catch {
        return null;
      }
    },
    /** An account purge token: the account service deleted the user, so the relay forgets everything it holds for them. Its own audience, so neither an access token nor a revocation token can purge. */
    async verifyPurge(/** @type {string} */ token) {
      try {
        const p = await check(token, auth.purgeAudience ?? 'relay-purge', 5);
        // the token names the devices it is for (`dh`, a digest of their ids): a copy of it cannot be sent with other ids
        if (typeof p.dh !== 'string' || p.sub === 'deleted') return null;
        return { userId: String(p.sub), digest: p.dh };
      } catch {
        return null;
      }
    },
  };
}
