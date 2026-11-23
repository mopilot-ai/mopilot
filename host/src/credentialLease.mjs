// The model credentials the app lent this Host: Tier 1 model keys (`host.modelKey`, shared/host/credentials.mjs) and Tier 2 organization leases (`host.orgLease`, shared/host/orgAccess.mjs), held per (harness, org identity). Held in this process's memory only, never written, logged, put on a command line or reported; given only to the harness process that reads it, and dropped when the app takes it back, a lease runs out or the Host exits. A harness with an organization lease uses it before a key.
import { hashLine } from '../../shared/host/audit.mjs';
import { KEYED } from '../../shared/host/credentials.mjs';

/** @typedef {{ identity: string, token: string, gateways: Partial<Record<'anthropic' | 'openai', string>>, expiresAt: number }} OrgLease */
/**
 * @typedef {'changed' | 'renewed' | 'switched'} Change `renewed`: only the token of the identity in use changed, so a process that asks for the
 * token each time (Claude Code's key helper) keeps going; `switched`: another identity is in use now, so a process bound to its own identity
 * (a Claude Code CLI) keeps going, and one shared by every chat (Codex's app-server, an ACP agent) is started again between turns.
 */

/** @param {string} harness @param {string} identity */
const slot = (harness, identity) => `${harness}\n${identity}`;
/** Whether two leases name the same gateways (leaseOf builds them in one order). @param {Record<string, string>} a @param {Record<string, string>} b */
/** An identity as the audit record names it: a short hash, never the identity itself. @param {string} identity */
const orgOf = (identity) => hashLine(identity).slice(0, 16);
const sameGateways = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void }} [timers] when a lease runs out (tests bring a fake clock)
 * @param {{ governed: (e: any) => boolean, note: (e: any) => void }} [audit] the audit record: a key or lease lent is written before it is held (`audit.required` refuses it otherwise), a lease running out is noted; by kind and identity hash only
 */
