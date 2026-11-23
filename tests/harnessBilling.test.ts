// Subscription ⇄ API key ⇄ MoPilot credits per harness (src/session/harness/billing.ts), and the offer made when a
// subscription runs out.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';
import { defined } from './support/defined.ts';

const rechecks: any[] = [];
mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: {
    recheckClaude: async (...a: any[]) => void rechecks.push(a),
    ...Object.fromEntries(
      ['addClaudeAccount', 'pinClaudeChat', 'reloginClaudeAccount', 'removeClaudeAccount', 'switchClaudeAccount'].map((n) => [n, () => {}]),
    ),
  },
});
const billing = await import('../src/session/harness/billing.ts');

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;
beforeEach(() => {
  reset();
  rechecks.length = 0;
});

test('Claude billing is unknown until main reports the key; a failed read leaves it unknown', async () => {
  let reads = 0;
  fx.native.claude = { apiKey: async () => (reads++, Promise.reject(new Error('no main'))) };
  assert.equal(billing.useBilling('claude'), null);
  await tick();
  assert.equal(reads, 1, 'the first use reads the key');
  assert.equal(billing.useClaudeKey(), null);
  // each subscription unsubscribes on cleanup
  fx.cleanups.forEach((c) => c());
});

test('a key change is published to every user and the login is re-checked', async () => {
  fx.native.claude = { apiKey: () => new Promise(() => {}) };
  const k = billing.useClaudeKey();
  assert.equal(k, null);
  await billing.applyClaudeKey(async () => ({ mode: 'apiKey', set: true }) as any);
  assert.ok(fx.notified >= 1);
  assert.equal(rechecks.length, 1);
  assert.deepEqual(billing.useClaudeKey(), { mode: 'apiKey', set: true });
  fx.cleanups.forEach((c) => c());
});

test("refreshClaudeKey takes main's answer", async () => {
  fx.native.claude = { apiKey: async () => ({ mode: 'subscription', set: false }) };
  await billing.refreshClaudeKey();
  assert.deepEqual(billing.useClaudeKey(), { mode: 'subscription', set: false });
});

test('signing out of MoPilot while Claude bills credits re-reads the key and re-checks', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'mopilot', set: false }) as any);
  rechecks.length = 0;
  let reads = 0;
  fx.native.claude = { apiKey: async () => (reads++, { mode: 'subscription', set: false }) };
  fx.mopilot.signedIn = true;
  billing.useClaudeKey();
  await tick();
  assert.equal(reads, 0);
  fx.mopilot.signedIn = false;
  billing.useClaudeKey();
  await tick();
  assert.equal(reads, 1);
  assert.equal(rechecks.length, 1);
});

test('useBilling for Claude: options follow the key and MoPilot sign-in; switching goes through main', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  fx.mopilot.signedIn = true;
  const b = billing.useBilling('claude')!;
  assert.equal(b.mode, 'subscription');
  assert.deepEqual(b.options, ['apiKey', 'mopilot']);
  const modes: string[] = [];
  fx.native.claude = { setAuthMode: async (m: string) => (modes.push(m), { mode: m, set: false }) };
  await b.switchTo('apiKey');
  assert.deepEqual(modes, ['apiKey']);
  assert.equal(billing.useBilling('claude')!.mode, 'apiKey');
  fx.mopilot.signedIn = false;
  assert.deepEqual(billing.useBilling('claude')!.options, ['subscription']);
});

test('useBilling for Codex reads the pool: credits, key or subscription', async () => {
  fx.state.accounts = { active: 'a', accounts: [{ id: 'a', kind: 'chatgpt', status: 'ok' }] };
  let b = billing.useBilling('codex')!;
  assert.equal(b.mode, 'subscription');
  assert.deepEqual(b.options, []);
  fx.state.accounts = {
    active: 'k',
    accounts: [
      { id: 'k', kind: 'apiKey' },
      { id: 'm', kind: 'apiKey', mopilot: true },
      { id: 's', kind: 'chatgpt', status: 'expired' },
    ],
  };
  b = billing.useBilling('codex')!;
  assert.equal(b.mode, 'apiKey');
  assert.deepEqual(b.options, ['mopilot']);
  fx.state.accounts.active = 'm';
  assert.equal(billing.useBilling('codex')!.mode, 'mopilot');
  fx.state.accounts.active = 'missing';
  assert.equal(billing.useBilling('codex')!.mode, 'subscription');
  await billing.useBilling('codex')!.switchTo('apiKey');
  // Your own provider is Claude Code's only: Codex never moves to it
  await billing.useBilling('codex')!.switchTo('routed');
  assert.deepEqual(called('setCodexMode'), [['apiKey']]);
});

