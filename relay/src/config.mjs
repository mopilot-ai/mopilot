// Relay configuration: the environment read once into a frozen object, with every default and every refusal in one place.
import { readFileSync } from 'node:fs';
import { DEFAULT_LIMITS } from './limits.mjs';

const int = (/** @type {string|undefined} */ v, /** @type {number} */ d, /** @type {string} */ name) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${v}`);
  return n;
};

/**
 * @typedef {{ keyPem: string, keyId: string, teamId: string, topic: string, sandbox: boolean }} ApnsKeys
 * @typedef {{ client_email: string, private_key: string, project_id: string, token_uri?: string }} FcmKey
 */

/** The env prefixes of the APNs credential sets, in the order a token is tried: APNS_* is the default set, APNS2_* the optional second (a second iOS app under another team or bundle id). */
const APNS_PREFIXES = ['APNS', 'APNS2'];

/** Every environment variable the APNs sets read (the names are built from the prefixes, so the settings reference check reads them from here). */
export const APNS_SETTING_NAMES = APNS_PREFIXES.flatMap((prefix) =>
  ['KEY', 'KEY_FILE', 'KEY_ID', 'TEAM_ID', 'TOPIC', 'SANDBOX'].map((n) => `${prefix}_${n}`),
);

/** The value an env var holds inline, or the contents of the file its `_FILE` twin names. */
const text = (/** @type {string|undefined} */ inline, /** @type {string|undefined} */ file) =>
  inline || (file ? readFileSync(file, 'utf8') : '');

/**
 * One APNs credential set from `<prefix>_KEY(_FILE)`, `_KEY_ID`, `_TEAM_ID`, `_TOPIC` and `_SANDBOX`: all or nothing. The default set (`APNS`)
 * with no key is no set, as it always was; any other prefix with some of its names set but no key is a mistake that would silently leave an app unpushed.
 * @returns {ApnsKeys | null}
 */
function apnsSet(/** @type {Record<string, string|undefined>} */ env, /** @type {string} */ prefix) {
  // an env var cannot hold line breaks, so the p8 PEM may spell them \n
  const p8 = text(env[`${prefix}_KEY`], env[`${prefix}_KEY_FILE`]).replace(/\\n/g, '\n');
  const [keyId, teamId, topic, sandbox] = ['KEY_ID', 'TEAM_ID', 'TOPIC', 'SANDBOX'].map((n) => env[`${prefix}_${n}`]);
  if (!p8) {
    if (prefix !== APNS_PREFIXES[0] && (keyId || teamId || topic || sandbox))
      throw new Error(`${prefix}_KEY(_FILE) is missing: the other ${prefix}_* settings need the p8 key.`);
    return null;
  }
  if (!keyId || !teamId || !topic)
    throw new Error(`${prefix}_KEY needs ${prefix}_KEY_ID, ${prefix}_TEAM_ID and ${prefix}_TOPIC (the app bundle id).`);
  return Object.freeze({ keyPem: p8, keyId, teamId, topic, sandbox: sandbox === '1' });
}

/**
 * The APNs sets a push config holds, in the order a token is tried: `apnsSets` when the config has them, else the one `apns`.
 * @param {{ apns?: ApnsKeys | null, apnsSets?: ApnsKeys[] }} push
 * @returns {ApnsKeys[]}
 */
export function apnsSetsOf(push) {
  return push.apnsSets ?? (push.apns ? [push.apns] : []);
}

/** The operator's own provider credentials (PUSH_MODE=direct): the APNs p8 keys (one set per iOS app) and the FCM service account, each optional but at least one. */
function directKeys(/** @type {Record<string, string|undefined>} */ env) {
  // the JSON service account escapes its own line breaks
  const sa = text(env.FCM_SERVICE_ACCOUNT, env.FCM_SERVICE_ACCOUNT_FILE);
  const apnsSets = /** @type {ApnsKeys[]} */ (APNS_PREFIXES.map((prefix) => apnsSet(env, prefix)).filter(Boolean));
  if (!apnsSets.length && !sa) throw new Error('PUSH_MODE=direct needs APNS_KEY(_FILE) and/or FCM_SERVICE_ACCOUNT(_FILE).');
  // the topic names the set a token is remembered under, so two sets cannot share one
  if (new Set(apnsSets.map((set) => set.topic)).size < apnsSets.length)
    throw new Error('Each APNs set needs its own topic: APNS_TOPIC and APNS2_TOPIC are the same.');
  const apns = apnsSets[0] ?? null;
  let fcm = /** @type {FcmKey | null} */ (null);
  if (sa) {
    let parsed;
    try {
      parsed = JSON.parse(sa);
    } catch {
      throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON.');
    }
    if (!parsed?.client_email || !parsed.private_key || !parsed.project_id)
      throw new Error('FCM_SERVICE_ACCOUNT needs client_email, private_key and project_id.');
    fcm = Object.freeze({
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      project_id: parsed.project_id,
      token_uri: parsed.token_uri,
    });
  }
  return { apns, apnsSets, fcm };
}

/** An https origin whose host is plain DNS labels (and a port): nothing else a URL allows in a host (`;`, `$( )`, backticks) can reach the shell command the app shows. */
export const PLAIN_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
/** BOOT_ORIGIN as a plain https origin (`https://boot.example`), or null when unset; anything else stops the relay from starting. @param {string | undefined} v */
function originOf(v) {
  const text = v?.trim().replace(/\/$/, '');
  if (!text) return null;
  if (!PLAIN_ORIGIN.test(text)) throw new Error(`BOOT_ORIGIN must be an https origin like https://boot.example, not ${JSON.stringify(v)}`);
  return text;
}

