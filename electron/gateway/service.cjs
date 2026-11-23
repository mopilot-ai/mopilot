// The gateway as main runs it (#2999 C2): its managed servers (servers.cjs), their credentials (credentials.cjs) and connections (upstream.cjs), kept in `<userData>/gateway/` (outside MoMo's folder), and what Settings is told about them: each server's state and the kind of credential it has saved, never a credential's value. Adding, removing, connecting and disconnecting each restart the server under a new generation, so nothing begun with the old setup publishes. A list or vault that can't be opened is shown as locked (W3), never as no servers.
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ManagedServers, checkSpec } = require('./servers.cjs');
const { RulesStore } = require('./rules.cjs');
const { canonicalScope } = require('./policy.cjs');
const { nativeKey, denialsOf } = require('./native.cjs');
const { CredentialVault } = require('./credentials.cjs');
const { Upstreams, lockedText } = require('./upstream.cjs');
const { OAuthTokens } = require('./oauthTokens.cjs');
const { signIn } = require('./oauthSignIn.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {import('./servers.cjs').ManagedServer} ManagedServer
 * @typedef {{ key: string, name: string, transport: 'stdio' | 'http', target: string, auth: ManagedServer['auth'],
 *   credential: 'saved' | 'none' | 'locked', signingIn: boolean, status: 'off' | import('./upstream.cjs').Status, error: string | null,
 *   tools: { name: string, offered: string, description: string, readOnly: boolean, blocked: string | null }[] }} ServerView
 * @typedef {{ state: 'ok', servers: ServerView[] } | { state: 'locked', reason: string, servers: [] }} GatewayView
 */

/** Where the gateway keeps its files under the app's data folder. */
const gatewayDir = (/** @type {string} */ userData) => path.join(userData, 'gateway');

class Gateway extends EventEmitter {
  /** @type {import('./servers.cjs').ManagedServer[] | null} the managed list as last read, until the next change */
  #managed = null;

  /**
   * @param {{ dir: string, safeStorage: import('./sealedFile.cjs').SafeStorage | null | undefined, now?: () => number,
   *   connect?: ConstructorParameters<typeof Upstreams>[0]['connect'], fetch?: typeof fetch }} o
   */
  constructor({ dir, safeStorage, now = Date.now, connect, fetch: doFetch = fetch }) {
    super();
    this.on('changed', () => {
      this.#managed = null;
    });
    this.servers = new ManagedServers({ file: path.join(dir, 'servers.json'), safeStorage, now });
    /** the user's allow / ask / block rules for the servers' tools (C3), plain JSON: they hold no secret */
    this.rules = new RulesStore({ file: path.join(dir, 'rules.json'), now });
    this.credentials = new CredentialVault({ file: path.join(dir, 'credentials.json'), safeStorage, now });
    this.now = now;
    this.fetch = doFetch;
    this.tokens = new OAuthTokens({
      vault: this.credentials,
      now,
      fetch: doFetch,
      // a sign-in that ended (refused refresh): the server stops offering tools that can't run and shows it needs one
      onSignedOut: (key) => {
        this.upstreams.stop(key);
        this.emit('changed');
        this.restart(key).catch((e) => noteIgnored('restart a gateway server whose sign-in ended', e));
      },
    });
    this.upstreams = new Upstreams({
      servers: this.servers,
      credentials: this.credentials,
      tokens: this.tokens,
      ...(connect ? { connect } : {}),
    });
    /** @type {Map<string, AbortController>} each server's sign-in waiting on the browser */
    this.signIns = new Map();
    this.upstreams.on('changed', () => this.emit('changed'));
    /** @type {Map<string, Promise<void>>} each server's last change, which the next one waits for */
    this.turns = new Map();
  }

  /** What Settings shows. @returns {GatewayView} */
  view() {
    let servers;
    try {
      servers = this.servers.list();
    } catch (error) {
      return { state: 'locked', reason: lockedText(error), servers: [] };
    }
    /** @type {Record<string, string> | null} */
    let kinds = null;
    try {
      kinds = this.credentials.kinds();
    } catch (error) {
      noteIgnored('read which gateway servers have credentials', error);
    }
    return {
      state: 'ok',
      servers: servers.map((s) => {
        const r = this.upstreams.get(s.key);
        return {
          key: s.key,
          name: s.name,
          transport: s.launch.type,
          target: s.launch.type === 'stdio' ? s.launch.command : s.launch.url,
          auth: s.auth,
          credential: kinds === null ? 'locked' : kinds[s.key] ? 'saved' : 'none',
          signingIn: this.signIns.has(s.key),
          status: r?.status ?? 'off',
          error: r?.error ?? null,
          tools: (r?.tools ?? []).map((t) => ({
            name: t.name,
            offered: t.offered,
            description: t.description,
            readOnly: t.readOnly,
            blocked: t.blocked,
          })),
        };
      }),
    };
  }

  /** Starts every managed server (app start). Never rejects. */
  sync() {
    return this.upstreams.sync();
  }

  /** (Re)starts one server as it is saved now (read and started in one step, so a removal either comes before it or retires it). */
  async restart(/** @type {string} */ key) {
    const server = this.servers.get(key);
    if (!server) {
      this.upstreams.stop(key);
      return;
    }
    // start rejects only as stale: a newer stop or start decides
    await this.upstreams.start(server).catch((error) => noteIgnored(`restart the gateway server ${server.name}`, error, ['stale']));
  }

  /**
   * Runs `fn` when the server's earlier changes (add, remove, connect, disconnect) are done: each change reads and
   * writes the server's entry and credential in its own turn, so a connect never lands after a remove that came first
   * (no credential outlives its server). Starting a server happens after the turn: its generation retires a stale start.
   * @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  #inTurn(key, fn) {
    const before = this.turns.get(key) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.turns.set(key, done);
    void done.then(() => {
      if (this.turns.get(key) === done) this.turns.delete(key);
    });
    return run;
  }

  /** Turns a server on: it is saved, then started. @returns {Promise<ManagedServer>} */
  async add(/** @type {unknown} */ spec) {
    const checked = checkSpec(spec);
    const server = await this.#inTurn('server' in checked ? checked.server.key : '', () => this.servers.add(spec));
    this.emit('changed');
    this.restart(server.key).catch((e) => noteIgnored(`start the gateway server ${server.name}`, e));
    return server;
  }

  /** Turns a server off: it stops at once (a call in flight ends as stale), then its credential and its entry go. */
  remove(/** @type {string} */ key) {
    this.cancelSignIn(key);
    this.upstreams.stop(key);
    return this.#inTurn(key, async () => {
      this.upstreams.stop(key);
      // the credential first: a failure after it leaves a server with no credential, never a credential with no server
      await this.credentials.delete(key);
      await this.servers.remove(key);
      this.upstreams.stop(key);
      this.emit('changed');
    });
  }

  /** Saves a managed server's credential, then restarts it with it. */
  async connect(/** @type {string} */ key, /** @type {unknown} */ credential) {
    await this.#inTurn(key, async () => {
      // read in the turn: a removal asked for before this one has finished
      const server = this.servers.get(key);
      if (!server) throw new Error('That server is not managed by the gateway');
      if (server.auth === 'none' || server.auth === 'oauth') throw new Error(`${server.name} doesn’t take a saved credential`);
      if (/** @type {any} */ (credential)?.type !== server.auth) throw new Error(`${server.name} takes a credential of another kind`);
      // the old connection ends before the new credential is saved: nothing started with the old one publishes after it
      this.upstreams.stop(key);
      await this.credentials.put(key, credential);
      this.emit('changed');
    });
    await this.restart(key);
  }

  /**
   * Signs in to an OAuth server in the user's browser (`open`), then saves its tokens and restarts it. A second sign-in
   * replaces the first, and a sign-out or removal cancels one: a cancelled sign-in saves nothing (A4).
   * @param {string} key @param {(url: string) => Promise<unknown>} open
   */
  async signIn(key, open) {
    const server = this.servers.get(key);
    if (!server) throw new Error('That server is not managed by the gateway');
    if (server.auth !== 'oauth' || server.launch.type !== 'http') throw new Error(`${server.name} doesn’t sign in with OAuth`);
    this.cancelSignIn(key);
    const ac = new AbortController();
    this.signIns.set(key, ac);
    this.emit('changed');
    try {
      const credential = await signIn({ url: server.launch.url, open, signal: ac.signal, fetch: this.fetch, now: this.now });
      await this.#inTurn(key, async () => {
        // cancelled, replaced or removed while the token came back: nothing is saved
        if (this.signIns.get(key) !== ac || !this.servers.get(key))
          throw Object.assign(new Error('The sign-in was cancelled'), { code: 'closed' });
        this.upstreams.stop(key);
        await this.credentials.put(key, credential);
      });
    } finally {
      if (this.signIns.get(key) === ac) this.signIns.delete(key);
      this.emit('changed');
    }
    await this.restart(key);
  }

  /** Ends a sign-in waiting on the browser, if any. */
  cancelSignIn(/** @type {string} */ key) {
    const ac = this.signIns.get(key);
    if (!ac) return;
    this.signIns.delete(key);
    ac.abort();
    this.emit('changed');
  }

  /** Forgets a server's credential; it stops, and shows that it needs connecting. */
  async disconnect(/** @type {string} */ key) {
    this.cancelSignIn(key);
    await this.#inTurn(key, async () => {
      this.upstreams.stop(key);
      await this.credentials.delete(key);
      this.emit('changed');
    });
    await this.restart(key);
  }

  /**
   * The servers the gateway manages now (C4: each harness keeps its own copy of them from loading), read once per
   * change (a `changed` event drops the copy). A list that can't be opened manages none: the gateway can't run them
   * then, so the harnesses keep theirs; it is read again next time.
   * @returns {import('./servers.cjs').ManagedServer[]}
   */
  #managedServers() {
    if (this.#managed) return this.#managed;
    try {
      this.#managed = this.servers.list();
      return this.#managed;
    } catch (error) {
      noteIgnored('read which servers the gateway manages', error);
      return [];
    }
  }

  /** The keys of the servers the gateway manages now. @returns {Set<string>} */
  managedKeys() {
    return new Set(this.#managedServers().map((s) => s.key));
  }

  /** Whether a harness's own server entry is one the gateway runs in its place (native.cjs nativeKey). */
  isManagedNative(/** @type {unknown} */ entry) {
    const key = nativeKey(entry);
    return key !== null && this.managedKeys().has(key);
  }

  /** Claude Code's deny entries for the servers the gateway manages now (native.cjs denialsOf): identities only. */
  nativeDenials() {
    return denialsOf(this.#managedServers());
  }

  /** The rules as they are now, whether their file could be read, and how many entries this build couldn't. */
  rulesView() {
    return this.rules.view();
  }

  /** Adds a rule (C3), a project's folder as its real path (the same folder however it is spelled); every window hears it. */
  async addRule(/** @type {unknown} */ rule) {
    const r = /** @type {any} */ (rule);
    const saved = await this.rules.add(r && typeof r === 'object' ? { ...r, scope: canonicalScope(r.scope) } : rule);
    this.emit('changed');
    return saved;
  }

  /** Removes a rule by its id. */
  async removeRule(/** @type {string} */ id) {
    await this.rules.remove(id);
    this.emit('changed');
  }

  /** Starts the rules again with none (an unreadable file is kept aside). */
  async resetRules() {
    await this.rules.reset();
    this.emit('changed');
  }

  /** The app quits: every client ends. */
  close() {
    for (const key of [...this.signIns.keys()]) this.cancelSignIn(key);
    this.upstreams.stopAll();
  }
}

module.exports = { Gateway, gatewayDir };
