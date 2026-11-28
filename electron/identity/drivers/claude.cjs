// AccountDriver for Claude Code: CLI logins (harness/claude/accounts.cjs) plus what else harness/claude/index.cjs can run
// on: the Anthropic API key, the MoPilot device key and a model config of the user's own provider (MoPilot's model router).
//
// A CLI login is a subscription unless the CLI says it signed in with a Console API key. Keys apply to
// the whole harness: while one is selected it is the active instance. A chat that runs out moves to
// another login by closing its process and resuming the session there ('restartResume').
const { instance, providerFor, PROVIDERS } = require('../contract/registry.cjs');
const { loginBilling, claudeBilling } = require('../contract/claudeBilling.cjs');
const { foldMarks } = require('../contract/sameAccount.cjs');
const { planUnits } = require('../../../shared/remainingCapacity.mjs');

const DEFAULT_ID = 'default';

/**
 * Instances from the account view and the harness's key state.
 * @param {{ active: string, same?: Record<string, string>, accounts: { id: string, email: string|null, loggedIn: boolean, authMethod?: string|null, subscriptionType?: string|null, organizationType?: string|null, rateLimitTier?: string|null }[] }} view
 *   same: logins left out as the same account as a listed one (identity/contract/sameAccount.cjs)
 * @param {{ set: boolean, mode: 'subscription'|'apiKey'|'mopilot'|'routed', baseUrl: string|null, routed?: { name: string | null } }} key
 * @param {boolean} gatewaySet
 * @param {{ get: (id: string) => { expired?: boolean, limitedUntil?: number, left?: number } | undefined, snapshot?: () => Map<string, any> } | null} [marks] what main has seen of
 *   each login (identity/contract/loginMarks.cjs): a lapsed sign-in the CLI still reports as logged in, a limit until its reset
 * @param {number} [now] ms
 */
function claudeInstances(view, key, gatewaySet, marks = null, now = Date.now()) {
  const mode = key?.mode ?? 'subscription';
  // a limit seen on a login left out as the same account holds the listed one: it is one quota (#1312)
  const held = marks?.snapshot ? foldMarks(marks.snapshot(), view?.same ?? {}) : marks;
  const statusOf = (a) => (!a.loggedIn ? 'signedOut' : held?.get(a.id)?.expired ? 'expired' : 'ok');
  // what a turn's rate-limit event or the login's /usage last said is left (loginMarks.cjs); once a limit it marked has
  // lifted, what is left since is not known until the next reading
  const leftOf = (id) => {
    const m = held?.get(id);
    return m?.limitedUntil && m.limitedUntil <= now ? null : (m?.left ?? null);
  };
  const out = (view?.accounts ?? []).map((a) =>
    instance({
      harness: 'claude',
      account: a.id,
      provider: PROVIDERS.anthropic,
      kind: a.id === DEFAULT_ID ? 'cliLogin' : 'harnessAuth',
      billing: loginBilling(a.authMethod),
      label: a.email ?? null,
      status: statusOf(a),
      limited: (held?.get(a.id)?.limitedUntil ?? 0) > now,
      limitedUntil: held?.get(a.id)?.limitedUntil,
      left: leftOf(a.id),
      // the plan as the CLI names it ("max") and its rate-limit tier ("default_claude_max_20x"), as claudePlanLabel reads them
      units: planUnits('claude', [a.subscriptionType || a.organizationType, a.rateLimitTier].filter(Boolean).join(' ')),
      active: mode === 'subscription' && a.id === view.active,
    }),
  );
  if (key?.set)
    out.push(
      instance({
        harness: 'claude',
        account: 'apiKey',
        provider: providerFor(key.baseUrl, 'anthropic'),
        kind: 'sageKey',
        billing: 'apiKey',
        label: key.baseUrl ? claudeBilling('apiKey', key.baseUrl).label : 'API key',
        active: mode === 'apiKey',
      }),
    );
  if (gatewaySet)
    out.push(
      instance({
        harness: 'claude',
        account: 'mopilot',
        provider: PROVIDERS.mopilot,
        kind: 'sageKey',
        billing: 'credits',
        label: 'MoPilot credits',
        active: mode === 'mopilot',
      }),
    );
  // the user's own provider is there while it is chosen: the model config is picked in Settings, not from this list
  if (mode === 'routed')
    out.push(
      instance({
        harness: 'claude',
        account: 'routed',
        provider: PROVIDERS.routed,
        kind: 'sageKey',
        billing: 'apiKey',
        label: key.routed?.name ? `${PROVIDERS.routed.label} · ${key.routed.name}` : PROVIDERS.routed.label,
        active: true,
      }),
    );
  return out;
}

class ClaudeDriver {
  /**
   * @param {{ accounts: () => InstanceType<typeof import('../../harness/claude/accounts.cjs').ClaudeAccounts> | null, keyInfo: () => any, gatewaySet: () => boolean, readUsage: (account: string) => Promise<string>, marks?: () => any, now?: () => number }} o
   *   marks: the logins' marks main keeps (ClaudeAdapter.marks), once the sessions are open
   */
  constructor(o) {
    this.harness = 'claude';
    this.o = o;
  }
  instances() {
    const accts = this.o.accounts();
    return claudeInstances(
      accts ? accts.view() : { active: DEFAULT_ID, accounts: [] },
      this.o.keyInfo(),
      this.o.gatewaySet(),
      this.o.marks?.() ?? null,
      (this.o.now ?? Date.now)(),
    );
  }
  get failover() {
    return 'restartResume';
  }
  /** A chat picks a login of its own only on the subscription: a key or credits run the whole harness. */
  get perChat() {
    return (this.o.keyInfo()?.mode ?? 'subscription') === 'subscription';
  }
  get poolPolicy() {
    return { pool: 'single', autoSwitch: !!(this.o.accounts()?.state.autoSwitch ?? true) };
  }
  /** The CLI's /usage text for one login; rejects with the reason when it can't be read, so a caller can show it. */
  usage(account) {
    return this.o.readUsage(account);
  }
}

module.exports = { ClaudeDriver, claudeInstances };
