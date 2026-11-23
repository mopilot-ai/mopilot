// The managed policy document (plan W1, #2685): where an admin's root-owned file lives, whether it can be trusted, its schema and parser, the strict fallback, and the stricter-wins helpers. Shared by the app's resolver and the Host's managed layer so the two read one document the same way.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const MANAGED_VERSION = 1;
export const MANAGED_FILE = 'managed-policy.json';
/** Permission modes from least to most trusting (the same order the Host's owner policy uses). */
export const PERMISSION_LEVELS = Object.freeze(['read-only', 'default', 'auto-review', 'full-access']);
/** Computer-use grant levels from least to most trusting. */
export const COMPUTER_LEVELS = Object.freeze(['view', 'click', 'full']);
export const AUDIT_DETAIL = Object.freeze(['metadata', 'full']);
const MAX_USD = 1_000_000;

/**
 * Where the file lives. `product` is the Mac app or a Host; a Host on macOS and the app read different folders so one admin file never governs both by accident.
 * @param {{ platform: string, product: 'app' | 'host', env?: Record<string, string | undefined> }} o
 */
export function managedPolicyPath({ platform, product, env = {} }) {
  if (platform === 'win32') {
    const base = env.ProgramData || 'C:\\ProgramData';
    return path.win32.join(base, product === 'host' ? 'MoPilot Host' : 'MoPilot Code', MANAGED_FILE);
  }
  if (platform === 'darwin') {
    return path.posix.join('/Library/Application Support', product === 'host' ? 'MoPilot Host' : 'MoPilot Code', MANAGED_FILE);
  }
  return path.posix.join('/etc', product === 'host' ? 'mopilot-host' : 'mopilot-code', MANAGED_FILE);
}

/**
 * Why a file cannot be trusted, or null. The rule (#2685): the user the app runs as must not be able to write it, so it is owned by root and
 * neither group- nor world-writable. Windows ACLs are not read; the ProgramData folder is administrator-writable only by default.
 * @param {{ uid: number, mode: number }} stat @param {string} platform
 */
export function untrustedReason(stat, platform) {
  if (platform === 'win32') return null;
  if (stat.uid !== 0) return 'The managed policy file is not owned by root, so it was ignored.';
  if ((stat.mode & 0o022) !== 0) return 'The managed policy file can be written by someone other than root, so it was ignored.';
  return null;
}

const isObj = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 2048;

/** @param {unknown} v @param {string} what @param {(m: string) => Error} bad */
function list(v, what, bad) {
  if (!Array.isArray(v) || v.length > 1000 || !v.every(text)) throw bad(`${what} must be a list of text values.`);
  return /** @type {string[]} */ ([...new Set(v)]);
}

/** @param {unknown} v @param {string} what @param {(m: string) => Error} bad */
function flag(v, what, bad) {
  if (typeof v !== 'boolean') throw bad(`${what} must be true or false.`);
  return v;
}

/** @param {unknown} v @param {string} what @param {(m: string) => Error} bad */
function block(v, what, bad) {
  if (!isObj(v)) throw bad(`${what} must be an object.`);
  return /** @type {Record<string, any>} */ (v);
}

/** @param {unknown} v @param {string} what @param {(m: string) => Error} bad */
function url(v, what, bad) {
  if (!text(v)) throw bad(`${what} must be an address.`);
  try {
    const u = new URL(/** @type {string} */ (v));
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(u.protocol)) throw new Error('scheme');
  } catch {
    throw bad(`${what} must be an address.`);
  }
  return /** @type {string} */ (v);
}

/** @param {unknown} v @param {string} what @param {(m: string) => Error} bad */
function usd(v, what, bad) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_USD) throw bad(`${what} must be an amount in dollars above zero.`);
  return v;
}

/** @param {unknown} v @param {string} what @param {number} max @param {(m: string) => Error} bad */
function whole(v, what, max, bad) {
  if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > max)
    throw bad(`${what} must be a whole number from 1 to ${max}.`);
  return /** @type {number} */ (v);
}

/** @param {unknown} v @param {readonly string[]} allowed @param {string} what @param {(m: string) => Error} bad */
function oneOf(v, allowed, what, bad) {
  if (typeof v !== 'string' || !allowed.includes(v)) throw bad(`${what} must be one of: ${allowed.join(', ')}.`);
  return v;
}

