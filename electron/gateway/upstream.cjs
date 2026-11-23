// The gateway's connections to its managed servers (#2999 C2): one MCP client per server, started with the server's credential (auth.cjs) read here in main, its tools listed (tools.cjs) and listed again on each list_changed. Each server has a generation, moved on by a stop (a removal, a new credential, a restart): a start, listing or call begun under an older one never publishes its tools or returns its answer, and two listings at once keep only the newest one's answer. A vault or server list that can't be opened is the `locked` state, never "no credential"; a server that takes a credential and has none is `needs_credentials`.
const { EventEmitter } = require('node:events');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const { noteIgnored } = require('../ignored.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { connectServer } = require('./client.cjs');
const { requestAuth, NeedsCredentialError } = require('./auth.cjs');
const { gatewayTools } = require('./tools.cjs');

/**
 * @typedef {import('./servers.cjs').ManagedServer} ManagedServer
 * @typedef {import('./tools.cjs').GatewayTool} GatewayTool
 * @typedef {{ listTools(): Promise<{ tools: any[] }>, callTool(p: { name: string, arguments?: Record<string, unknown> }, schema?: any, o?: { signal?: AbortSignal, timeout?: number, maxTotalTimeout?: number, resetTimeoutOnProgress?: boolean, onprogress?: (p: unknown) => void }): Promise<any>,
 *   setNotificationHandler(schema: unknown, fn: () => void): void, close(): Promise<void>, onclose?: (() => void) | undefined }} McpClient
 * @typedef {'starting' | 'ready' | 'failed' | 'needs_credentials' | 'locked'} Status
 * @typedef {{ epoch: number, server: ManagedServer, client: McpClient | null, status: Status, error: string | null, tools: GatewayTool[], listing: number, applied: number }} Running
 *   listing: the newest listing's number; applied: the number of the listing whose answer the tools are
 */

/** A start, listing or call that a stop overtook: its result is dropped. */
class StaleError extends Error {
  constructor() {
    super('The server was removed or restarted meanwhile');
    this.code = 'stale';
  }
}

/** Why the gateway's saved data can't be used, in the gateway's words (SealedJson's own speak of MoMo). */
const LOCKED = {
  unavailable: 'The gateway can’t open its saved servers and credentials right now (the system keychain is unavailable)',
  other_key: 'The gateway’s saved credentials were encrypted with another key (another build or keychain)',
  busy: 'The gateway’s saved data is being changed by another MoPilot; try again',
  // a write without the OS key (platform/secretFile.cjs)
  secret_unavailable: 'The gateway can’t encrypt its saved data right now (the system keychain is unavailable), so nothing was saved',
};
/** The gateway's words for an error that means its saved data can't be used, or null for any other error. */
function lockedOf(/** @type {unknown} */ e) {
  const code = e && typeof e === 'object' ? /** @type {any} */ (e).code : undefined;
  return typeof code === 'string' && Object.hasOwn(LOCKED, code) ? LOCKED[/** @type {keyof typeof LOCKED} */ (code)] : null;
}
const lockedText = (/** @type {unknown} */ e) => lockedOf(e) ?? 'The gateway’s saved data can’t be read';

/** What a call's progress notices do here: nothing but keep its idle timer reset (resetTimeoutOnProgress). */
const keepAlive = () => {
  // the notice itself needs no handling
};

/** A failure as it may be shown: never the server's own words, only its kind. */
const failureOf = (/** @type {unknown} */ e) =>
  `it didn't start (${prefixUnits(String(/** @type {any} */ (e)?.code ?? /** @type {any} */ (e)?.name ?? 'error'), 32)})`;

class Upstreams extends EventEmitter {
  /**
   * @param {{ servers: Pick<InstanceType<typeof import('./servers.cjs').ManagedServers>, 'list' | 'get'>,
   *   credentials: Pick<InstanceType<typeof import('./credentials.cjs').CredentialVault>, 'get'>,
   *   tokens?: Pick<InstanceType<typeof import('./oauthTokens.cjs').OAuthTokens>, 'fetchFor'> | null,
   *   connect?: (launch: ManagedServer['launch'], o: { clientName: string, auth: import('./auth.cjs').RequestAuth }) => Promise<McpClient> }} o
   */
  constructor({ servers, credentials, tokens = null, connect = connectServer }) {
    super();
    this.servers = servers;
    this.credentials = credentials;
    /** OAuth's token source: a signed-in server's requests read and refresh their token there (oauthTokens.cjs) */
    this.tokens = tokens;
    this.connect = connect;
    /** @type {Map<string, Running>} */
    this.running = new Map();
    /** @type {Map<string, number>} */
    this.epochs = new Map();
  }

  epoch(/** @type {string} */ key) {
    return this.epochs.get(key) ?? 0;
  }

  /** Ends a server's client and its tools, and moves its generation on. */
  stop(/** @type {string} */ key) {
    const r = this.running.get(key);
    // nothing running: nothing to retire (a start sets its entry before its first await)
    if (!r) return;
    this.epochs.set(key, this.epoch(key) + 1);
    this.running.delete(key);
    r.client?.close().catch((e) => noteIgnored('close a gateway MCP client', e));
    this.emit('tools', key);
    this.emit('changed');
  }

  /** Every client ends (the app quits). */
  stopAll() {
    for (const key of [...this.running.keys()]) this.stop(key);
  }

  /**
   * (Re)starts a server: ends one running, reads its credential, connects and lists its tools. Resolves with its state
   * (failed, locked and needs_credentials included); rejects only with StaleError when a stop came first.
   * @param {ManagedServer} server
   * @returns {Promise<Running>}
   */
  async start(server) {
    const { key } = server;
    this.stop(key);
    const epoch = this.epoch(key);
    /** @type {Running} */
    const r = { epoch, server, client: null, status: 'starting', error: null, tools: [], listing: 0, applied: 0 };
    this.running.set(key, r);
    this.emit('changed');
    const settle = (/** @type {Status} */ status, /** @type {string | null} */ error) => {
      r.client?.close().catch((e) => noteIgnored('close a gateway MCP client', e));
      r.client = null;
      r.status = status;
      r.error = error;
      this.emit('changed');
      return r;
    };
    let auth;
    try {
      auth = requestAuth(server, this.credentials.get(key), this.tokens);
    } catch (error) {
      if (error instanceof NeedsCredentialError) return settle('needs_credentials', error.message);
      // W3: a vault that can't be opened or read is its own state, never "no credential"
      return settle('locked', lockedText(error));
    }
    try {
      const client = await this.connect(server.launch, { clientName: 'mopilot-gateway', auth });
      if (this.epoch(key) !== epoch) {
        await client.close().catch((e) => noteIgnored('close a gateway MCP client', e));
        throw new StaleError();
      }
      r.client = client;
      // the connection dropped (the process exited, the server went away): its tools go and it shows failed until the
      // user restarts it (gateway:restart) or the app starts again
      client.onclose = () => {
        if (this.epoch(key) !== epoch || this.running.get(key) !== r) return;
        r.client = null;
        r.tools = [];
        r.status = 'failed';
        r.error = 'it stopped';
        this.emit('tools', key);
        this.emit('changed');
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        // a stale listing (a stop came first) is expected; any other failure is noted by its kind, never the server's words
        this.#list(key, epoch).catch((e) =>
          noteIgnored(`list the gateway server ${server.name}'s tools again`, Object.assign(new Error(failureOf(e)), { code: e?.code }), [
            'stale',
          ]),
        );
      });
      await this.#list(key, epoch);
      return r;
    } catch (error) {
      // a stop came first (its client was closed under this one): stale, whatever broke
      if (this.epoch(key) !== epoch) throw new StaleError();
      return settle('failed', failureOf(error));
    }
  }

  /** Lists a running server's tools again; a listing of an older generation, or older than one since, is dropped. */
  async #list(/** @type {string} */ key, /** @type {number} */ epoch) {
    if (this.epoch(key) !== epoch) throw new StaleError();
    const r = /** @type {Running} */ (this.running.get(key));
    const listing = ++r.listing;
    const { tools } = await /** @type {McpClient} */ (r.client).listTools();
    if (this.epoch(key) !== epoch) throw new StaleError();
    // an older answer than the one the tools are is dropped; an older one that answers while a newer one still runs
    // (or after it failed) is applied, so the server never stays starting
    if (listing < r.applied) return;
    r.applied = listing;
    r.tools = gatewayTools(r.server, tools);
    r.status = 'ready';
    r.error = null;
    this.emit('tools', key);
    this.emit('changed');
  }

  /** Starts every managed server that isn't running or starting (a failed one is tried again). Never rejects. */
  async sync() {
    let servers;
    try {
      servers = this.servers.list();
    } catch (error) {
      // a locked list starts nothing; the gateway's status says why
      noteIgnored("read the gateway's managed servers", error);
      return;
    }
    await Promise.all(
      servers
        .filter((s) => !['ready', 'starting'].includes(this.running.get(s.key)?.status ?? ''))
        .map((s) =>
          // start rejects only as stale: a newer start or stop decides
          this.start(s).catch((error) => noteIgnored(`start the gateway server ${s.name}`, error, ['stale'])),
        ),
    );
  }

  /** A running server's state, or null. */
  get(/** @type {string} */ key) {
    return this.running.get(key) ?? null;
  }

  /**
   * Calls a tool on a running server under the generation the caller saw; an answer that comes back after a stop is
   * dropped (StaleError). The server's own error text is never passed on.
   * @param {string} key @param {number} epoch @param {string} tool @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal, timeout: number, maxTotalTimeout: number }} o
   */
  async call(key, epoch, tool, args, o) {
    const r = this.running.get(key);
    if (!r?.client || this.epoch(key) !== epoch) throw new StaleError();
    let answer;
    try {
      answer = await r.client.callTool({ name: tool, arguments: args }, undefined, {
        ...o,
        // a progress handler makes the SDK send a progress token, so a server that reports progress keeps the idle timer reset
        onprogress: keepAlive,
        resetTimeoutOnProgress: true,
      });
    } catch (error) {
      // a stop closed the client under the call (a removal, an ended sign-in): stale, not the server's failure
      if (this.epoch(key) !== epoch) throw new StaleError();
      throw error;
    }
    if (this.epoch(key) !== epoch) throw new StaleError();
    return answer;
  }
}

module.exports = { Upstreams, StaleError, failureOf, lockedText, lockedOf };
