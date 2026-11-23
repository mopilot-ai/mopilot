// AccountDriver for Codex: the accounts.cjs pool seen as instances.
//
// ChatGPT logins are subscriptions on OpenAI; an API key is pay-per-use on OpenAI or on the gateway
// it points at; the MoPilot device key is credits. With the relay running, a request refused for a
// limit or an expired login is replayed on another account; without it the active account switches
// and the window sends "Continue".
const { instance, providerFor, PROVIDERS } = require('../contract/registry.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const DEFAULT_ID = 'default';
const LIMITS_STALE_MS = 5 * 60_000;

/** One accounts.cjs record as an instance; `limited`: the pool counts it out of usage (Accounts.limited). */
function codexInstance(a, activeId, limited = false) {
  const kind = a.kind || 'chatgpt';
  const base = {
    harness: 'codex',
    account: a.id,
    label: a.email ?? null,
    status: a.status === 'expired' ? 'expired' : 'ok',
    limited,
    limitedUntil: a.limits?.resetsAt ? a.limits.resetsAt * 1000 : undefined,
    active: a.id === activeId,
  };
  if (a.mopilot) return instance({ ...base, provider: PROVIDERS.mopilot, kind: 'sageKey', billing: 'credits', label: 'MoPilot credits' });
  if (kind === 'apiKey')
    return instance({
      ...base,
      provider: providerFor(a.baseUrl, 'openai'),
      kind: a.id === DEFAULT_ID ? 'cliLogin' : 'sageKey',
      billing: 'apiKey',
    });
  return instance({ ...base, provider: PROVIDERS.openai, kind: a.id === DEFAULT_ID ? 'cliLogin' : 'harnessAuth', billing: 'subscription' });
}

class CodexDriver {
  /** @param {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} accounts */
  constructor(accounts) {
    this.harness = 'codex';
    this.accounts = accounts;
  }
  instances() {
    const act = this.accounts.active();
    return this.accounts.state.accounts.map((a) => codexInstance(a, act?.id ?? null, this.accounts.limited(a)));
  }
  /** How a limit or expired login is handled: 'replay' through the relay, else switch and 'continue'. */
  get failover() {
    return this.accounts.relay ? 'replay' : 'continue';
  }
  /** Chats can be put on an account of their own: the relay routes by thread once it pools two subscriptions (pickFor). */
  get perChat() {
    return !!this.accounts.relay && this.accounts.subscriptions().length > 1;
  }
  get poolPolicy() {
    return { pool: this.accounts.state.pool, autoSwitch: !!this.accounts.state.autoSwitch };
  }
  /** The instance a chat is on (its pin), else the active one. */
  chatInstance(threadId) {
    const pin = threadId ? this.accounts.pins.get(threadId) : null;
    const a = (pin && this.accounts.get(pin.id)) || this.accounts.active();
    return a ? codexInstance(a, this.accounts.active()?.id ?? null) : null;
  }
  /** The usage windows of the login serving a thread (its own reading, never another login's), or null when that cannot be told. */
  chatLimits(threadId) {
    return this.accounts.servingLogin(threadId)?.limits ?? null;
  }
  /** Usage windows for one account, read again when stale. */
  async usage(account, reason = LIMITS_STALE_MS) {
    const a = this.accounts.get(account);
    if (!a || (a.kind || 'chatgpt') !== 'chatgpt') return null;
    // refresh failed: fall back to the last known limits below
    await this.accounts
      .refreshUsage([account], reason)
      .catch((error) => noteIgnored('read Codex account usage for the identity view', error));
    return this.accounts.get(account)?.limits ?? null;
  }
}

module.exports = { CodexDriver, codexInstance };
