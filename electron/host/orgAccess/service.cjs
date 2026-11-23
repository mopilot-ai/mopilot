// Organization access in the app (#3361 Tier 2): the admin's settings (issuer, client id, gateways, lease hours; nothing secret), the person's IdP sign-in (its refresh token encrypted with safeStorage, whose key is in the login keychain; the access token in memory only), and the leases lent to machines: minted when a message goes out (remoteCredentials.cjs), renewed at 80% of their life while the sign-in holds, taken back on sign-out or when the admin removes it.
const crypto = require('node:crypto');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { encryptForStore } = require('../../platform/encryptedStore.cjs');
const { clock } = require('../../platform/ports/clock.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { ORG_HARNESSES, RENEW_AT, baseUrlOf, leaseHoursOf } = require('../../../shared/host/orgAccess.mjs');
const { accessOf, providerFor } = require('./providers.cjs');

/** A token with less than this share of its life left is refreshed before it is lent. */
const FRESH_SHARE = 1 - RENEW_AT;
/** The refusal a message waits on: one sign-in on this Mac lets it go (remoteSend.cjs `orgSignin`). */
const SIGNIN_REQUIRED = 'org_signin_required';

const refusal = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** The org identity a lease is held under on a Host: the issuer and the person's subject, hashed (opaque, nothing secret). @param {string} issuer @param {string} subject */
const identityOf = (issuer, subject) => crypto.createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, 32);

/** @typedef {{ issuer: string, clientId: string, scopes: string, leaseHours: number, access: import('./providers.cjs').Access }} Config */
/** @typedef {{ harness: string, identity: string, token: string, gateways: Record<string, string>, expiresAt: number }} Lease */
/** @typedef {{ orgLease: (p: { harness: string, identity: string, token: string | null, gateways?: Record<string, string>, expiresAt?: number }) => Promise<unknown>, state?: () => string }} LeaseHost */

/** The admin's settings, checked; a refusal names what is wrong. @param {unknown} c @returns {Config} */
function configOf(c) {
  const o = /** @type {any} */ (c ?? {});
  const issuer = baseUrlOf(o.issuer);
  if (!issuer) throw refusal('The issuer must be an https address.', 'invalid');
  if (typeof o.clientId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(o.clientId)) throw refusal('Give the client id.', 'invalid');
  const scopes = typeof o.scopes === 'string' && /^[\x20-\x7e]{0,512}$/.test(o.scopes) ? o.scopes.trim() : '';
  return { issuer, clientId: o.clientId, scopes, leaseHours: leaseHoursOf(o.leaseHours), access: accessOf(o.access) };
}

/**
 * The managed policy's `orgAccess` block as the admin's settings (plan W4): the same checks as typed ones, so a block that would not have been accepted by hand is not accepted from the file.
 * @param {any} block @returns {Config}
 */
const configOfManaged = (block) =>
  configOf({
    issuer: block.issuer,
    clientId: block.clientId,
    scopes: (block.scopes ?? []).join(' '),
    leaseHours: block.leaseHours,
    access: { kind: 'gateway', gateways: block.gateways },
  });

/**
 * @param {object} o
 * @param {string} o.file
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} o.safeStorage
 * @param {ReturnType<typeof import('./oidc.cjs').createOidcClient>} o.oidc
 * @param {typeof fetch} [o.fetch] for the token exchange adapter
 * @param {(error: Error) => void} [o.report] a renewal that failed for a reason other than the sign-in
 * @param {() => { orgAccess?: any, organization?: string | null, problem?: string | null } | null} [o.managed] the managed policy's view (plan W4); an `orgAccess` block in it replaces the typed settings
 */