test('paying with MoPilot credits signs in first when needed', async () => {
  const modes: string[] = [];
  fx.native.claude = { setAuthMode: async (m: string) => (modes.push(m), { mode: m }) };
  fx.native.mopilot = { signIn: async () => ({ ok: false, error: 'cancelled' }) };
  await billing.payWithMoPilotCredits('codex');
  assert.deepEqual(called('toast'), [['cancelled', 'error']]);
  fx.native.mopilot = { signIn: async () => ({ ok: false }) };
  await billing.payWithMoPilotCredits('codex');
  assert.equal(called('toast').length, 1);
  assert.deepEqual(called('setCodexMode'), []);
  fx.native.mopilot = { signIn: async () => ({ ok: true }) };
  await billing.payWithMoPilotCredits('codex');
  assert.deepEqual(called('setCodexMode'), [['mopilot']]);
  fx.mopilot.signedIn = true;
  await billing.payWithMoPilotCredits('claude');
  assert.deepEqual(modes, ['mopilot']);
  fx.store.setCodexMode = async () => {
    throw new Error('gateway down');
  };
  await billing.payWithMoPilotCredits('codex');
  fx.store.setCodexMode = async () => {
    throw 'raw';
  };
  await billing.payWithMoPilotCredits('codex');
  assert.deepEqual(called('toast').slice(1), [
    ['gateway down', 'error'],
    ['raw', 'error'],
  ]);
});

test('limitInstances: Codex accounts by provider, billing, status and limit', () => {
  fx.state.accounts = {
    active: 'sub',
    accounts: [
      { id: 'sub', kind: 'chatgpt', status: 'ok', limits: { reached: true, resetsAt: future() } },
      { id: 'old', kind: 'chatgpt', status: 'expired', limits: { reached: true, resetsAt: past() } },
      { id: 'nolimit', kind: 'chatgpt', status: 'ok', limits: { reached: true, resetsAt: null } },
      { id: 'key', kind: 'apiKey', status: 'ok' },
      { id: 'proxy', kind: 'apiKey', status: 'ok', baseUrl: 'https://llm.example.com/v1' },
      { id: 'odd', kind: 'apiKey', status: 'ok', baseUrl: 'not a url' },
      { id: 'credits', kind: 'apiKey', status: 'ok', mopilot: true },
    ],
  };
  const { from, candidates } = billing.limitInstances('codex');
  assert.equal(from!.id, 'sub');
  assert.deepEqual(
    candidates.map((c) => [c.id, c.provider, c.billing, c.status, c.limited]),
    [
      ['sub', 'openai', 'subscription', 'ok', true],
      ['old', 'openai', 'subscription', 'expired', false],
      ['nolimit', 'openai', 'subscription', 'ok', true],
      ['key', 'openai', 'apiKey', 'ok', false],
      ['proxy', 'custom:llm.example.com', 'apiKey', 'ok', false],
      ['odd', 'custom:not a url', 'apiKey', 'ok', false],
      ['credits', 'mopilot', 'credits', 'ok', false],
    ],
  );
  fx.state.accounts.active = 'gone';
  assert.equal(billing.limitInstances('codex').from, null);
});