/**
 * The org sign-in block: passed through as typed values; the sign-in service (W4) decides what a missing key means.
 * @param {any} raw @param {(m: string) => Error} bad
 */
function parseOrgAccess(raw, bad) {
  const b = block(raw, 'orgAccess', bad);
  /** @type {Record<string, any>} */
  const out = {};
  if (b.issuer !== undefined) out.issuer = url(b.issuer, 'orgAccess.issuer', bad);
  if (b.clientId !== undefined) {
    if (!text(b.clientId)) throw bad('orgAccess.clientId must be text.');
    out.clientId = b.clientId;
  }
  if (b.scopes !== undefined) out.scopes = list(b.scopes, 'orgAccess.scopes', bad);
  if (b.gateways !== undefined) {
    const g = block(b.gateways, 'orgAccess.gateways', bad);
    out.gateways = {};
    for (const k of ['anthropic', 'openai']) if (g[k] !== undefined) out.gateways[k] = url(g[k], `orgAccess.gateways.${k}`, bad);
  }
  if (b.leaseHours !== undefined) out.leaseHours = whole(b.leaseHours, 'orgAccess.leaseHours', 168, bad);
  return out;
}

/**
 * A managed document, checked whole: unknown keys are dropped, every key is optional, an invalid value refuses the document (never a half-applied one).
 * @param {unknown} doc @param {(m: string) => Error} bad
 */
export function parseManagedPolicy(doc, bad) {
  if (!isObj(doc)) throw bad('That is not a policy.');
  const d = /** @type {Record<string, any>} */ (doc);
  if (d.version !== MANAGED_VERSION) throw bad('This policy is a version this build cannot read.');
  /** @type {Record<string, any>} */
  const out = { version: MANAGED_VERSION };
  if (d.organization !== undefined) {
    if (!text(d.organization)) throw bad('organization must be text.');
    out.organization = d.organization;
  }
  if (d.harnesses !== undefined) {
    const b = block(d.harnesses, 'harnesses', bad);
    out.harnesses = b.allow === undefined ? {} : { allow: list(b.allow, 'harnesses.allow', bad) };
  }
  if (d.permission !== undefined) {
    const b = block(d.permission, 'permission', bad);
    out.permission = b.max === undefined ? {} : { max: oneOf(b.max, PERMISSION_LEVELS, 'permission.max', bad) };
  }
  if (d.accounts !== undefined) {
    const b = block(d.accounts, 'accounts', bad);
    out.accounts = b.rotation === undefined ? {} : { rotation: flag(b.rotation, 'accounts.rotation', bad) };
  }
  if (d.computerUse !== undefined) {
    const b = block(d.computerUse, 'computerUse', bad);
    out.computerUse = {};
    if (b.maxLevel !== undefined) out.computerUse.maxLevel = oneOf(b.maxLevel, COMPUTER_LEVELS, 'computerUse.maxLevel', bad);
    if (b.denyApps !== undefined) out.computerUse.denyApps = list(b.denyApps, 'computerUse.denyApps', bad);
    if (b.allowAlways !== undefined) out.computerUse.allowAlways = flag(b.allowAlways, 'computerUse.allowAlways', bad);
  }
  if (d.browser !== undefined) {
    const b = block(d.browser, 'browser', bad);
    out.browser = {};
    if (b.denySites !== undefined) out.browser.denySites = list(b.denySites, 'browser.denySites', bad);
    if (b.allowSites !== undefined) out.browser.allowSites = list(b.allowSites, 'browser.allowSites', bad);
  }
  if (d.connectors !== undefined) {
    const b = block(d.connectors, 'connectors', bad);
    out.connectors = b.allow === undefined ? {} : { allow: list(b.allow, 'connectors.allow', bad) };
  }
  if (d.hosts !== undefined) {
    const b = block(d.hosts, 'hosts', bad);
    out.hosts = {};
    if (b.approvals !== undefined) {
      const a = block(b.approvals, 'hosts.approvals', bad);
      out.hosts.approvals =
        a.pauseMinutesMax === undefined ? {} : { pauseMinutesMax: whole(a.pauseMinutesMax, 'hosts.approvals.pauseMinutesMax', 720, bad) };
    }
    if (b.clients !== undefined) {
      const c = block(b.clients, 'hosts.clients', bad);
      out.hosts.clients = c.phone === undefined ? {} : { phone: flag(c.phone, 'hosts.clients.phone', bad) };
    }
    if (b.credentials !== undefined) {
      const c = block(b.credentials, 'hosts.credentials', bad);
      out.hosts.credentials = c.orgOnly === undefined ? {} : { orgOnly: flag(c.orgOnly, 'hosts.credentials.orgOnly', bad) };
    }
    if (b.roots !== undefined) out.hosts.roots = list(b.roots, 'hosts.roots', bad);
  }
  if (d.orgAccess !== undefined) out.orgAccess = parseOrgAccess(d.orgAccess, bad);
  if (d.endpoints !== undefined) {
    const b = block(d.endpoints, 'endpoints', bad);
    out.endpoints = {};
    for (const k of ['relay', 'api']) if (b[k] !== undefined) out.endpoints[k] = url(b[k], `endpoints.${k}`, bad);
  }
  if (d.audit !== undefined) {
    const b = block(d.audit, 'audit', bad);
    out.audit = {};
    if (b.required !== undefined) out.audit.required = flag(b.required, 'audit.required', bad);
    if (b.retentionDays !== undefined) out.audit.retentionDays = whole(b.retentionDays, 'audit.retentionDays', 3650, bad);
    if (b.detail !== undefined) out.audit.detail = oneOf(b.detail, AUDIT_DETAIL, 'audit.detail', bad);
  }
  if (d.spend !== undefined) {
    const b = block(d.spend, 'spend', bad);
    out.spend = {};
    for (const k of ['dayUsdMax', 'chatUsdMax']) if (b[k] !== undefined) out.spend[k] = usd(b[k], `spend.${k}`, bad);
  }
  if (d.cloud !== undefined) {
    const b = block(d.cloud, 'cloud', bad);
    out.cloud = {};
    if (b.allow !== undefined) out.cloud.allow = flag(b.allow, 'cloud.allow', bad);
    if (b.providers !== undefined) out.cloud.providers = list(b.providers, 'cloud.providers', bad);
    if (b.machinesMax !== undefined) out.cloud.machinesMax = whole(b.machinesMax, 'cloud.machinesMax', 1000, bad);
    if (b.idleMinutesMax !== undefined) out.cloud.idleMinutesMax = whole(b.idleMinutesMax, 'cloud.idleMinutesMax', 10080, bad);
    if (b.hoursPerDayMax !== undefined) out.cloud.hoursPerDayMax = whole(b.hoursPerDayMax, 'cloud.hoursPerDayMax', 24, bad);
    if (b.network !== undefined) out.cloud.network = oneOf(b.network, ['limited', 'open'], 'cloud.network', bad);
  }
  return out;
}