function createOrgAccess({ file, safeStorage, oidc, fetch: fetchFn, report = () => undefined, managed = () => null }) {
  /** The settings the managed policy gives, or null when it gives none; kept (last good) when a rewritten block does not pass the checks. @type {Config | null} */
  let managedCfg = null;
  /** @type {{ organization: string, problem: string } | null} set while the policy carries an `orgAccess` block */
  let managedInfo = null;
  /** Counts the changes of managed settings, so a sign-in that began under the old ones can tell. */
  let epoch = 0;
  /** Reads the managed block now. */
  const readManaged = () => {
    const m = managed();
    if (m?.orgAccess === undefined) {
      managedCfg = null;
      managedInfo = null;
      return;
    }
    /** @type {string | null} */
    let problem = m.problem ?? null;
    try {
      managedCfg = configOfManaged(m.orgAccess);
    } catch (e) {
      problem = /** @type {Error} */ (e).message;
    }
    managedInfo = { organization: m.organization ?? '', problem: problem ?? '' };
  };
  readManaged();
  /** @type {{ accessToken: string, idToken?: unknown, expiresAt: number, issuedAt: number } | null} in memory only */
  let token = null;
  /** The sign-in under way, which a second click joins. @type {Promise<any> | null} */
  let signingIn = null;
  /** The refresh under way, which every lend and renewal joins. @type {Promise<{ accessToken: string, idToken?: unknown, expiresAt: number, issuedAt: number }> | null} */
  let refreshing = null;
  /** Set when the IdP refused the refresh token: the person signs in again. */
  let signinRequired = false;
  /** The harnesses each connection was lent a lease for, by the identity it was lent under: renewed together, taken back together. @type {Map<LeaseHost, Map<string, string>>} */
  const lent = new Map();
  /** @type {any} */
  let renewTimer = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };

  /** @returns {Record<string, any>} */
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return isJsonRecord(raw) ? raw : {};
    } catch {
      return {};
    }
  };
  /** @param {Record<string, any>} rec */
  const write = (rec) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivate(file, JSON.stringify(rec));
  };
  /** @param {string} field @returns {string | null} */
  const secret = (field) => {
    const enc = read()[field];
    if (typeof enc !== 'string' || !enc) return null;
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  };
  /** @param {string} field @param {string | null} value */
  const keep = (field, value) => {
    const rec = read();
    if (value === null) delete rec[field];
    else {
      const encrypted = encryptForStore(safeStorage, value);
      if (!encrypted.ok) throw refusal("This Mac can't encrypt the sign-in, so it was not kept.", 'unavailable');
      rec[field] = encrypted.value;
    }
    write(rec);
  };
  /** Whether a secret is kept, without decrypting it. @param {string} field */
  const kept = (field) => typeof read()[field] === 'string' && !!read()[field];
  /** The settings typed on this Mac. @returns {Config | null} */
  const fileConfig = () => {
    try {
      return read().config ? configOf(read().config) : null;
    } catch {
      return null;
    }
  };
  /** The settings in force: the managed policy's, else the typed ones. */
  const config = () => managedCfg ?? fileConfig();

  /** Every connection lent a lease takes it back; one that cannot be reached drops it when it ends. */
  async function takeBack() {
    const hosts = [...lent];
    lent.clear();
    clock.clearTimeout(renewTimer?.handle);
    renewTimer = null;
    // only this identity's leases: another person's on a shared machine stays; one that cannot be reached drops it when its lease ends
    await Promise.allSettled(
      hosts.flatMap(([host, harnesses]) => [...harnesses].map(([harness, identity]) => host.orgLease({ harness, identity, token: null }))),
    );
  }

  /** The person's sign-in is gone here: the token, the kept refresh token and (when the IdP offers it) the grant at the IdP. @param {Config | null} cfg */
  async function forget(cfg) {
    const refresh = secret('refresh');
    token = null;
    keep('refresh', null);
    const rec = read();
    delete rec.who;
    // kept as the one a machine may still hold a lease for (lent before this app restarted): the next message there takes it back
    if (typeof rec.identity === 'string') rec.former = rec.identity;
    delete rec.identity;
    write(rec);
    if (cfg && refresh) await oidc.revoke(cfg, refresh);
  }

  /** An access token with enough life left, refreshed when it has less (or when `force`d by a renewal). @param {Config} cfg @param {boolean} force */
  function freshToken(cfg, force) {
    const now = clock.now();
    if (!force && token && token.expiresAt - now > (token.expiresAt - token.issuedAt) * FRESH_SHARE) return Promise.resolve(token);
    // one refresh at a time: an IdP that rotates refresh tokens ends the grant when the same one is used twice
    refreshing ??= refreshNow(cfg, now).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** @param {Config} cfg @param {number} now */
  async function refreshNow(cfg, now) {
    const refresh = secret('refresh');
    if (!refresh) {
      // one kept that cannot be read (another Mac's file, a reset keychain) is no sign-in: the settings say so
      if (kept('refresh')) keep('refresh', null), changed();
      signinRequired = true;
      throw refusal('Sign in to your organization to send this.', SIGNIN_REQUIRED);
    }
    try {
      const t = await oidc.refresh(cfg, refresh, now);
      if (t.refreshToken && t.refreshToken !== refresh) keep('refresh', t.refreshToken);
      token = { accessToken: t.accessToken, idToken: t.idToken, expiresAt: t.expiresAt, issuedAt: now };
      signinRequired = false;
      return token;
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'signin_required') throw e;
      // the IdP ended the grant (expired, revoked, the person disabled): the kept token is no good
      token = null;
      keep('refresh', null);
      signinRequired = true;
      changed();
      throw refusal('Your organization sign-in ended. Sign in again to send this.', SIGNIN_REQUIRED);
    }
  }

  /** @param {string} harness @param {{ force?: boolean }} [o] @returns {Promise<Lease | null>} */
  async function leaseFor(harness, { force = false } = {}) {
    const cfg = config();
    if (!cfg || !Object.hasOwn(ORG_HARNESSES, harness)) return null;
    const wanted = ORG_HARNESSES[/** @type {keyof typeof ORG_HARNESSES} */ (harness)].gateways;
    /** @type {Record<string, string>} */
    const gateways = Object.fromEntries(
      wanted.filter((g) => cfg.access.gateways[g]).map((g) => [g, /** @type {string} */ (cfg.access.gateways[g])]),
    );
    // no gateway for this agent's API: it runs on the Tier 1 key or its own sign-in there
    if (!Object.keys(gateways).length) return null;
    const provider = providerFor(cfg.access, { fetch: fetchFn, staticKey: () => secret('orgKey') });
    const signedIn = provider.needsSignIn ? await freshToken(cfg, force) : null;
    const now = clock.now();
    const minted = await provider.mint(signedIn, now);
    // a key with no sign-in is the install's own: it is held under the issuer alone
    const identity = typeof read().identity === 'string' ? read().identity : identityOf(cfg.issuer, '');
    return { harness, identity, token: minted.token, gateways, expiresAt: Math.min(minted.expiresAt, now + cfg.leaseHours * 3_600_000) };
  }

  /** The next renewal, at 80% of the soonest lease's life. @param {Lease} lease */
  function scheduleRenewal(lease) {
    const now = clock.now();
    const at = now + (lease.expiresAt - now) * RENEW_AT;
    if (renewTimer && renewTimer.at <= at) return;
    clock.clearTimeout(renewTimer?.handle);
    renewTimer = { at, handle: clock.setTimeout(() => void renew(), Math.max(0, at - now)) };
  }

  /** Every lent lease gets a fresh token while the sign-in holds; a connection that is gone is dropped, a sign-in that ended shows on the chats when they next send. */
  async function renew() {
    renewTimer = null;
    // one fresh token for every lease: the first asks the IdP, the rest take it
    let force = true;
    for (const [host, harnesses] of [...lent]) {
      for (const harness of [...harnesses.keys()]) {
        try {
          const lease = await leaseFor(harness, { force });
          force = false;
          if (!lease) continue;
          await host.orgLease(lease);
          scheduleRenewal(lease);
        } catch (e) {
          if (/** @type {any} */ (e)?.code === SIGNIN_REQUIRED) return;
          // offline or another refusal: the next message lends it again
          lent.get(host)?.delete(harness);
          report(/** @type {Error} */ (e));
        }
      }
    }
  }

  return {
    /** What the settings show: never a token. */
    /** The identity signed in here, or null: what Sign out everywhere names to each machine. */
    identity: () => (typeof read().identity === 'string' ? read().identity : null),
    view() {
      const cfg = config();
      const signedIn = kept('refresh') || (!!cfg && !providerFor(cfg.access).needsSignIn);
      return {
        configured: !!cfg,
        config: cfg,
        state: !cfg ? 'off' : signedIn ? 'signedIn' : signinRequired ? 'signinRequired' : 'signedOut',
        who: typeof read().who === 'string' ? read().who : null,
        managed: managedInfo,
      };
    },
    /** Whether a lease can be had for `harness` without a sign-in first (the row reads "Org access"). @param {string} harness */
    covers(harness) {
      const cfg = config();
      if (!cfg || !Object.hasOwn(ORG_HARNESSES, harness)) return false;
      const wanted = ORG_HARNESSES[/** @type {keyof typeof ORG_HARNESSES} */ (harness)].gateways;
      return wanted.some((g) => !!cfg.access.gateways[g]) && (kept('refresh') || !providerFor(cfg.access).needsSignIn);
    },
    /**
     * The admin's settings. Changed settings end the sign-in and take every lease back (they were for the old ones).
     * @param {unknown} c
     */
    async configure(c) {
      if (managedInfo) throw refusal(`Managed by ${managedInfo.organization || 'your organization'}.`, 'managed');
      const cfg = configOf(c);
      const before = config();
      if (before && JSON.stringify(before) !== JSON.stringify(cfg)) {
        await takeBack();
        await forget(before);
      }
      write({ ...read(), config: cfg });
      changed();
      return this.view();
    },
    /** Signs the person in through the system browser; a second call joins the first. */
    signIn() {
      const cfg = config();
      if (!cfg) return Promise.reject(refusal('Organization access is not set up.', 'invalid'));
      const began = epoch;
      signingIn ??= (async () => {
        try {
          const t = await oidc.signIn(cfg, { now: clock.now });
          // the managed settings changed while the person was signing in: this sign-in was for the old ones
          if (began !== epoch) throw refusal('Your organization changed its sign-in settings. Sign in again.', 'invalid');
          if (!t.refreshToken)
            throw refusal("Your organization's sign-in gave no refresh token. Ask your admin to allow offline access.", 'invalid');
          keep('refresh', t.refreshToken);
          // another person signing in here is another identity: the first one's leases are taken back first
          const identity = identityOf(cfg.issuer, t.subject);
          if (read().identity && read().identity !== identity) await takeBack();
          write({ ...read(), who: t.who, identity });
          token = { accessToken: t.accessToken, expiresAt: t.expiresAt, issuedAt: clock.now() };
          signinRequired = false;
          changed();
          return this.view();
        } finally {
          signingIn = null;
        }
      })();
      return signingIn;
    },
    /** Signs out here and at the IdP, and every machine takes its lease back. */
    async signOut() {
      // nothing set up and nothing kept: nothing to tell anyone
      if (!config() && !kept('refresh') && !lent.size) return this.view();
      await takeBack();
      await forget(config());
      changed();
      return this.view();
    },
    /** The admin removes organization access: every lease is taken back, the sign-in ends and the settings go. */
    async remove() {
      if (managedInfo) throw refusal(`Managed by ${managedInfo.organization || 'your organization'}.`, 'managed');
      const cfg = config();
      await takeBack();
      await forget(cfg);
      keep('orgKey', null);
      const rec = read();
      delete rec.config;
      write(rec);
      changed();
      return this.view();
    },
    /** Keeps an org API key (the `staticKey` source), encrypted. @param {string | null} key */
    setOrgKey: (key) => keep('orgKey', key),
    /**
     * Lends `harness` its lease on `host` before a message goes out. false: there is no organization access for it (the caller lends the
     * Tier 1 key instead). Throws `org_signin_required` when the person must sign in again.
     * @param {LeaseHost} host @param {string} harness
     */
    async lend(host, harness) {
      /** @type {Lease | null} */
      let lease;
      try {
        lease = await leaseFor(harness);
      } catch (e) {
        const err = /** @type {any} */ (e);
        // the message waits: on a sign-in here, or (anything else the IdP or the exchange said) for the person to try again
        throw err?.code === SIGNIN_REQUIRED ? err : refusal(String(err?.message ?? e), 'org_unavailable');
      }
      if (!lease) {
        // no organization access now: a lease a machine may still hold from before (signed out, removed, the app restarted since) goes first
        const former = read().former;
        if (typeof former === 'string' && Object.hasOwn(ORG_HARNESSES, harness))
          await Promise.resolve(host.orgLease({ harness, identity: former, token: null })).catch((e) => {
            // an older Host never held one
            if (/** @type {any} */ (e)?.code !== 'feature_missing') throw e;
          });
        return false;
      }
      await host.orgLease(lease);
      const map = lent.get(host) ?? new Map();
      map.set(harness, lease.identity);
      lent.set(host, map);
      scheduleRenewal(lease);
      return true;
    },
    /** The managed policy changed: a changed `orgAccess` ends the sign-in (also one under way) and takes every lease back, as a typed change does. */
    async managedChanged() {
      const before = managedCfg ?? fileConfig();
      readManaged();
      if (JSON.stringify(before) !== JSON.stringify(config())) {
        epoch += 1;
        await takeBack();
        await forget(before);
      }
      changed();
    },
    /** Told when the settings or the sign-in change. @param {() => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    dispose() {
      clock.clearTimeout(renewTimer?.handle);
      renewTimer = null;
      lent.clear();
    },
  };
}

module.exports = { createOrgAccess, configOf, identityOf, SIGNIN_REQUIRED, ORG_UNAVAILABLE: 'org_unavailable' };