test('limitInstances: Claude logins, then a key and MoPilot credits when available', () => {
  fx.state.claudeAccounts = {
    active: 'max',
    accounts: [
      { id: 'max', loggedIn: true, authMethod: 'claude.ai' },
      { id: 'console', loggedIn: true, authMethod: 'Console API key' },
      { id: 'out', loggedIn: false },
    ],
  };
  fx.state.claudeUsage = {
    max: { windows: [{ usedPercent: 100, resetsAt: future() }] },
    out: { windows: [{ usedPercent: 100, resetsAt: past() }] },
  };
  const r = billing.limitInstances('claude', fx.state, { set: true, baseUrl: 'https://gw.example.com' } as any, true);
  assert.deepEqual(
    r.candidates.map((c) => [c.id, c.provider, c.billing, c.status, c.limited]),
    // the logins with the most left first: `max` has used up its window, the others have no reading that still holds
    [
      ['console', 'anthropic', 'apiKey', 'ok', false],
      ['out', 'anthropic', 'subscription', 'signedOut', false],
      ['max', 'anthropic', 'subscription', 'ok', true],
      ['apiKey', 'custom:gw.example.com', 'apiKey', 'ok', undefined],
      ['mopilot', 'mopilot', 'credits', 'ok', undefined],
    ],
  );
  assert.equal(r.from!.id, 'max');
  fx.state.claudeAccounts = { active: 'default', accounts: [] };
  const none = billing.limitInstances('claude', fx.state, null, false);
  assert.deepEqual(none, { from: { id: 'default', provider: 'anthropic', billing: 'subscription', status: 'ok' }, candidates: [] });
  const key = billing.limitInstances('claude', fx.state, { set: true } as any, false);
  assert.equal(key.candidates[0].provider, 'anthropic');
  // defaults: the store's state, the key main reported (none yet) and the MoPilot sign-in (signed out)
  assert.deepEqual(billing.limitInstances('claude'), none);
});

const codexReady = (used: number, extra: any = {}) => ({
  conn: 'ready',
  rateLimits: { rateLimits: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: future() } } },
  account: { type: 'chatgpt' },
  ...extra,
});

test('an exhausted subscription is offered a paid fallback once, and the offer can be taken', async () => {
  fx.native.claude = { apiKey: async () => ({ mode: 'subscription', set: false }) };
  billing.startLimitWatch();
  await tick();
  // nothing exhausted
  fx.store.setCodexMode = async () => {};
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  assert.equal(called('toast').length, 0);

  // Codex: a key of the same provider is pay-per-use (confirm)
  // with saved accounts, the active account's own quota is the one that ran out
  const subLimits = codexReady(100).rateLimits.rateLimits;
  Object.assign(fx.state, codexReady(100), {
    accounts: {
      active: 'sub',
      accounts: [
        { id: 'sub', kind: 'chatgpt', status: 'ok', limits: subLimits },
        { id: 'key', kind: 'apiKey', status: 'ok' },
      ],
    },
  });
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  const [text, kind, opts] = called('toast')[0];
  assert.match(text, /OpenAI API key/);
  assert.equal(kind, 'error');
  assert.equal(opts.action.label, 'Continue with API key');
  // the same windows are not offered again
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  assert.equal(called('toast').length, 1);
  await opts.action.run();
  assert.deepEqual(called('setCodexMode'), [['apiKey']]);
  assert.deepEqual(called('toast').at(-1), ['Codex now bills your API key', 'success']);
  fx.store.setCodexMode = async () => {
    throw new Error('no key');
  };
  await opts.action.run();
  assert.deepEqual(called('toast').at(-1), ['no key', 'error']);
  fx.store.setCodexMode = async () => {
    throw 'raw';
  };
  await opts.action.run();
  assert.deepEqual(called('toast').at(-1), ['raw', 'error']);
});

test('Claude out of its subscription with only MoPilot credits is offered credits', async () => {
  fx.state.claude.status = {
    state: 'ready',
    usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: null, resetsText: 'at 5pm' }] },
  };
  fx.state.claudeAccounts = { active: 'max', accounts: [{ id: 'max', loggedIn: true }] };
  fx.mopilot.signedIn = true;
  const modes: string[] = [];
  fx.native.claude = { setAuthMode: async (m: string) => (modes.push(m), { mode: m }) };
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  const [text, , opts] = called('toast')[0];
  assert.equal(text, 'Claude Code has reached its subscription limit');
  assert.equal(opts.action.label, 'Continue on MoPilot credits');
  await opts.action.run();
  assert.deepEqual(modes, ['mopilot']);
  assert.deepEqual(called('toast').at(-1), ['Claude Code now bills MoPilot credits', 'success']);
  // a window without any reset information still has an id
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: 'Weekly', usedPercent: 120, resetsAt: null }] } };
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  assert.equal(defined(called('toast').at(-1))[0], 'Claude Code has reached its subscription limit');
});