export function createCredentialLeases(
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref?.(), clearTimeout },
  audit = { governed: () => true, note: () => undefined },
) {
  /** @type {Map<string, string>} the key each harness was lent */
  const held = new Map();
  /** @type {Map<string, OrgLease & { timer: any }>} each (harness, identity)'s organization lease */
  const org = new Map();
  /** @type {Map<string, string>} the identity whose message went out last for each harness: a process started now is started for it */
  const active = new Map();
  /** @type {Set<(harness: string, change: Change) => void>} told when a harness's credential changes: a process started with the old one lets it go */
  const listeners = new Set();
  /** @param {string} harness @param {Change} [change] */
  const changed = (harness, change = 'changed') => {
    for (const fn of [...listeners]) fn(harness, change);
  };
  /** Drops one lease; true when it was held. @param {string} key */
  const drop = (key) => {
    const had = org.get(key);
    if (!had) return false;
    timers.clearTimeout(had.timer);
    org.delete(key);
    return true;
  };
  /** The lease in use for `harness` (the active identity's), or another identity's when asked by name. @param {string} harness @param {string} [identity] */
  const leaseOf = (harness, identity) => {
    const who = identity ?? active.get(harness);
    return who ? (org.get(slot(harness, who)) ?? null) : null;
  };
  return {
    /**
     * Lend `harness` a key, or take it back (null). The schema has checked both (shared/host/schema.mjs `host.modelKey`).
     * @param {string} harness @param {string | null} key
     */
    set(harness, key) {
      if (key !== null) audit.governed({ kind: 'credential.lent', harness, what: { kind: 'key' } });
      const before = held.get(harness) ?? null;
      if (key === null) held.delete(harness);
      else held.set(harness, key);
      // the same key lent again with the next message changes nothing
      if (before !== key) changed(harness);
      return { held: held.has(harness) };
    },
    /**
     * Hold `identity`'s organization lease for `harness` until it ends, replacing that identity's one before (newest wins), or take
     * that identity's back (token null): another identity's lease is never touched. A lease lent makes its identity the one in use.
     * The schema has checked it (`host.orgLease`).
     * @param {{ harness: string, identity: string, token: string | null, gateways?: OrgLease['gateways'], expiresAt?: number }} lease @param {number} now
     */
    setOrg(lease, now) {
      const { harness, identity } = lease;
      if (lease.token !== null) audit.governed({ kind: 'credential.lent', harness, org: orgOf(identity), what: { kind: 'org' } });
      const key = slot(harness, identity);
      const wasActive = active.get(harness);
      const before = org.get(key);
      if (lease.token === null) {
        const dropped = drop(key);
        if (wasActive === identity) active.delete(harness);
        if (dropped && wasActive === identity) changed(harness);
        return { held: false };
      }
      const gateways = /** @type {OrgLease['gateways']} */ (lease.gateways);
      const expiresAt = /** @type {number} */ (lease.expiresAt);
      active.set(harness, identity);
      const same = before?.token === lease.token && before.expiresAt === expiresAt && sameGateways(before.gateways, gateways);
      if (same && wasActive === identity) return { held: true };
      if (!same) {
        drop(key);
        const token = lease.token;
        const timer = timers.setTimeout(() => {
          // the lease ran out with no fresh one: that identity has none from now on
          if (org.get(key)?.token !== token || !drop(key)) return;
          audit.note({ kind: 'credential.expired', harness, org: orgOf(identity), what: { kind: 'org' } });
          if (active.get(harness) === identity) changed(harness);
        }, expiresAt - now);
        org.set(key, { identity, token, gateways, expiresAt, timer });
      }
      // a new token for the identity in use, with the same gateways, is a renewal; another identity or other gateways is a new credential
      if (wasActive && wasActive !== identity) changed(harness, 'switched');
      else changed(harness, before && sameGateways(before.gateways, gateways) ? 'renewed' : 'changed');
      return { held: true };
    },
    /** The organization lease in use for `harness` (or `identity`'s), or null. @param {string} harness @param {string} [identity] @returns {OrgLease | null} */
    orgLease(harness, identity) {
      const l = leaseOf(harness, identity);
      return l ? { identity: l.identity, token: l.token, gateways: l.gateways, expiresAt: l.expiresAt } : null;
    },
    /** The active organization's opaque principal, for routing that needs no credential. @param {string} harness */
    orgIdentity: (harness) => leaseOf(harness)?.identity,
    /**
     * What `harness`'s process gets in its environment. With an organization lease in use: the gateway addresses, and for a harness that
     * reads the token from its env (an ACP agent) the token; Claude Code asks for it through its key helper (./orgKeyHelper.mjs) and Codex
     * through its model provider (./codexFamily.mjs), so neither gets it here. Without one: its key under the name it reads, or nothing.
     * @param {string} harness @returns {Record<string, string>}
     */
    envFor(harness) {
      const lease = leaseOf(harness);
      if (lease) {
        const { anthropic, openai } = lease.gateways;
        if (harness === 'claude') return anthropic ? { ANTHROPIC_BASE_URL: anthropic } : {};
        if (harness !== 'acp') return {};
        return {
          ...(anthropic ? { ANTHROPIC_BASE_URL: anthropic, ANTHROPIC_AUTH_TOKEN: lease.token } : {}),
          ...(openai ? { OPENAI_BASE_URL: openai, OPENAI_API_KEY: lease.token } : {}),
        };
      }
      const key = held.get(harness);
      const k = Object.hasOwn(KEYED, harness) ? KEYED[/** @type {keyof typeof KEYED} */ (harness)] : null;
      return key && k?.via === 'env' ? { [k.env]: key } : {};
    },
    /** The key a harness that is told it over its own protocol logs in with (Codex's app-server); null when none is lent or an organization lease is in use. @param {string} harness */
    loginKey(harness) {
      if (leaseOf(harness)) return null;
      const k = Object.hasOwn(KEYED, harness) ? KEYED[/** @type {keyof typeof KEYED} */ (harness)] : null;
      return k?.via === 'login' ? (held.get(harness) ?? null) : null;
    },
    /** Whether `harness` holds a key or an organization lease in use now (never which one). @param {string} harness */
    has: (harness) => held.has(harness) || !!leaseOf(harness),
    /** Whether `harness` holds a lent key now (an organization lease may be in use beside it). @param {string} harness */
    hasKey: (harness) => held.has(harness),
    /** Whether `harness` has an organization lease in use now. @param {string} harness */
    hasOrg: (harness) => !!leaseOf(harness),
    /** Every key and lease goes (the Host is told to forget them all). */
    clear() {
      const had = new Set([...held.keys(), ...[...active.keys()].filter((h) => leaseOf(h))]);
      for (const key of [...org.keys()]) drop(key);
      active.clear();
      held.clear();
      had.forEach((h) => changed(h));
    },
    /** Told with the harness whose credential was lent, changed, renewed or taken back. @param {(harness: string, change: Change) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
