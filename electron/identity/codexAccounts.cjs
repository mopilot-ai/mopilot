// Multiple ChatGPT accounts. @host-portable: loads in the Host process without Electron (host/boundary.json).
//
// The account the Codex CLI uses lives in $CODEX_HOME/auth.json ("default"). Every other account
// gets its own private CODEX_HOME under <userData>/accounts/<id>, so credentials never mix. The
// shared app-server is pointed at the active account with external tokens
// (`account/login/start` type `chatgptAuthTokens`), which swaps accounts without a restart and
// without touching any auth.json. Threads, config and skills stay shared.
//
// A short-lived "sidecar" app-server per account home does the account-scoped work with Codex's
// own code: sign-in, token refresh (`account/read` + refreshToken) and usage reads. Tokens stay
// in this process, encrypted at rest (authVault.cjs); the renderer only sees emails, plans, usage and status.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const crypto = require('node:crypto');
const { Relay } = require('./accounts/relay.cjs');
const { writePrivate, readStateFile } = require('../platform/fsutil.cjs');
const { isAccountState, accountFolder } = require('./contract/accountState.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { sameLane } = require('./contract/switch.cjs');
const { codexInstance } = require('./drivers/codex.cjs');
const { defaultHome, readAuth, writeAuth, limitInfo } = require('./accounts/records.cjs');
const { AuthVault } = require('./accounts/authVault.cjs');
const { AccountTokens, loginChanged } = require('./accounts/tokens.cjs');
const { UsageRefresh } = require('./contract/usageRefresh.cjs');
const { Sidecar, withTimeout } = require('./accounts/sidecar.cjs');
const { DEFAULT_ID } = require('./accounts/providers.cjs');
const { switchSelection } = require('./accounts/selection.cjs');
const { startRelay } = require('./accounts/relayConfig.cjs');
const { codexServerId } = require('./contract/sameAccount.cjs');

const { LIMITS_STALE_MS } = require('./accounts/limits.cjs');
/** How often the pool asks which accounts' usage is due (identity/contract/usageRefresh.cjs decides). */
const POLL_MS = 60_000;
const PIN_TTL_MS = 6 * 3600_000;

/**
 * @typedef {{ id: string, kind?: string, email?: string | null, planType?: string | null, baseUrl?: string | null,
 *             mopilot?: boolean, status?: string, error?: string | null, limits?: any, addedAt?: number, [k: string]: any }} Account
 *   an account record in accounts.json
 */

class Accounts extends AccountTokens {
  /**
   * @param {{ userData: string, server: any, findBin: () => string | Promise<string>, clientInfo?: object, safeStorage?: import('../platform/secretFile.cjs').SafeStorage | null, broadcast: (evt: any) => void, openExternal: (u: string) => void, forgetProvider?: (id: string) => Promise<void> | void, provideKey?: (input: { account: string, baseUrl: string, name: string, key: string } | null) => Promise<boolean>, prepareContinue?: (threadId: string, turnId?: string) => (() => void), notifyLimit?: (threadId: string) => void }} o
   *   prepareContinue: capture the failed turn before awaiting the account move; call its result only after a successful move;
   *   notifyLimit: a chat that ran out stays put, because it moved too often (the loop guard)
   */
  constructor(o) {
    super();
    this.userData = o.userData;
    this.server = o.server;
    this.findBin = o.findBin;
    this.clientInfo = o.clientInfo;
    this.broadcast = o.broadcast;
    this.openExternal = o.openExternal;
    /** the account's provider key leaves the keychain with it (identity/contract/codexProvider.cjs) */
    this.forgetProvider = o.forgetProvider;
    /** stores an added key for its thread provider; false when that route is unavailable (identity/accounts/providers.cjs applyKey) */
    this.provideKey = o.provideKey ?? (async () => false);
    this.prepareContinue = o.prepareContinue ?? (() => () => undefined);
    this.notifyLimit = o.notifyLimit ?? (() => undefined);
    this.file = path.join(o.userData, 'accounts.json');
    this.root = path.join(o.userData, 'accounts');
    this.vault = AuthVault.start({ root: this.root, safeStorage: o.safeStorage ?? null });
    this.sidecars = new Map();
    /** @type {InstanceType<typeof Relay> | null} the account relay, once started (startRelay) */
    this.relay = null;
    /** whether config.toml points Codex at an endpoint of its own, so the relay stays out */
    this.relaySkipped = false;
    /** when each account's usage is read again (identity/contract/usageRefresh.cjs) */
    this.usageRefresh = new UsageRefresh();
    this.refreshing = new Map();
    this.resetAttempts = new Map();
    this.resetting = new Map();
    this.removing = new Map();
    this.removalTail = Promise.resolve();
    this.mainPending = new Map();
    this.mainSeq = 0;
    // A freshly spawned app-server reads $CODEX_HOME/auth.json itself ("managed"); after we push
    // tokens it is "external" until it restarts.
    this.mainMode = 'managed';
    this.login = null;
    this.loginRun = null;
    this.loginEpoch = 0;
    /** session (thread) id -> { id: account id, at } */
    this.pins = new Map();
    this.resumes = new Map();
    this.handledTurns = new Set();
    /** turn id -> the login it started on, or null when unknown (identity/accounts/limits.cjs) */
    this.turnLogins = new Map();
    /** temporary (ephemeral) threads: they keep the account they started on */
    this.ephemeral = new Set();
    // pool: 'spread' puts new chats on the account with the most usage left; 'single' uses the
    // active account until it runs out.
    // chatPins: chats the user put on an account themselves (thread id -> account id)
    /** @type {{ active: string | null, autoSwitch: boolean, pool: string, accounts: Account[], chatPins: Record<string, string>, lastSubscription?: string }} */
    this.state = { active: DEFAULT_ID, autoSwitch: true, pool: 'spread', accounts: [], chatPins: {} };
    // first run, or an unreadable file (kept aside by readStateFile): start from the defaults
    Object.assign(this.state, readStateFile(this.file, 'the Codex accounts', isAccountState));
    for (const [t, id] of Object.entries(this.state.chatPins || {})) this.pins.set(t, { id, at: Date.now(), sticky: true });
    this.syncDefault();
    o.server.intercepts.add((msg) => this.onMainMessage(msg));
    o.server.listeners.add((evt) => {
      // exited or stopped on purpose (a restart): the next process reads $CODEX_HOME/auth.json, so the account is
      // applied to it again
      if (evt.kind === 'exit' || evt.kind === 'stopped') {
        this.mainMode = 'managed';
        this.applied = null;
        this.turnLogins.clear();
        for (const p of this.mainPending.values()) p.reject(new Error('Codex exited'));
        this.mainPending.clear();
      }
    });
    this.poll = setInterval(() => {
      for (const [k, p] of this.pins) if (!p.sticky && Date.now() - p.at > PIN_TTL_MS) this.pins.delete(k);
      // background poll: the next tick tries again
      if (this.polls()) this.refreshUsage().catch((error) => noteIgnored('read Codex account usage', error));
    }, POLL_MS);
  }

  /** Starts the local relay; the config that routes threads through it, or null (identity/accounts/relayConfig.cjs). */
  startRelay() {
    return startRelay(this, Relay);
  }

  /* ---------- records ---------- */
  home(a) {
    return a.id === DEFAULT_ID ? defaultHome() : accountFolder(this.root, a.id);
  }
  get(id) {
    return this.state.accounts.find((a) => a.id === id) || null;
  }
  /** Null: nothing chosen (no subscription to fall back to). An unknown id falls back to a subscription, never a key. */
  active() {
    return this.get(this.state.active) || (this.state.active === null ? null : this.fallbackFor(null));
  }
  /** ChatGPT logins: the accounts that pool, poll usage and can be put on a chat. */
  subscriptions() {
    return this.state.accounts.filter((a) => (a.kind || 'chatgpt') === 'chatgpt');
  }
  save(state = this.state) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writePrivate(this.file, JSON.stringify(state, null, 2));
  }
  /** Renderer-safe view: no tokens, no paths. */
  view() {
    const act = this.active();
    const chats = {};
    for (const p of this.pins.values()) if (Date.now() - p.at < 2 * 3600_000) chats[p.id] = (chats[p.id] || 0) + 1;
    return {
      active: act?.id ?? null,
      autoSwitch: this.state.autoSwitch,
      pool: this.state.pool,
      relay: !!this.relay,
      // the account each recent chat is on, and whether the user chose it
      chatAccounts: Object.fromEntries(
        [...this.pins].filter(([, p]) => p.sticky || Date.now() - p.at < PIN_TTL_MS).map(([t, p]) => [t, { id: p.id, pinned: !!p.sticky }]),
      ),
      login: this.login ? { authUrl: this.login.authUrl, targetId: this.login.targetId } : null,
      // the CLI's own login when it is an added account (identity/accounts/cliLogin.cjs): folded id -> shown id
      same: this.same,
      accounts: this.state.accounts.map((a) => ({
        id: a.id,
        email: a.email,
        planType: a.planType,
        kind: a.kind || 'chatgpt',
        baseUrl: a.baseUrl || null,
        mopilot: !!a.mopilot,
        isDefault: a.id === DEFAULT_ID,
        status: a.status,
        error: a.error || null,
        limits: a.limits || null,
        chats: chats[a.id] || 0,
      })),
    };
  }
  changed() {
    // clearTimeout ignores null
    clearTimeout(/** @type {NodeJS.Timeout | undefined} */ (this.changedTimer));
    this.changedTimer = null;
    this.save();
    this.broadcast({ type: 'changed', state: this.view() });
  }
  /** Coalesces bursts (usage headers arrive with every model request). */
  changedSoon() {
    if (!this.changedTimer) this.changedTimer = setTimeout(() => this.changed(), 1000);
  }
  notice(n) {
    this.broadcast({ type: 'notice', ...n });
  }
  setStatus(a, status, /** @type {string | null} */ error = null) {
    if (a.status === status && a.error === error) return;
    const was = a.status;
    a.status = status;
    a.error = error;
    if (status === 'expired' && was !== 'expired') this.notice({ kind: 'expired', id: a.id, email: a.email });
  }

  /* ---------- main app-server plumbing ---------- */
  mainRequest(method, params) {
    const id = `accounts:${++this.mainSeq}`;
    const p = new Promise((resolve, reject) => {
      this.mainPending.set(id, { resolve, reject });
      try {
        this.server.send({ id, method, params });
      } catch (e) {
        this.mainPending.delete(id);
        reject(e);
      }
    });
    return withTimeout(p, method).finally(() => this.mainPending.delete(id));
  }

  /** Sees every app-server message before the windows do; returns true to swallow it. */
  onMainMessage(m) {
    if (typeof m.id === 'string' && m.id.startsWith('accounts:') && !m.method) {
      const p = this.mainPending.get(m.id);
      this.mainPending.delete(m.id);
      if (p) m.error ? p.reject(new Error(m.error.message || 'Request failed')) : p.resolve(m.result);
      return true;
    }
    if (m.method === 'account/chatgptAuthTokens/refresh' && m.id != null) {
      // answerRefresh always replies to the app-server; this only catches a send on a closed connection
      this.answerRefresh(m).catch((error) => noteIgnored('answer the Codex token refresh', error));
      return true;
    }
    if (!m.method) return false;
    const p = m.params || {};
    if (m.method === 'thread/started' && p.thread?.ephemeral) this.ephemeral.add(p.thread.id);
    // With the relay, usage is read per account from response headers instead (noteUsageHeaders).
    if (m.method === 'account/rateLimits/updated' && !this.relay) this.onAppServerUsage(p.rateLimits);
    else if (m.method === 'turn/started') this.noteTurnStarted(p.turn?.id);
    else if (m.method === 'turn/completed') {
      const ranOn = this.endTurn(p.turn?.id);
      // The relay replays refused requests, so this only happens when a limit hit mid-stream or
      // every account is out. Move the chat to another account, and main sends "Continue" (continueChat).
      if (p.turn?.error?.codexErrorInfo !== 'usageLimitExceeded') return false;
      if (this.handledTurns.has(p.turn.id) || this.ephemeral.has(p.threadId)) return false;
      this.handledTurns.add(p.turn.id);
      // onTurnLimit reports its own outcome through notices
      this.onTurnLimit(p.threadId, ranOn, p.turn.id).catch((error) => noteIgnored('move a Codex chat at its usage limit', error));
    } else if ((m.method === 'account/login/completed' || m.method === 'account/updated') && this.mainMode === 'managed') {
      // Sign-in/out done on the main app-server itself (the first-run Login page) changes the CLI's account.
      this.syncDefault();
      this.changed();
    }
    return false;
  }

  /** Points the main app-server at the active account. Called after every (re)connect and switch. */
  apply(work = () => this.applyNow()) {
    // one at a time: an API-key login restores the CLI's auth.json, which an overlapping run would snapshot mid-login (D-72)
    // pendingApply: readings that arrive meanwhile can belong to either login (heldLogin)
    const run = (this.applying || Promise.resolve())
      .then(() => {
        this.pendingApply = true;
        return work();
      })
      .finally(() => (this.pendingApply = false));
    // only keeps the queue in order; the caller gets `run` with its error
    this.applying = Promise.allSettled([run]);
    return run;
  }
  async applyNow() {
    const a = this.active();
    // nothing chosen: a restarted app-server that read the CLI's own key from auth.json lets go of it again
    if (!a) return this.state.active === null && this.get(DEFAULT_ID) ? this.releaseMain().then(() => this.view()) : this.view();
    // A lone CLI account keeps the app-server's own auth handling. With several accounts every one
    // goes through external tokens, so expiry and limits route through failover and re-verify.
    if (a.id === DEFAULT_ID && this.mainMode === 'managed' && this.subscriptions().length < 2) {
      this.applied = a.id;
      return this.view();
    }
    if (this.applied === a.id && this.mainMode === 'external') return this.view();
    const auth = readAuth(this.home(a));
    if (auth?.kind === 'apiKey') {
      await this.applyKey(a, auth.apiKey);
      this.mainMode = 'managed';
    } else {
      const current = this.usageRefresh.capture(a.id);
      const tok = await this.tokens(a);
      if (!current()) throw loginChanged();
      await this.mainRequest('account/login/start', {
        type: 'chatgptAuthTokens',
        accessToken: tok.accessToken,
        chatgptAccountId: tok.chatgptAccountId,
        chatgptPlanType: a.planType ?? null,
      });
      this.mainMode = 'external';
    }
    this.applied = a.id;
    return this.view();
  }

  sidecar(a) {
    const home = this.home(a);
    return this.vault.helper(this.sidecars, home, (onExit) => new Sidecar(this.findBin(), home, onExit, this.clientInfo));
  }

  /* ---------- relay routing ---------- */
  healthy(a) {
    return !!a && a.status === 'ok' && (a.kind || 'chatgpt') === 'chatgpt' && !this.limited(a);
  }
  /** Account load for spreading new chats: usage plus a nudge per chat already placed there. */
  load(a) {
    let n = 0;
    for (const p of this.pins.values()) if (p.id === a.id && Date.now() - p.at < 30 * 60_000) n++;
    return (a.limits?.used ?? 0) + n * 15;
  }
  /**
   * The account to serve a model request for `session` (a thread id). Returns null to pass the
   * request through unchanged (single account), or undefined when nothing is left to try.
   */
  pickFor(session, tried) {
    const pin = session ? this.pins.get(session) : null;
    const pinned = pin && this.get(pin.id);
    if (pinned && (pinned.kind || 'chatgpt') !== 'chatgpt') return undefined; // a key whose route is gone: no other lane
    if (this.subscriptions().length < 2) return tried.size ? undefined : null;
    if (tried.size && !this.state.autoSwitch) return undefined;
    // a temporary chat keeps the account it started on, even out of usage: its history can't move
    if (pinned && this.ephemeral.has(session)) return tried.has(pinned.id) ? undefined : pinned;
    const ok = (a) => this.healthy(a) && !tried.has(a.id);
    const act = this.active();
    // "Stop" keeps a chat on its account and the app on the active one, out or not; only a new chat in a spread pool is placed
    const stay = ok(pinned) || !this.state.autoSwitch ? pinned || (this.state.pool !== 'spread' || !session ? act : null) : null;
    if (stay) {
      if (stay === pinned) pin.at = Date.now();
      else if (session) this.pins.set(session, { id: stay.id, at: Date.now() });
      this.usageRefresh.used(stay.id);
      return stay;
    }
    const pool = this.state.accounts.filter(ok);
    let a;
    if (this.state.pool === 'spread' && session && !pinned)
      a = pool.sort((x, y) => this.load(x) - this.load(y) || Number(y === act) - Number(x === act))[0];
    else a = ok(act) ? act : pool.sort((x, y) => (x.limits?.used ?? 0) - (y.limits?.used ?? 0))[0];
    if (!a) return tried.size ? undefined : act;
    this.usageRefresh.used(a.id);
    if (session) this.pins.set(session, { id: a.id, at: Date.now() });
    // a chat the user put on an account leaves it only when that account can't serve it
    if (session && pinned && pinned !== a && this.state.chatPins?.[session]) delete this.state.chatPins[session];
    if (pinned && pinned !== a)
      this.notice({ kind: 'moved', threadId: session, from: pinned.email, to: a.email, reason: this.unavailableReason(pinned) });
    if (this.state.pool !== 'spread' && a !== act) {
      // One account at a time: the account taking over becomes the active one everywhere.
      const from = act?.email ?? null;
      // switchTo restores the previous active account on failure; the chat is still served by `a`
      this.switchTo(a.id).then(
        () => this.notice({ kind: 'switched', reason: 'limit', from, to: a.email }),
        (error) => noteIgnored('make the Codex account serving a chat the active one', error),
      );
    }
    this.changedSoon();
    return a;
  }
  /** Where a chat pinned to an API key sends its requests, with which key. */
  keyRoute(session) {
    const pin = session ? this.pins.get(session) : null;
    const a = pin && this.get(pin.id);
    if (!a || a.kind !== 'apiKey' || a.status !== 'ok') return null;
    const auth = readAuth(this.home(a));
    return auth?.apiKey ? { base: a.baseUrl || 'https://api.openai.com/v1', key: auth.apiKey } : null;
  }

  setPool(mode) {
    this.state.pool = mode === 'single' ? 'single' : 'spread';
    this.changed();
    return this.view();
  }

  /* ---------- usage & failover ---------- */
  /**
   * Healthy accounts to move to on their own, most headroom first: the same provider and billing
   * type as `cur` (subscription to subscription). Anything else asks first (shared/switch.mjs).
   */
  candidates(cur) {
    const from = cur ? codexInstance(cur, null) : codexInstance({ id: DEFAULT_ID, kind: 'chatgpt' }, null);
    return this.state.accounts
      .filter(
        (a) =>
          a !== cur &&
          a.status === 'ok' &&
          (a.kind || 'chatgpt') === 'chatgpt' &&
          !this.limited(a) &&
          sameLane(from, codexInstance(a, null)),
      )
      .sort((x, y) => (x.limits?.used ?? 0) - (y.limits?.used ?? 0));
  }

  consumeResetCredit(id, creditId) {
    const a = this.resetAccount(id);
    const target = creditId == null ? null : String(creditId);
    const key = JSON.stringify([id, target]);
    // Serialize redemption across windows. Keep the key after an uncertain failure so Retry
    // cannot spend a second card when the first request reached the backend.
    if (this.resetting.has(id)) return Promise.reject(new Error('A reset is already being used for this account. Wait for it to finish.'));
    const idempotencyKey = this.resetAttempts.get(key) ?? crypto.randomUUID();
    this.resetAttempts.set(key, idempotencyKey);
    const job = this.sidecar(a)
      .call('account/rateLimitResetCredit/consume', { idempotencyKey, creditId: target })
      .then((r) => {
        if (['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(r?.outcome)) this.resetAttempts.delete(key);
        return r;
      })
      .finally(() => this.resetting.delete(id));
    this.resetting.set(id, job);
    return job;
  }

  async failover(reason, threadId) {
    if (!this.state.autoSwitch || this.switching) return;
    this.switching = true;
    try {
      const cur = this.active();
      // a limit reading names no account: confirm it with the login's own usage, and stay if the app moved meanwhile
      if (reason === 'limit' && cur && this.subscriptions().length > 1) {
        await this.refreshUsage([cur.id], 'now').catch((error) => noteIgnored('confirm a Codex account is at its limit', error));
        if (this.active() !== cur || !this.limited(cur)) return;
      }
      // stale usage only lowers the ranking quality; candidates() still works
      await this.refreshUsage(
        this.candidates(cur).map((a) => a.id),
        LIMITS_STALE_MS,
      ).catch((error) => noteIgnored('read Codex account usage before switching', error));
      if (!this.state.autoSwitch || this.active() !== cur) return;
      for (const next of this.candidates(cur)) {
        try {
          await this.switchTo(next.id);
          this.notice({ kind: 'switched', reason, from: cur?.email ?? null, to: next.email, threadId: threadId ?? null });
          return;
        } catch (error) {
          // this candidate failed: try the next; the exhausted notice follows when none works
          noteIgnored('switch to another Codex account', error);
        }
      }
      if (this.subscriptions().length > 1 && !this.exhaustedNoticeAt) {
        this.exhaustedNoticeAt = Date.now();
        setTimeout(() => (this.exhaustedNoticeAt = 0), 30 * 60_000);
        this.notice({ kind: 'exhausted' });
      }
    } finally {
      this.switching = false;
    }
  }

  switchTo(id) {
    const target = this.get(id);
    return this.apply(() => switchSelection(this, id, target));
  }

  /* ---------- sign-in (add or re-verify) ---------- */
  async startLogin(/** @type {string | null} */ targetId = null) {
    const target = targetId ? this.get(targetId) : null;
    // "Sign in again" for an account removed since (an expired toast clicked late) is said, never added anew
    if (targetId && !target) throw new Error('That account was removed');
    if (!this.vault.available()) throw new Error('Can’t keep a Codex sign-in safe: the system keychain is unavailable.');
    const epoch = ++this.loginEpoch;
    if (this.loginRun) await this.#cancelLogin(this.loginRun);
    if (this.loginEpoch !== epoch) return this.view();
    if (targetId && (this.removing.has(targetId) || this.get(targetId) !== target))
      throw new Error('This account is being removed. Wait for removal to finish before signing in again.');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const staging = path.join(this.root, `.signin-${crypto.randomUUID()}`);
    const login = {
      epoch,
      targetId,
      staging,
      sc: /** @type {InstanceType<typeof Sidecar> | null} */ (null),
      loginId: null,
      authUrl: '',
      cancelled: false,
      finishing: false,
      timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
      abort: new AbortController(),
    };
    this.loginRun = login;
    const stopped = new Promise((resolve) => login.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      // Force file storage so the sidecar's tokens land in this folder, not a shared keychain item.
      fs.writeFileSync(path.join(staging, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      const sc = new Sidecar(this.findBin(), staging, undefined, this.clientInfo);
      login.sc = sc;
      sc.keepAlive = true;
      sc.touch();
      login.timer = setTimeout(() => {
        if (this.#ownsLogin(login)) this.cancelLogin().catch((error) => noteIgnored('time out a Codex sign-in', error));
      }, 15 * 60_000);
      let early = null;
      const completed = (p) => {
        if (!this.#ownsLogin(login)) return;
        if (!login.loginId) {
          early ??= p;
          return;
        }
        if (this.login !== login) return;
        this.finishLogin(login, p).catch((error) => {
          if (this.loginEpoch === epoch && !login.cancelled) this.notice({ kind: 'loginFailed', error: String(error.message || error) });
        });
      };
      sc.notify.add((method, p) => {
        if (method === 'account/login/completed') completed(p);
      });
      const r = await sc.call('account/login/start', { type: 'chatgpt' });
      if (!this.#ownsLogin(login)) return this.view();
      Object.assign(login, { loginId: r.loginId, authUrl: r.authUrl });
      this.login = login;
      this.changed();
      await withTimeout(Promise.race([Promise.resolve(this.openExternal(r.authUrl)), stopped]), 'Open the Codex sign-in page');
      if (early && this.#ownsLogin(login)) completed(early);
      return this.view();
    } catch (error) {
      const current = this.#ownsLogin(login);
      this.#retireLogin(login);
      await this.#cleanupLogin(login);
      if (!current || login.cancelled || this.loginEpoch !== epoch) return this.view();
      throw new Error(
        /address|in use|1455/i.test(String(error.message))
          ? 'Another sign-in is already in progress (Codex CLI or another app). Finish or cancel it, then try again.'
          : String(error.message),
      );
    }
  }

  #ownsLogin(login) {
    return this.loginRun === login && this.loginEpoch === login.epoch && !login.cancelled;
  }

  #retireLogin(login) {
    clearTimeout(login.timer);
    login.abort.abort();
    if (this.loginRun === login) {
      this.loginRun = null;
      this.login = null;
      this.changed();
    }
  }

  #closeLoginSidecar(login) {
    login.closing ??= Promise.resolve(login.sc?.close());
    return login.closing;
  }

  #cleanupLogin(login) {
    login.cleanup ??= (async () => {
      await this.#closeLoginSidecar(login);
      fs.rmSync(login.staging, { recursive: true, force: true });
    })();
    return login.cleanup;
  }

  async #cancelLogin(login) {
    login.cancelled = true;
    this.#retireLogin(login);
    try {
      if (login.loginId)
        await login.sc
          .call('account/login/cancel', { loginId: login.loginId })
          .catch((error) => noteIgnored('cancel a Codex sign-in', error));
    } finally {
      await this.#cleanupLogin(login);
    }
  }

  async cancelLogin() {
    this.loginEpoch++;
    if (this.loginRun) await this.#cancelLogin(this.loginRun);
    return this.view();
  }

  async finishLogin(l, p) {
    if (!this.#ownsLogin(l) || l.finishing) return;
    l.finishing = true;
    try {
      if (!p.success) {
        if (!/cancel/i.test(String(p.error || ''))) this.notice({ kind: 'loginFailed', error: p.error || 'Sign in failed' });
        return;
      }
      // Without the account read, the email and plan come from the new credentials themselves.
      const info = await l.sc
        .call('account/read', { refreshToken: false })
        .catch((error) => (noteIgnored('read a new Codex sign-in', error), null));
      if (!this.#ownsLogin(l)) return;
      const auth = readAuth(l.staging);
      if (auth?.kind !== 'chatgpt') throw new Error('Sign in did not return ChatGPT credentials');
      const email = info?.account?.email ?? auth.email;
      const planType = info?.account?.planType ?? auth.planType;
      const key = codexServerId({ chatgptAccountId: auth.chatgptAccountId, email });
      const existing = key && this.state.accounts.find((account) => !this.removing.has(account.id) && codexServerId(account) === key);
      const target = l.targetId ? this.get(l.targetId) : null;
      await this.#closeLoginSidecar(l);
      if (!this.#ownsLogin(l)) return;
      if (existing && (this.get(existing.id) !== existing || this.removing.has(existing.id))) return;
      let acct;
      if (existing) {
        writeAuth(this.home(existing), fs.readFileSync(path.join(l.staging, 'auth.json'), 'utf8'));
        acct = existing;
        Object.assign(acct, { email, planType });
        this.setStatus(acct, 'ok');
        if (this.applied === acct.id && this.mainMode === 'external') this.applied = null;
      } else {
        const id = crypto.randomUUID();
        fs.renameSync(l.staging, path.join(this.root, id));
        this.vault.seal(path.join(this.root, id));
        acct = { id, kind: 'chatgpt', email, planType, chatgptAccountId: auth.chatgptAccountId, status: 'ok', addedAt: Date.now() };
        this.state.accounts.push(acct);
      }
      const cur = this.active();
      if (!cur || cur.status === 'expired' || cur === acct) this.state.active = acct.id;
      // The account is installed: retire its old reads before applying can wait on a token.
      this.usageRefresh.clear(acct.id);
      this.#retireLogin(l);
      await this.apply().catch((error) => noteIgnored('use a new Codex sign-in', error));
      if (this.loginEpoch !== l.epoch) return;
      this.notice({ kind: 'signedIn', email, added: !existing, mismatch: target && target !== acct ? target.email : null });
      this.refreshUsage([acct.id], 'now').catch((error) => noteIgnored('read the usage of a new Codex sign-in', error));
    } finally {
      this.#retireLogin(l);
      await this.#cleanupLogin(l);
    }
  }

  /* ---------- removal ---------- */
  remove(id) {
    if (this.removing.has(id)) return this.removing.get(id);
    const cancellation = this.loginRun?.targetId === id ? this.cancelLogin() : Promise.resolve();
    const removing = Promise.allSettled([this.removalTail, cancellation])
      .then(([, cancelled]) => {
        if (cancelled.status === 'rejected') throw cancelled.reason;
        return this.#remove(id);
      })
      .finally(() => this.removing.delete(id));
    this.removing.set(id, removing);
    // Only the caller receives failures; the next removal must still run against the latest collection.
    this.removalTail = Promise.allSettled([removing]).then(() => undefined);
    return removing;
  }

  async #remove(id) {
    // the CLI's own login folded into this account stays signed in: listed again, it is where the app falls back to
    this.syncDefault();
    this.forgetChats(id);
    const a = this.get(id);
    if (!a) return this.view();
    const others = this.state.accounts.filter((x) => x !== a);
    if (this.state.active === id) {
      const next = this.fallbackFor(a);
      if (next) {
        this.state.active = next.id;
        // the account is removed regardless; apply() retries on the next reconnect
        await this.apply().catch((error) => noteIgnored('use the next Codex account after a removal', error));
      } else if (others.length) await this.releaseMain();
    }
    const selected = this.state.active;
    if (!others.length) {
      // Last account: a plain logout on the main app-server (clears its auth and $CODEX_HOME/auth.json).
      // best effort: the local auth.json is deleted below either way
      await this.mainRequest('account/logout', {}).catch((error) => noteIgnored('sign Codex out of its last account', error));
      this.mainMode = 'managed';
      this.applied = null;
    } else {
      // Sign the account's own home out (revokes its tokens), without touching the main app-server.
      // best effort: the account home is deleted below either way
      await this.sidecar(a)
        .call('account/logout', {})
        .catch((error) => noteIgnored('sign a removed Codex account out', error));
    }
    const sc = this.sidecars.get(this.home(a));
    if (sc) await sc.close();
    if (a.id === DEFAULT_ID) fs.rmSync(path.join(defaultHome(), 'auth.json'), { force: true });
    else fs.rmSync(this.home(a), { recursive: true, force: true });
    try {
      await this.forgetProvider?.(id);
    } catch (error) {
      // a keychain entry left behind is not used again and gets replaced
      noteIgnored("forget a removed Codex account's provider key", error);
    }
    // Remove only the captured account: other logins may have committed while logout/cleanup awaited.
    this.state.accounts = this.state.accounts.filter((account) => account !== a);
    this.usageRefresh.forget(id);
    if (this.state.active !== null && !this.get(this.state.active)) this.state.active = this.fallbackFor(a)?.id ?? DEFAULT_ID;
    if (this.state.active !== selected && this.active())
      await this.apply().catch((error) => noteIgnored('use an account added during Codex account removal', error));
    this.changed();
    return this.view();
  }

  /** Put a chat on one account (null: back to the pool). Takes effect from its next turn. */
  pinChat(threadId, id) {
    if (!threadId) return this.view();
    const pins = { ...(this.state.chatPins || {}) };
    if (id && this.get(id)) {
      if (!this.inChatLane(threadId, this.get(id))) throw new Error('A chat can only move to an account billed the same way');
      pins[threadId] = id;
    } else delete pins[threadId];
    // persist before publishing: a failed write leaves the saved choice and the relay's routing untouched
    this.save({ ...this.state, chatPins: pins });
    this.state.chatPins = pins;
    if (id && this.get(id)) this.pins.set(threadId, { id, at: Date.now(), sticky: true });
    else if (this.pins.has(threadId)) this.pins.get(threadId).sticky = false;
    // an open connection keeps the account it started on; reconnecting applies the new one
    this.relay?.dropSession(threadId);
    this.broadcast({ type: 'changed', state: this.view() });
    return this.view();
  }

  setAutoSwitch(on) {
    this.state.autoSwitch = !!on;
    this.changed();
    return this.view();
  }

  dispose() {
    this.loginEpoch++;
    clearInterval(this.poll);
    this.relay?.stop();
    for (const sc of this.sidecars.values()) sc.close();
    this.vault.sealAll();
    if (this.loginRun) this.cancelLogin().catch((error) => noteIgnored('cancel a Codex sign-in at quit', error));
  }
}

module.exports = { Accounts, readAuth, limitInfo };