test('Claude out of its subscription with an API key set is asked about pay-per-use', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  // a window of its own (each is offered once): later tests run out the 5h window resetting in an hour
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future() + 600 }] } };
  fx.state.claudeAccounts = { active: 'max', accounts: [{ id: 'max', loggedIn: true }] };
  const modes: string[] = [];
  fx.native.claude = { setAuthMode: async (m: string) => (modes.push(m), { mode: m, set: true }) };
  fx.listeners.forEach((l) => l(fx.state, fx.state));
  const [text, , opts] = called('toast')[0];
  assert.match(text, /Anthropic API key/);
  await opts.action.run();
  assert.deepEqual(modes, ['apiKey']);
  assert.deepEqual(called('toast').at(-1), ['Claude Code now bills your API key', 'success']);
});

test('no offer: Stop chosen, not on a subscription, nothing exhausted, or another subscription takes over', () => {
  const fire = () => fx.listeners.forEach((l) => l(fx.state, fx.state));
  const subLimits = codexReady(100).rateLimits.rateLimits;
  Object.assign(fx.state, codexReady(100), {
    accounts: {
      active: 'sub',
      autoSwitch: false,
      accounts: [
        { id: 'sub', kind: 'chatgpt', status: 'ok', limits: subLimits },
        { id: 'key', kind: 'apiKey', status: 'ok' },
      ],
    },
  });
  fire();
  fx.state.accounts = { active: null, accounts: [] };
  Object.assign(fx.state, codexReady(100, { account: { type: 'apiKey' } }));
  fx.state.claude.status = { state: 'signin', usage: null };
  fire();
  Object.assign(fx.state, codexReady(50));
  fx.state.claude.status = { state: 'ready', usage: null };
  fire();
  // a second subscription switches on its own
  Object.assign(fx.state, codexReady(100), {
    accounts: {
      active: 'a',
      accounts: [
        { id: 'a', kind: 'chatgpt', status: 'ok' },
        { id: 'b', kind: 'chatgpt', status: 'ok' },
      ],
    },
  });
  fire();
  // even when the active account's own quota is the one that ran out
  const limits = codexReady(100).rateLimits.rateLimits;
  Object.assign(fx.state, codexReady(100), {
    accounts: {
      active: 'a',
      accounts: [
        { id: 'a', kind: 'chatgpt', status: 'ok', limits },
        { id: 'b', kind: 'chatgpt', status: 'ok' },
      ],
    },
  });
  fire();
  assert.equal(called('toast').length, 0);
});

test('distinct exhausted windows cannot suppress each other through label/reset delimiters', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: false }) as any);
  fx.state.claudeAccounts = { active: 'max', accounts: [{ id: 'max', loggedIn: true }] };
  fx.mopilot.signedIn = true;
  fx.state.claude.status = {
    state: 'ready',
    usage: { windows: [{ label: 'identity-window@part', usedPercent: 100, resetsAt: null, resetsText: 'later' }] },
  };
  fx.listeners.forEach((listener) => listener(fx.state, fx.state));
  assert.equal(called('toast').length, 1);
  fx.state.claude.status.usage.windows = [{ label: 'identity-window', usedPercent: 100, resetsAt: null, resetsText: 'part@later' }];
  fx.listeners.forEach((listener) => listener(fx.state, fx.state));
  assert.equal(called('toast').length, 2);
  fx.listeners.forEach((listener) => listener(fx.state, fx.state));
  assert.equal(called('toast').length, 2);
});

test('limit offers for different subscription accounts do not share a suppression key', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: false }) as any);
  fx.mopilot.signedIn = true;
  fx.state.claude.status = {
    state: 'ready',
    usage: { windows: [{ label: 'account-bound-window', usedPercent: 100, resetsAt: null, resetsText: 'later' }] },
  };
  for (const id of ['first-account', 'second-account']) {
    fx.state.claudeAccounts = { active: id, accounts: [{ id, loggedIn: true }] };
    fx.listeners.forEach((listener) => listener(fx.state, fx.state));
  }
  assert.equal(called('toast').length, 2);
});

