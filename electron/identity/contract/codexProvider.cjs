// A Codex thread's own model provider (D-72, D-32): thread/start carries `modelProvider` and the
// definition in its config (`model_providers.<id>`), so a chat can run on MoPilot or a custom Responses
// endpoint without the app-server's login (~/.codex/auth.json) being rewritten. The key is never in the
// config: Codex runs auth.command (native/auth-command) at every thread/start, and that helper reads
// one keychain item main placed there. It must answer fast and never ask the user.
const crypto = require('node:crypto');
const path = require('node:path');
const { proc: childProcess } = require('../../platform/ports/proc.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { desktop } = require('../../../shared/edition.json');
const { fs } = require('../../platform/ports/fs.cjs');

const KEYCHAIN_SERVICE = `${desktop.appId}.codex-provider`;

/** Where auth-command lives: Contents/Helpers in a packaged app, native/auth-command/build in a checkout. */
function authCommandPath({ packaged = false, resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '../../..') } = {}) {
  return packaged
    ? path.join(resourcesPath, '..', 'Helpers', 'auth-command')
    : path.join(repoRoot, 'native/auth-command/build', 'auth-command');
}

/**
 * A provider id: stable, and safe as a TOML key. One per key (endpoint and account), so a thread that recorded it
 * resumes on its own key even when another key shares the endpoint (#2213); without an account, the id threads started
 * before that recorded, one per endpoint.
 * @param {string} baseUrl
 * @param {string} [account]
 */
function providerId(baseUrl, account) {
  const of = account === undefined ? String(baseUrl) : `${baseUrl}\n${account}`;
  return `sage_${crypto.createHash('sha256').update(of).digest('hex').slice(0, 10)}`;
}

/** The thread/start fragment for one provider: `modelProvider` plus the config that defines it. */
function providerFragment({ id, name, baseUrl, command, account }) {
  return {
    modelProvider: id,
    config: {
      model_providers: {
        [id]: {
          name,
          base_url: baseUrl,
          wire_api: 'responses',
          auth: { command, args: ['get', KEYCHAIN_SERVICE, account] },
        },
      },
    },
  };
}

/**
 * `params` with the fragment added; a provider the window chose itself stays. `kept` defines every added key's
 * provider without naming one: a thread that ran on a key resumes on it while no key is active (#2213).
 * @param {any} params
 * @param {ReturnType<typeof providerFragment> | null} fragment the active key's provider
 * @param {Record<string, unknown>} [kept] provider id -> definition (CodexProviders.definitions)
 */
function withProvider(params, fragment, kept = {}) {
  const p = params || {};
  if (p.modelProvider || (!fragment && !Object.keys(kept).length)) return p;
  const own = isJsonRecord(p.config?.model_providers) ? p.config.model_providers : {};
  const providers = { ...kept, ...own, ...fragment?.config.model_providers };
  return {
    ...p,
    ...(fragment ? { modelProvider: fragment.modelProvider } : {}),
    config: { ...(isJsonRecord(p.config) ? p.config : {}), model_providers: providers },
  };
}

/** Codex's refusal of a thread whose key provider is no longer defined (its key was removed), as words (#2213). */
const REMOVED_KEY = 'This chat ran on an API key that was removed · Switch account';
/** @param {unknown} error @returns {unknown} the refusal reworded, anything else as it was */
function providerError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /Model provider `?sage_[0-9a-f]+`? not found/.test(text) ? Object.assign(new Error(REMOVED_KEY), { cause: error }) : error;
}

/** @returns {Promise<void>} */
const run = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = childProcess.execFile(command, args, { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
    // execFile always pipes stdin
    const stdin = /** @type {import('node:stream').Writable} */ (child.stdin);
    stdin.on('error', () => {
      /* the child may exit before reading stdin (EPIPE); the exit callback reports the result */
    });
    stdin.end(input ?? '');
  });

/**
 * The provider for a chat's account. `store` puts the key where auth-command reads it, once per key.
 * @param {{ command: string, exists?: (p: string) => boolean, store?: (service: string, account: string, key: string) => Promise<void>, erase?: (service: string, account: string) => Promise<void> }} o
 */
