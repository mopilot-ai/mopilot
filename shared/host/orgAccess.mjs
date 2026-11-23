// Organization access (#3361 Tier 2): what an organization lease is (a short-lived token from the customer's IdP and the customer's LLM gateway it is good for), how long one may live, and which harness gets it under which names. Shared by the app (which mints it) and the Host (which holds it in memory only), so the two cannot drift.

/** The feature both ends declare before a lease is sent: an older Host never gets one it would drop. */
export const ORG_FEATURE = 'orgCredentials';

/** How long a lease may live, in hours: the admin picks within these bounds; 8 h keeps a long unattended turn going (plan v2). */
export const LEASE_HOURS = Object.freeze({ min: 1, max: 24, default: 8 });

/** How far a Host's clock may be from the app's for a lease's end to be taken. */
export const CLOCK_SKEW_MS = 15 * 60_000;

/** The share of a lease's life after which the app sends a fresh one while it can (a running turn keeps going on the new token). */
export const RENEW_AT = 0.8;

/** The harnesses a lease is minted for, and which gateway each one talks to (`anthropic`: the Messages API, `openai`: the Responses API). */
export const ORG_HARNESSES = Object.freeze({
  claude: Object.freeze({ gateways: Object.freeze(['anthropic']) }),
  codex: Object.freeze({ gateways: Object.freeze(['openai']) }),
  // an ACP agent may speak either; it uses the lease only if it reads these names
  acp: Object.freeze({ gateways: Object.freeze(['anthropic', 'openai']) }),
});

/** The env name a Codex app-server reads the lease from, through the custom model provider it is started with (never OPENAI_API_KEY, never its auth.json). */
export const CODEX_TOKEN_ENV = 'MOPILOT_ORG_TOKEN';
/** The provider id Codex is started with while a lease is held. */
export const CODEX_PROVIDER = 'mopilot_org';

/** A bearer token: printable, no spaces, bounded (an IdP's JWT runs to a few kilobytes). */
const TOKEN = /^[\x21-\x7e]{20,16384}$/;

/** An org identity: a hash of the IdP issuer and the person's subject (identityOf), opaque and secret-free; a lease is held per (harness, identity). */
const IDENTITY = /^[0-9a-f]{32}$/;

/** Whether `v` can be an org identity. @param {unknown} v */
export const isIdentity = (v) => typeof v === 'string' && IDENTITY.test(v);

/** Whether `v` can be a lease's token. The answer never carries the token. @param {unknown} v */
export const isLeaseToken = (v) => typeof v === 'string' && TOKEN.test(v);

/** Hosts a gateway or an issuer may be reached over plain http: only this machine's own (a test fixture), never the network. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A gateway's or an issuer's base URL as a lease or the admin's settings may carry it: https, or http on loopback only; no credentials, query or fragment.
 * Returns the URL without a trailing slash, or null.
 * @param {unknown} v
 */
export function baseUrlOf(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) return null;
  return url.href.replace(/\/+$/, '');
}

/**
 * A lease as the wire carries it, checked: the harness, its token, the gateway URLs it is good for and when it ends.
 * Throws a message safe to show (never the token) for anything else.
 * @param {unknown} p
 * @param {number} now
 * @returns {{ harness: keyof typeof ORG_HARNESSES, identity: string, token: string, gateways: Partial<Record<'anthropic' | 'openai', string>>, expiresAt: number } | { harness: keyof typeof ORG_HARNESSES, identity: string, token: null }}
 */
export function leaseOf(p, now) {
  const o = /** @type {any} */ (p ?? {});
  if (typeof o.harness !== 'string' || !Object.hasOwn(ORG_HARNESSES, o.harness))
    throw new Error('That agent takes no organization access.');
  const harness = /** @type {keyof typeof ORG_HARNESSES} */ (o.harness);
  if (!isIdentity(o.identity)) throw new Error('That organization access names no one.');
  const identity = /** @type {string} */ (o.identity);
  if (o.token === null) return { harness, identity, token: null };
  if (!isLeaseToken(o.token)) throw new Error('That is not an organization token.');
  const expiresAt = Number(o.expiresAt);
  // the end is on the app's clock: a Host's clock a few minutes off either way still takes it
  if (!Number.isFinite(expiresAt) || expiresAt <= now - CLOCK_SKEW_MS || expiresAt > now + LEASE_HOURS.max * 3_600_000 + CLOCK_SKEW_MS)
    throw new Error('That organization token has no valid end.');
  /** @type {Partial<Record<'anthropic' | 'openai', string>>} */
  const gateways = {};
  for (const g of ORG_HARNESSES[harness].gateways) {
    const url = o.gateways?.[g] == null ? null : baseUrlOf(o.gateways[g]);
    if (o.gateways?.[g] != null && !url) throw new Error('That gateway address is not allowed.');
    if (url) gateways[/** @type {'anthropic' | 'openai'} */ (g)] = url;
  }
  if (!Object.keys(gateways).length) throw new Error('That organization token names no gateway.');
  return { harness, identity, token: o.token, gateways, expiresAt };
}

/** The hours an admin set, kept within bounds; anything else is the default. @param {unknown} v */
export const leaseHoursOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= LEASE_HOURS.min && n <= LEASE_HOURS.max ? n : LEASE_HOURS.default;
};