test('an exhausted Codex quota with no active account cannot offer an unrelated paid lane', () => {
  Object.assign(fx.state, codexReady(100));
  fx.state.accounts = { active: null, accounts: [] };
  fx.state.claude.status = { state: 'signin', usage: null };
  fx.listeners.forEach((listener) => listener(fx.state, fx.state));
  assert.equal(called('toast').length, 0);
});

/* ---------- "When a limit is reached", per harness ---------- */
// each test uses its own account id: an offer is made once per account and window
const codexPool = (id: string, autoSwitch: boolean, more: any[] = []) => ({
  ...codexReady(100),
  accounts: {
    active: id,
    autoSwitch,
    accounts: [
      { id, kind: 'chatgpt', status: 'ok', limits: codexReady(100).rateLimits.rateLimits },
      ...more,
      { id: 'key', kind: 'apiKey', status: 'ok' },
    ],
  },
});
const fire = () => fx.listeners.forEach((l) => l(fx.state, fx.state));

test('"Switch subscription" (a fresh install) asks before paid access once no subscription is left', () => {
  fx.state.claude.status = { state: 'signin', usage: null };
  Object.assign(fx.state, codexPool('fresh', true));
  fire();
  assert.match(defined(called('toast')[0])[0], /OpenAI API key/);
});

test('"Ask to use paid access" asks even while another subscription has room; "Stop" never asks', () => {
  fx.state.claude.status = { state: 'signin', usage: null };
  Object.assign(fx.state, codexPool('asks', false, [{ id: 'b', kind: 'chatgpt', status: 'ok' }]));
  fx.state.prefs.limitAsk = { codex: false };
  fire();
  assert.equal(called('toast').length, 0);
  fx.state.prefs.limitAsk = { codex: true };
  fire();
  assert.match(defined(called('toast')[0])[0], /OpenAI API key/);
});

test("one harness's choice never decides the other's: Codex on Stop, Claude Code still asks", async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  Object.assign(fx.state, codexPool('stops', false));
  fx.state.prefs.limitAsk = { codex: false };
  fx.state.claudeAccounts = { active: 'max', autoSwitch: true, accounts: [{ id: 'max', loggedIn: true }] };
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future() }] } };
  fire();
  assert.equal(called('toast').length, 1);
  assert.match(defined(called('toast')[0])[0], /Anthropic API key/);
  // and Claude Code on Stop stays quiet while Codex asks
  reset();
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  Object.assign(fx.state, codexPool('switches', true));
  fx.state.prefs.limitAsk = { claude: false };
  fx.state.claudeAccounts = { active: 'max', autoSwitch: false, accounts: [{ id: 'max', loggedIn: true }] };
  fx.state.claude.status = { state: 'ready', usage: { windows: [{ label: '5h', usedPercent: 100, resetsAt: future() + 1 }] } };
  fire();
  assert.deepEqual(
    called('toast').map((c) => /OpenAI/.test(c[0])),
    [true],
  );
});

test('no paid-use offer for a window past its reset, or from a reading too old to trust; a fresh one asks', async () => {
  await billing.applyClaudeKey(async () => ({ mode: 'subscription', set: true }) as any);
  fx.state.claudeAccounts = { active: 'max', autoSwitch: true, accounts: [{ id: 'max', loggedIn: true }] };
  const full = (resetsAt: number, at: number) => ({
    state: 'ready',
    usage: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt }], at },
  });
  // the week started over at its reset
  fx.state.claude.status = full(past(), Date.now());
  fire();
  // a cached answer the CLI gave 47 minutes ago, when it couldn't fetch
  fx.state.claude.status = full(future() + 7, Date.now() - 47 * 60_000);
  fire();
  assert.equal(called('toast').length, 0);
  // a fresh reading that kept an old exhausted window from an older one: that window is as old as its reading
  fx.state.claude.status = {
    state: 'ready',
    usage: { windows: [{ label: 'Weekly Fable', usedPercent: 100, resetsAt: future() + 9, at: Date.now() - 47 * 60_000 }], at: Date.now() },
  };
  fire();
  assert.equal(called('toast').length, 0);
  fx.state.claude.status = full(future() + 7, Date.now());
  fire();
  assert.match(defined(called('toast')[0])[0], /Anthropic API key/);
});