class CodexProviders {
  constructor(o) {
    this.command = o.command;
    this.exists = o.exists ?? ((/** @type {string} */ p) => fs.existsSync(p));
    this.store = o.store ?? ((service, account, key) => run(this.command, ['set', service, account], key));
    this.erase = o.erase ?? ((service, account) => run(this.command, ['delete', service, account]));
    /** account -> hash of the key already in the keychain */
    this.stored = new Map();
    /** account -> the provider of every added key and its endpoint's id, so a thread that ran on one resumes on it (#2213) */
    /** @type {Map<string, { f: ReturnType<typeof providerFragment>, legacy: string }>} */
    this.kept = new Map();
    /** @type {string | undefined} the account `ready` is for */
    this.readyAccount = undefined;
    this.ready = null;
    /** @type {Promise<void> | null} the newest sync until it settles */
    this.settling = null;
    /** the latest sync; an older one that finishes later must not replace its provider */
    this.syncs = 0;
    /** keychain writes, in call order: an erase never lands after a store that came later (sign out, then in) */
    /** @type {Promise<unknown>} */
    this.writes = Promise.resolve();
  }
  /** Runs `write` after every keychain write already asked for; its own result or failure goes to the caller. */
  inOrder(write) {
    const run = this.writes.then(write);
    // only the caller receives a failure; the next write waits for this one either way
    this.writes = Promise.allSettled([run]);
    return run;
  }
  get available() {
    return process.platform === 'darwin' && this.exists(this.command);
  }
  /**
   * @param {{ account: string, baseUrl: string, name: string, key: string }} a an apiKey account with its own endpoint
   * @returns the thread/start fragment; null when the helper is missing or the key could not be stored
   */
  async fragment(a) {
    if (!this.available || !a?.key || !a.baseUrl) return null;
    const digest = crypto.createHash('sha256').update(a.key).digest('hex');
    if (this.stored.get(a.account) !== digest) {
      try {
        await this.inOrder(() => this.store(KEYCHAIN_SERVICE, a.account, a.key));
      } catch (error) {
        // without the key in the keychain auth-command can't answer: no provider (null)
        noteIgnored('store a Codex account key for its provider', error);
        return null;
      }
      this.stored.set(a.account, digest);
    }
    return providerFragment({
      id: providerId(a.baseUrl, a.account),
      name: a.name || 'MoPilot',
      baseUrl: a.baseUrl,
      command: this.command,
      account: a.account,
    });
  }
  /**
   * Follows the active account: stores its key now, so a thread opened next can name the provider. `keys`, every added
   * key's input, replaces the kept providers; left out, they stay as they are.
   * @param {Parameters<CodexProviders['fragment']>[0] | null} input
   * @param {Parameters<CodexProviders['fragment']>[0][]} [keys]
   */
  sync(input, keys) {
    const n = ++this.syncs;
    const run = (async () => {
      /** @type {Awaited<ReturnType<CodexProviders['fragment']>>} */
      let next = null;
      try {
        // the active key first: threads opened meanwhile wait for the whole sync
        next = input ? await this.fragment(input) : null;
        if (keys) await this.keep(keys, n);
      } finally {
        // a failed sync leaves no provider (not the previous account's); a newer sync owns the result
        if (n === this.syncs) {
          this.ready = next;
          this.readyAccount = next ? input?.account : undefined;
        }
      }
    })();
    // threads opened meanwhile wait for the newest sync, whatever its outcome (pending)
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.settling = settled;
    // settled never rejects
    void settled.then(() => {
      if (this.settling === settled) this.settling = null;
    });
    return run;
  }
  /** The newest sync while it runs (it stores a key, bounded by the helper's timeout), else null. */
  pending() {
    return this.settling;
  }
  /**
   * Each key's provider, its key stored; a key that could not be stored has none. Sync `n` keeps them only while it is
   * the newest, so an older one that finishes last never brings back a key removed meanwhile.
   * @param {Parameters<CodexProviders['fragment']>[0][]} keys
   * @param {number} n
   */
  async keep(keys, n) {
    const next = new Map();
    for (const k of keys) {
      const f = await this.fragment(k);
      if (f) next.set(k.account, { f, legacy: providerId(k.baseUrl) });
    }
    if (n === this.syncs) this.kept = next;
  }
  /**
   * Every kept key's provider definition by its id, for a thread resumed or forked (withProvider); also under its
   * endpoint's id, for threads started before ids were per key, where the active key wins a shared endpoint.
   */
  definitions() {
    const entries = [...this.kept].sort(([a], [b]) => Number(a === this.readyAccount) - Number(b === this.readyAccount));
    /** @type {Record<string, unknown>} */
    const defs = {};
    for (const [, { f, legacy }] of entries) {
      const def = f.config.model_providers[f.modelProvider];
      defs[legacy] = def;
      defs[f.modelProvider] = def;
    }
    return defs;
  }
  /** The provider the next thread/start gets, or null. */
  current() {
    return this.ready;
  }
  /** The key goes when the account does. */
  async forget(account) {
    this.stored.delete(account);
    this.kept.delete(account);
    if (this.available)
      // the account is already forgotten; a leftover keychain item is not read again
      await this.inOrder(() => this.erase(KEYCHAIN_SERVICE, account)).catch((error) =>
        noteIgnored("remove a Codex account's provider key", error),
      );
  }
}

module.exports = {
  CodexProviders,
  KEYCHAIN_SERVICE,
  authCommandPath,
  providerId,
  providerFragment,
  withProvider,
  providerError,
  REMOVED_KEY,
};