/**
 * What applies when a file exists but has never been valid: the strict fallback. No full computer use, no "Always allow", rotation off, permission at
 * Default, no phone clients. Never the same as "no policy".
 */
export const STRICT_FALLBACK = Object.freeze({
  version: MANAGED_VERSION,
  permission: Object.freeze({ max: 'default' }),
  accounts: Object.freeze({ rotation: false }),
  computerUse: Object.freeze({ maxLevel: 'click', allowAlways: false }),
  hosts: Object.freeze({ clients: Object.freeze({ phone: false }) }),
});

/** The less trusting of two values on an ordered scale; a missing side yields the other. @param {readonly string[]} order @param {string | undefined} a @param {string | undefined} b */
export function stricterOf(order, a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/** Deny lists union: a managed entry is added to the user's. @param {string[] | undefined} user @param {string[] | undefined} managed */
export const unionDeny = (user, managed) => [...new Set([...(user ?? []), ...(managed ?? [])])];

/** Allow lists intersect; a side that sets no list does not restrict. @param {string[] | undefined} user @param {string[] | undefined} managed */
export function intersectAllow(user, managed) {
  if (managed === undefined) return user;
  if (user === undefined) return [...managed];
  return user.filter((x) => managed.includes(x));
}

/** The smaller of two limits; a missing side yields the other. @param {number | undefined} user @param {number | undefined} managed */
export const minLimit = (user, managed) => (user === undefined ? managed : managed === undefined ? user : Math.min(user, managed));

const canonical = (/** @type {any} */ v) =>
  JSON.stringify(v, (_k, x) =>
    isObj(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

/** The generation of a managed document: a SHA-256 of its canonical form, so equal content hashes alike whatever the key order. @param {unknown} doc */
export const managedGeneration = (doc) => createHash('sha256').update(canonical(doc)).digest('hex');