/** The clock tolerance in seconds: 0 to 59 (a socket whose token expired is closed a minute later, and a tolerance of that size would let a token connect only to be closed). */
function clockTolerance(/** @type {string | undefined} */ v) {
  if (v === undefined || v === '') return 5;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= 60)
    throw new Error(`AUTH_CLOCK_TOLERANCE_SECONDS must be a whole number from 0 to 59, got ${v}`);
  return n;
}

/** @typedef {ReturnType<typeof loadConfig>} RelayConfig */

/**
 * @param {Record<string, string|undefined>} env
 */
export function loadConfig(env) {
  const publicKeyPem = (env.AUTH_PUBLIC_KEY || (env.AUTH_PUBLIC_KEY_FILE ? readFileSync(env.AUTH_PUBLIC_KEY_FILE, 'utf8') : '')).replace(
    /\\n/g,
    '\n',
  );
  const jwksUrl = env.AUTH_JWKS_URL || '';
  if (!publicKeyPem && !jwksUrl)
    throw new Error('Set AUTH_PUBLIC_KEY (PEM) or AUTH_JWKS_URL: the relay verifies the account JWT with the public half only.');
  if (publicKeyPem && jwksUrl) throw new Error('Set only one of AUTH_PUBLIC_KEY and AUTH_JWKS_URL.');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const pushMode = env.PUSH_MODE || 'none';
  if (!['none', 'proxy', 'direct', 'dryrun'].includes(pushMode))
    throw new Error(`PUSH_MODE must be none, proxy, direct or dryrun, got ${pushMode}`);
  if (pushMode === 'proxy' && !env.PUSH_PROXY_URL) throw new Error('PUSH_MODE=proxy needs PUSH_PROXY_URL.');
  const direct = pushMode === 'direct' ? directKeys(env) : {};
  return Object.freeze({
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8787, 'PORT'),
    databaseUrl: env.DATABASE_URL,
    db: Object.freeze({
      poolMax: int(env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
      statementTimeoutMs: int(env.DB_STATEMENT_TIMEOUT_SECONDS, 15, 'DB_STATEMENT_TIMEOUT_SECONDS') * 1000,
    }),
    shutdownMs: int(env.SHUTDOWN_SECONDS, 8, 'SHUTDOWN_SECONDS') * 1000,
    /** /metrics answers only a request carrying this bearer token; empty leaves the endpoint off */
    metricsToken: (env.METRICS_TOKEN ?? '').trim(),
    trustProxy: env.TRUST_PROXY === '1',
    /** where Add by command boots are served (an https origin of its own, finding H-2); empty: on whatever host reaches the relay */
    bootOrigin: originOf(env.BOOT_ORIGIN),
    /** how long the database may take to answer /healthz and /readyz before they say it is down */
    healthTimeoutMs: int(env.HEALTH_DB_TIMEOUT_MS, 2000, 'HEALTH_DB_TIMEOUT_MS'),
    limits: Object.freeze({
      maxConnections: int(env.MAX_CONNECTIONS, DEFAULT_LIMITS.maxConnections, 'MAX_CONNECTIONS'),
      maxConnectionsPerAccount: int(
        env.MAX_CONNECTIONS_PER_ACCOUNT,
        DEFAULT_LIMITS.maxConnectionsPerAccount,
        'MAX_CONNECTIONS_PER_ACCOUNT',
      ),
      frameRate: int(env.CONN_FRAMES_PER_SECOND, DEFAULT_LIMITS.frameRate, 'CONN_FRAMES_PER_SECOND'),
      frameBurst: int(env.CONN_FRAME_BURST, DEFAULT_LIMITS.frameBurst, 'CONN_FRAME_BURST'),
      pairFrameRate: int(env.PAIR_FRAMES_PER_SECOND, DEFAULT_LIMITS.pairFrameRate, 'PAIR_FRAMES_PER_SECOND'),
      pairFrameBurst: int(env.PAIR_FRAME_BURST, DEFAULT_LIMITS.pairFrameBurst, 'PAIR_FRAME_BURST'),
      controlRate: int(env.CONN_MESSAGES_PER_SECOND, DEFAULT_LIMITS.controlRate, 'CONN_MESSAGES_PER_SECOND'),
      controlBurst: int(env.CONN_MESSAGE_BURST, DEFAULT_LIMITS.controlBurst, 'CONN_MESSAGE_BURST'),
      receiptRate: int(env.CONN_RECEIPTS_PER_SECOND, DEFAULT_LIMITS.receiptRate, 'CONN_RECEIPTS_PER_SECOND'),
      receiptBurst: int(env.CONN_RECEIPT_BURST, DEFAULT_LIMITS.receiptBurst, 'CONN_RECEIPT_BURST'),
      connectRate: int(env.CONNECTS_PER_SECOND, DEFAULT_LIMITS.connectRate, 'CONNECTS_PER_SECOND'),
      connectBurst: int(env.CONNECT_BURST, DEFAULT_LIMITS.connectBurst, 'CONNECT_BURST'),
      maxWaitMs: int(env.RATE_WAIT_MAX_SECONDS, DEFAULT_LIMITS.maxWaitMs / 1000, 'RATE_WAIT_MAX_SECONDS') * 1000,
      globalMaxFrames: int(env.MAILBOX_GLOBAL_MAX_FRAMES, DEFAULT_LIMITS.globalMaxFrames, 'MAILBOX_GLOBAL_MAX_FRAMES'),
      globalMaxBytes: int(env.MAILBOX_GLOBAL_MAX_BYTES, DEFAULT_LIMITS.globalMaxBytes, 'MAILBOX_GLOBAL_MAX_BYTES'),
      accountMaxFrames: int(env.MAILBOX_ACCOUNT_MAX_FRAMES, DEFAULT_LIMITS.accountMaxFrames, 'MAILBOX_ACCOUNT_MAX_FRAMES'),
      accountMaxBytes: int(env.MAILBOX_ACCOUNT_MAX_BYTES, DEFAULT_LIMITS.accountMaxBytes, 'MAILBOX_ACCOUNT_MAX_BYTES'),
      pairsPerAccount: int(env.PAIRS_PER_ACCOUNT, DEFAULT_LIMITS.pairsPerAccount, 'PAIRS_PER_ACCOUNT'),
      hostsPerAccount: int(env.HOSTS_PER_ACCOUNT, DEFAULT_LIMITS.hostsPerAccount, 'HOSTS_PER_ACCOUNT'),
      bootsPerDay: int(env.BOOTS_PER_DAY, DEFAULT_LIMITS.bootsPerDay, 'BOOTS_PER_DAY'),
      hostAuthRate: int(env.HOST_AUTH_PER_SECOND, DEFAULT_LIMITS.hostAuthRate, 'HOST_AUTH_PER_SECOND'),
      hostAuthBurst: int(env.HOST_AUTH_BURST, DEFAULT_LIMITS.hostAuthBurst, 'HOST_AUTH_BURST'),
      hostAddressRate: int(env.HOST_AUTH_ADDRESS_PER_SECOND, DEFAULT_LIMITS.hostAddressRate, 'HOST_AUTH_ADDRESS_PER_SECOND'),
      hostAddressBurst: int(env.HOST_AUTH_ADDRESS_BURST, DEFAULT_LIMITS.hostAddressBurst, 'HOST_AUTH_ADDRESS_BURST'),
    }),
    auth: Object.freeze({
      publicKeyPem,
      jwksUrl,
      issuer: env.AUTH_ISSUER || 'https://code.mopilot.ai',
      audience: env.AUTH_AUDIENCE || 'relay',
      revokeAudience: env.AUTH_REVOKE_AUDIENCE || 'relay-revoke',
      /** the audience of the signed request that deletes an account's data (POST /v1/account/purge) */
      purgeAudience: env.AUTH_PURGE_AUDIENCE || 'relay-purge',
      /** the audience of the signed request that switches an account's relay access off or on (POST /v1/account/access) */
      accessAudience: env.AUTH_ACCESS_AUDIENCE || 'relay-access',
      /** how far apart the relay's clock and the account server's may be before a token reads as expired or not yet valid */
      clockToleranceS: clockTolerance(env.AUTH_CLOCK_TOLERANCE_SECONDS),
    }),
    mailbox: Object.freeze({
      ttlMs: int(env.MAILBOX_TTL_DAYS, 7, 'MAILBOX_TTL_DAYS') * 24 * 3600_000,
      maxFrames: int(env.MAILBOX_MAX_FRAMES, 5000, 'MAILBOX_MAX_FRAMES'),
      maxBytes: int(env.MAILBOX_MAX_BYTES, 64 * 1024 * 1024, 'MAILBOX_MAX_BYTES'),
    }),
    // frames stay stored until the receiver acks them; DURABLE_MAILBOX=0 returns to delete-after-send
    durable: env.DURABLE_MAILBOX !== '0',
    pairJoinMs: int(env.PAIR_JOIN_SECONDS, 180, 'PAIR_JOIN_SECONDS') * 1000,
    pingMs: int(env.PING_SECONDS, 30, 'PING_SECONDS') * 1000,
    sweepMs: int(env.SWEEP_SECONDS, 300, 'SWEEP_SECONDS') * 1000,
    push: Object.freeze(
      /** @type {{ mode: string, proxyUrl: string, proxyToken: string, timeoutMs: number, breakerFailures: number, breakerCooldownMs: number, maxInFlight: number, apns?: ApnsKeys | null, apnsSets?: ApnsKeys[], fcm?: FcmKey | null }} */ ({
        mode: pushMode,
        proxyUrl: env.PUSH_PROXY_URL || '',
        proxyToken: env.PUSH_PROXY_TOKEN || '',
        /** how long one request to a provider may take, how many failures in a row put a provider on hold and for how long, and how many requests may be in flight */
        timeoutMs: int(env.PUSH_TIMEOUT_SECONDS, 10, 'PUSH_TIMEOUT_SECONDS') * 1000,
        breakerFailures: int(env.PUSH_BREAKER_FAILURES, 5, 'PUSH_BREAKER_FAILURES'),
        breakerCooldownMs: int(env.PUSH_BREAKER_COOLDOWN_SECONDS, 30, 'PUSH_BREAKER_COOLDOWN_SECONDS') * 1000,
        maxInFlight: int(env.PUSH_MAX_IN_FLIGHT, 32, 'PUSH_MAX_IN_FLIGHT'),
        ...direct,
      }),
    ),
  });
}
