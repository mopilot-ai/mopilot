// MoMo's connector hub (#2999 C0): the cloud accounts MoMo may use (Gmail, Notion, ... registered as connector definitions), their status for Settings, connecting through the gateway's OAuth (gateway/oauth.cjs) into the token vault (vault.cjs), disconnecting, and every tool call: while MoMo is allowed, connected, decided by the injected decide (the sentinel: a read is a read, a write is a change that asks on the approval card) and recorded by the injected audit, failing closed without either. Tokens never leave this module except to the definition's own run(); an expired token is refreshed once per connector at a time. Each connector has a generation, bumped by a disconnect or a new connect: work begun under an older one (a sign-in, a refresh, a call) never saves tokens or returns a result after it.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const oauth = require('../../gateway/oauth.cjs');
const { CONNECTOR_ID } = require('./vault.cjs');

/** A stable digest of a call's arguments (keys sorted), to bind a press to what the person was shown. */
function digestOf(/** @type {unknown} */ args) {
  const canon = (/** @type {any} */ v) =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : v;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canon(args)))
    .digest('hex');
}

/** A token this close to expiry is refreshed before the call. */
const REFRESH_EARLY_MS = 60_000;

/**
 * @typedef {'read' | 'change'} ToolKind
 * @typedef {{ accessToken: string, signal: AbortSignal | null }} RunContext
 * @typedef {{ kind: ToolKind, needsPress?: boolean, description: string, summary: (args: any) => string, run: (args: any, ctx: RunContext) => Promise<unknown> }} ConnectorTool
 * @typedef {{ authorizeUrl: string, tokenUrl: string, clientId: string, extra?: Record<string, string> }} OAuthConfig
 * @typedef {Pick<typeof oauth, 'listenForCode' | 'exchangeCode' | 'refreshTokens'>} Flow
 * @typedef {{ id: string, label: string, scopes: string[], oauth: OAuthConfig, tools: Record<string, ConnectorTool>, flow?: Flow }} Connector
 *   flow: the connector's own sign-in steps instead of the hub's (the test connector's token endpoint is in-process)
 * @typedef {import('./vault.cjs').Level} Level
 * @typedef {{ kind: ToolKind, connector: string, label: string, level: Level, tool: string, chatId: string, summary: string, args: unknown,
 *   toolName?: string, source?: string }} DecideCall toolName, source: a proxied MCP tool's own (mcp/proxy.cjs)
 * @typedef {(call: DecideCall) => Promise<{ allow: boolean, reason?: string }>} Decide
 * @typedef {{ connector: string, tool: string, chatId: string, decision: string, result?: string, reason?: string, args: unknown, via?: string, draft?: string }} AuditEntry
 * @typedef {{ append(entry: AuditEntry): unknown }} Audit
 * @typedef {{ id: string, label: string, connected: boolean, account: string | null, scopes: string[], level: Level, needsReconnect: boolean,
 *   connecting: boolean, tools: { name: string, kind: ToolKind, description: string }[] }} ConnectorStatus
 */

/**
 * A connector step failed, by code: unknown (no such connector or tool), not_connected, reconnect (the account must be signed in again), refused (MoMo is off, the trust layer said no, or nothing is wired to decide), stale (a disconnect or new connect came first), failed (the provider).
 * `reason` is a refusal's own short word (denied, paused, read only, MoMo is off...), for a caller that tells a "no" from the user from a closed door.
 */
class ConnectorError extends Error {
  /** @param {string} message @param {'unknown' | 'not_connected' | 'reconnect' | 'refused' | 'stale' | 'failed'} code @param {string} [reason] */
  constructor(message, code, reason) {
    super(message);
    this.code = code;
    if (reason) this.reason = reason;
  }
}

/** A provider answered a call as unauthorized (its token was revoked or expired): a definition's run() throws this. */
class Unauthorized extends Error {
  constructor() {
    super('unauthorized');
    this.code = 'unauthorized';
  }
}

class ConnectorHub extends EventEmitter {
  /**
   * @param {{ vault: Pick<InstanceType<typeof import('./vault.cjs').TokenVault>, 'get' | 'put' | 'delete' | 'setLevel'>, allowed: () => boolean, decide: Decide | null,
   *   audit: Audit | null, openExternal: (url: string) => unknown, now?: () => number, oauth?: Flow }} o
   */
  constructor({ vault, allowed, decide, audit, openExternal, now = Date.now, oauth: flow = oauth }) {
    super();
    this.vault = vault;
    this.allowed = allowed;
    this.decide = decide;
    this.audit = audit;
    this.openExternal = openExternal;
    this.now = now;
    this.flow = flow;
    /** @type {Map<string, Connector>} */
    this.connectors = new Map();
    /** @type {Map<string, number>} each connector's generation */
    this.epochs = new Map();
    /** @type {Map<string, { close: () => void }>} the sign-in waiting for its browser, per connector */
    this.signIns = new Map();
    /** @type {Map<string, Promise<Omit<import('./vault.cjs').TokenSet, 'savedAt'>>>} the refresh in flight, per connector */
    this.refreshing = new Map();
    /** @type {Set<string>} connectors whose account must be signed in again */
    this.lost = new Set();
    /** @type {Map<string, { digest: string, draft: string }>} the user's presses not yet used: one token per press, each bound to what the person was shown */
    this.presses = new Map();
  }

