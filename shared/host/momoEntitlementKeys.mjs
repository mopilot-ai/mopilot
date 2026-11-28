// The public keys a Host trusts for MoMo entitlements, with a list of revoked key ids.

/** @type {import('./momoEntitlement.mjs').TrustedKey[]} */
export const ENTITLEMENT_KEYS = [
  // the account service's signing key, made off-repo by the owner and set on the production web on 2026-11-27 (#5622); the id is the hash of this public half
  {
    id: 'bb8b8f0c36b68249df679bbf5c4903f1868950bf33790e6bd0f481cb4943ecd1',
    pem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAfL4dIJ25mTlG9zEfUoRvDRH/5GtindxKKNUSxV4g/10=\n-----END PUBLIC KEY-----\n',
  },
];
/** @type {string[]} */
export const REVOKED_ENTITLEMENT_KEY_IDS = [];