  /**
   * The user's own press on a control that sends (a draft card's Send, through its IPC only): a one-time token for one
   * connector and chat, bound to the exact arguments the person was shown (`args`: recipients, subject, body, account) and
   * to the draft's id for the audit log. A tool with `needsPress` runs only with such a token and only with those arguments,
   * and then with no second card: the press is the approval. A model's or a routine's call, a token of another chat,
   * connector or use, or a call whose arguments differ from what was shown is refused and audited, nothing run.
   */
  press(/** @type {string} */ connector, /** @type {string} */ chatId, /** @type {unknown} */ args, /** @type {string} */ draft) {
    const token = crypto.randomBytes(16).toString('hex');
    this.presses.set(`${connector}\u0000${chatId}\u0000${token}`, { digest: digestOf(args), draft: String(draft).slice(0, 128) });
    return token;
  }

  /** The press a token stands for (used up by this look), or null. */
  #pressed(/** @type {string} */ connector, /** @type {string} */ chatId, /** @type {unknown} */ token) {
    const key = `${connector}\u0000${chatId}\u0000${String(token)}`;
    const found = this.presses.get(key) ?? null;
    this.presses.delete(key);
    return found;
  }

  /** Adds a connector definition (once per id). */
  register(/** @type {Connector} */ c) {
    if (!CONNECTOR_ID.test(c?.id ?? '')) throw new Error(`Not a connector id: ${String(c?.id)}`);
    if (this.connectors.has(c.id)) throw new Error(`Connector ${c.id} is already registered`);
    this.connectors.set(c.id, c);
    this.emit('changed');
  }

  #connector(/** @type {string} */ id) {
    const c = this.connectors.get(id);
    if (!c) throw new ConnectorError(`No connector ${String(id)}`, 'unknown');
    return c;
  }

  /** The connector's sign-in steps: its own, or the hub's. @returns {Flow} */
  #flow(/** @type {Connector} */ c) {
    return c.flow ?? this.flow;
  }

  epoch(/** @type {string} */ id) {
    return this.epochs.get(id) ?? 0;
  }

  #bump(/** @type {string} */ id) {
    this.epochs.set(id, this.epoch(id) + 1);
    this.refreshing.delete(id);
  }

  /** Every connector as Settings shows it: never a token. @returns {ConnectorStatus[]} */
  list() {
    return [...this.connectors.keys()].map((id) => this.status(id));
  }

  /** @returns {ConnectorStatus} */
  status(/** @type {string} */ id) {
    const c = this.#connector(id);
    const t = this.vault.get(id);
    return {
      id,
      label: c.label,
      connected: t !== null,
      account: t?.account ?? null,
      scopes: t?.scopes ?? [],
      level: t?.level ?? 'ask',
      needsReconnect: this.lost.has(id),
      connecting: this.signIns.has(id),
      tools: Object.entries(c.tools).map(([name, tool]) => ({ name, kind: tool.kind, description: tool.description })),
    };
  }

  /**
   * Signs the account in: the browser opens the provider's consent page, and the tokens it answers are saved, unless a
   * disconnect or another connect came first. A connect while one waits replaces it.
   * @param {string} id @param {{ account?: string }} [o] account: a label for Settings (the provider's own, when known)
   */
  async connect(id, { account } = {}) {
    const c = this.#connector(id);
    if (this.allowed() !== true) throw new ConnectorError('MoMo is off for this account', 'refused');
    this.signIns.get(id)?.close();
    this.#bump(id);
    const epoch = this.epoch(id);
    const { verifier, challenge } = oauth.pkce();
    const state = oauth.newState();
    const wait = await this.#flow(c).listenForCode({ state });
    if (this.epoch(id) !== epoch) {
      wait.close();
      throw new ConnectorError('Another sign-in or a disconnect came first', 'stale');
    }
    this.signIns.set(id, wait);
    this.emit('changed');
    try {
      await this.openExternal(oauth.authorizeUrl({ ...c.oauth, redirectUri: wait.redirectUri, scopes: c.scopes, state, challenge }));
      const code = await wait.code;
      const tokens = await this.#flow(c).exchangeCode({
        tokenUrl: c.oauth.tokenUrl,
        clientId: c.oauth.clientId,
        code,
        verifier,
        redirectUri: wait.redirectUri,
        now: this.now,
      });
      // a disconnect or another connect while the browser or the token endpoint answered: nothing is saved
      if (this.epoch(id) !== epoch) throw new ConnectorError('Another sign-in or a disconnect came first', 'stale');
      await this.vault.put(id, { ...tokens, scopes: tokens.scopes.length ? tokens.scopes : c.scopes, ...(account ? { account } : {}) });
      this.lost.delete(id);
    } finally {
      if (this.signIns.get(id) === wait) {
        this.signIns.delete(id);
        wait.close();
      }
      this.emit('changed');
    }
    return this.status(id);
  }

  /** Ends the sign-in waiting for the browser (its connect rejects as closed); false when none waits. */
  cancel(/** @type {string} */ id) {
    this.#connector(id);
    const wait = this.signIns.get(id);
    wait?.close();
    return wait !== undefined;
  }

  /** Sets a connected account's access level: Blocked (paused), Read only, or Read & ask to change. */
  async setLevel(/** @type {string} */ id, /** @type {Level} */ level) {
    const c = this.#connector(id);
    if (!this.vault.get(id)) throw new ConnectorError(`${c.label} is not connected`, 'not_connected');
    await this.vault.setLevel(id, level);
    this.emit('changed');
  }

  /** Forgets the account's tokens; a sign-in waiting, a refresh or a call in flight finishes as stale. */
  async disconnect(/** @type {string} */ id) {
    this.#connector(id);
    this.signIns.get(id)?.close();
    this.signIns.delete(id);
    this.#bump(id);
    this.lost.delete(id);
    await this.vault.delete(id);
    this.emit('changed');
  }

  /** The account's tokens, refreshed first when they are about to expire; one refresh per connector at a time. */
  async #token(/** @type {string} */ id, /** @type {number} */ epoch, force = false) {
    const t = this.vault.get(id);
    if (!t) throw new ConnectorError(`${this.#connector(id).label} is not connected`, 'not_connected');
    const fresh = t.expiresAt === undefined || t.expiresAt - REFRESH_EARLY_MS > this.now();
    if (fresh && !force) return t;
    if (!t.refreshToken) return this.#lose(id, epoch);
    let running = this.refreshing.get(id);
    if (!running) {
      const c = this.#connector(id);
      running = this.#flow(c)
        .refreshTokens({ tokenUrl: c.oauth.tokenUrl, clientId: c.oauth.clientId, refreshToken: t.refreshToken, now: this.now })
        .then(async (next) => {
          // saved only by the generation that asked for it: a disconnect meanwhile keeps the account disconnected
          if (this.epoch(id) !== epoch) throw new ConnectorError('Disconnected while refreshing', 'stale');
          const kept = { ...next, scopes: next.scopes.length ? next.scopes : t.scopes, ...(t.account ? { account: t.account } : {}) };
          await this.vault.put(id, kept);
          return kept;
        });
      const mine = running;
      this.refreshing.set(id, mine);
      const forget = () => {
        if (this.refreshing.get(id) === mine) this.refreshing.delete(id);
      };
      mine.then(forget, forget);
    }
    try {
      return await running;
    } catch (e) {
      if (e instanceof oauth.OAuthError) return this.#lose(id, epoch);
      throw e;
    }
  }

  /** The provider refused the account (revoked or expired for good): its tokens go, and Settings asks to sign in again. @returns {Promise<never>} */
  async #lose(/** @type {string} */ id, /** @type {number} */ epoch) {
    // a disconnect or new connect came first: that one decides what is saved
    this.#current(id, epoch);
    this.#bump(id);
    this.lost.add(id);
    await this.vault.delete(id);
    this.emit('changed');
    throw new ConnectorError(`${this.#connector(id).label} needs to be signed in again`, 'reconnect');
  }

  /**
   * Runs one of a connector's tools for a MoMo chat: MoMo allowed, connected, decide allows (a change asks the user),
   * then the definition's run() with the token; audited either way. A call the provider answers as unauthorized
   * refreshes once and tries again. A result that came back after a disconnect is dropped.
   * `onAllowed` runs once the call is approved (the trust layer's yes, or the person's bound press) and before the tool runs.
   * @param {{ connector: string, tool: string, chatId: string, args?: unknown, signal?: AbortSignal | null, onAllowed?: (() => unknown) | null, press?: string | null }} call
   */
  async call({ connector: id, tool: name, chatId, args = {}, signal = null, onAllowed = null, press = null }) {
    const c = this.#connector(id);
    const tool = c.tools[name];
    if (!tool) throw new ConnectorError(`${c.label} has no tool ${String(name)}`, 'unknown');
    if (this.allowed() !== true) throw new ConnectorError('MoMo is off for this account', 'refused');
    if (!this.decide || !this.audit) throw new ConnectorError('MoMo has no trust layer wired, so nothing runs', 'refused');
    const epoch = this.epoch(id);
    // a tool that sends needs the user's own press, for exactly these arguments: nothing a model or routine does can stand in for it
    const pressed = tool.needsPress === true ? this.#pressed(id, chatId, press) : null;
    if (tool.needsPress === true && !pressed) {
      await this.audit.append({ connector: id, tool: name, chatId, args, decision: 'no-press' });
      throw new ConnectorError('Not allowed (no press)', 'refused', 'no press');
    }
    if (pressed && pressed.digest !== digestOf(args)) {
      await this.audit.append({ connector: id, tool: name, chatId, args, decision: 'press-mismatch', draft: pressed.draft });
      throw new ConnectorError('Not allowed (the send is not what was shown)', 'refused', 'press mismatch');
    }
    const base = { connector: id, tool: name, chatId, args, ...(pressed ? { via: 'user-pressed', draft: pressed.draft } : {}) };
    let token = await this.#token(id, epoch);
    this.#current(id, epoch);
    await this.#gate(id, tool.kind, base);
    const level = this.vault.get(id)?.level ?? 'ask';
    // the person's press on what they were shown is the approval: no second card
    const d = pressed
      ? { allow: true }
      : await this.decide({
          kind: tool.kind,
          connector: id,
          label: c.label,
          level,
          tool: name,
          chatId,
          summary: tool.summary(args),
          args,
        });
    if (!d.allow) {
      await this.audit.append({ ...base, decision: d.reason ?? 'refused' });
      throw new ConnectorError(`Not allowed${d.reason ? ` (${d.reason})` : ''}`, 'refused', d.reason ?? 'refused');
    }
    this.#current(id, epoch);
    // MoMo turned off, or the account paused, while the card waited: the answer no longer counts
    await this.#gate(id, tool.kind, base);
    await onAllowed?.();
    let result;
    try {
      try {
        result = await tool.run(args, { accessToken: token.accessToken, signal });
      } catch (e) {
        if (!(e instanceof Unauthorized)) throw e;
        token = await this.#token(id, epoch, true);
        result = await tool.run(args, { accessToken: token.accessToken, signal });
      }
    } catch (e) {
      // the hub's own reasons only: a provider's message can carry a token or private data
      const reason = e instanceof ConnectorError ? e.message : e instanceof Unauthorized ? 'unauthorized' : `${c.label} failed`;
      await this.audit.append({ ...base, decision: 'allowed', result: 'failed', reason });
      if (e instanceof Unauthorized) return this.#lose(id, epoch);
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError(`${c.label} failed`, 'failed');
    }
    // what ran is recorded as done even when a disconnect came meanwhile: the provider already did it
    await this.audit.append({ ...base, decision: 'allowed', result: 'done' });
    this.#current(id, epoch);
    return result;
  }

  /** Refuses (audited) a call MoMo may not make now: MoMo off, the account paused, or a change on a read-only account. */
  async #gate(/** @type {string} */ id, /** @type {ToolKind} */ kind, /** @type {Omit<AuditEntry, 'decision'>} */ base) {
    const level = this.vault.get(id)?.level ?? 'ask';
    const why =
      this.allowed() !== true ? 'MoMo is off' : level === 'blocked' ? 'paused' : level === 'read' && kind === 'change' ? 'read only' : null;
    if (!why) return;
    // call() checked that an audit is wired
    await /** @type {Audit} */ (this.audit).append({ ...base, decision: why });
    throw new ConnectorError(`Not allowed (${why})`, 'refused', why);
  }

  #current(/** @type {string} */ id, /** @type {number} */ epoch) {
    if (this.epoch(id) !== epoch) throw new ConnectorError('Disconnected while the call ran', 'stale');
  }

  /** Reset MoMo: every sign-in waiting goes and every generation moves on (the vault's own reset deletes the tokens). */
  reset() {
    for (const id of this.connectors.keys()) {
      this.signIns.get(id)?.close();
      this.#bump(id);
    }
    this.signIns.clear();
    this.lost.clear();
    this.emit('changed');
  }
}

module.exports = { ConnectorHub, ConnectorError, Unauthorized, REFRESH_EARLY_MS };
