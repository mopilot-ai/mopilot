// The harness-agnostic account view (examples are made up).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  codexAccounts,
  claudeAccounts,
  claudeKeyForAll,
  accountStatusText,
  planName,
  signInAccountFor,
  claudeSignedOut,
  fastBillingNote,
  rowAccountInfo,
} = await import('../src/harness/accounts.ts');
const { harnessAccountView } = await import('../src/harness/accountView.ts');

const managed = (id: string, email: string, used: number | null, extra: any = {}) => ({
  id,
  email,
  planType: 'prolite',
  kind: 'chatgpt',
  baseUrl: null,
  isDefault: id === 'default',
  status: 'ok',
  error: null,
  limits: used == null ? null : { primary: null, secondary: null, used, reached: false, resetsAt: null, at: 0 },
  chats: 0,
  ...extra,
});
const pool = (accounts: any[], active: string | null) => ({ active, autoSwitch: true, pool: 'spread', relay: true, login: null, accounts });

test('Codex: every pooled account is listed and the active one is picked out', () => {
  const r = codexAccounts({
    accounts: pool([managed('default', 'a@example.com', 10), managed('b', 'b@example.com', 70)], 'b') as any,
    account: null,
    rateLimits: null,
  });
  assert.equal(r.accounts.length, 2);
  assert.equal(r.active?.email, 'b@example.com');
  assert.equal(r.active?.plan, 'Pro Lite');
  assert.equal(r.accounts[0].left, 90);
  assert.equal(r.multi, true);
});

test('Codex: unscoped app-server rate limits cannot override a managed account', () => {
  const rateLimits = { rateLimits: { primary: { usedPercent: 40 }, secondary: { usedPercent: 5 } } };
  const r = codexAccounts({ accounts: pool([managed('default', 'a@example.com', 10)], 'default') as any, account: null, rateLimits });
  assert.equal(r.active?.left, 90);
});

test('Codex without a pool falls back to the app-server login', () => {
  const r = codexAccounts({
    accounts: pool([], null) as any,
    account: { type: 'chatgpt', email: 'solo@example.com', planType: 'plus' },
    rateLimits: null,
  });
  assert.equal(r.active?.email, 'solo@example.com');
  assert.equal(r.active?.plan, 'Plus');
  assert.equal(codexAccounts({ accounts: pool([], null) as any, account: null, rateLimits: null }).active, null);
});

test('Claude Code before its account list loads: the CLI login, with usage from its tightest window', () => {
  const st = {
    state: 'ready',
    bin: '/x',
    version: null,
    plan: 'Claude Max 20×',
    email: 'c@example.com',
    usage: {
      windows: [
        { label: '5h', usedPercent: 59, resetsAt: null },
        { label: 'Weekly', usedPercent: 20, resetsAt: null },
      ],
      at: 0,
    },
  } as any;
  const r = claudeAccounts(st);
  assert.equal(r.active?.id, 'default');
  assert.equal(r.active?.email, 'c@example.com');
  assert.equal(r.active?.left, 41);
  assert.equal(accountStatusText(r.active!).text, '41% left');
});

test('Claude Code: signed out keeps the known account, flagged', () => {
  const r = claudeAccounts({ state: 'signin', bin: '/x', version: null, plan: 'Claude Pro', email: 'c@example.com', usage: null } as any);
  assert.equal(r.active?.status, 'signin');
  assert.equal(accountStatusText(r.active!).tone, 'warn');
  assert.equal(claudeAccounts({ state: 'missing', bin: null, version: null, plan: null, usage: null } as any).accounts.length, 0);
});

const claudeRow = (id: string, email: string, loggedIn = true, sub = 'pro') => ({
  id,
  email,
  subscriptionType: sub,
  organizationType: null,
  rateLimitTier: null,
  loggedIn,
  isDefault: id === 'default',
});

test('Claude Code: several logins, the one in use taking its live status', () => {
  const st = {
    state: 'ready',
    bin: '/x',
    version: null,
    plan: 'Claude Max 20×',
    email: 'b@example.com',
    usage: { windows: [{ label: '5h', usedPercent: 30, resetsAt: null }], at: 0 },
  } as any;
  const pool = {
    active: 'b1',
    autoSwitch: true,
    login: null,
    accounts: [claudeRow('default', 'a@example.com'), claudeRow('b1', 'b@example.com', true, 'max')],
  };
  const usage = { default: { windows: [{ label: '5h', usedPercent: 100, resetsAt: null }], at: 0 } } as any;
  const r = claudeAccounts(st, pool, usage);
  assert.equal(r.multi, true);
  assert.equal(r.accounts.length, 2);
  assert.equal(r.active?.email, 'b@example.com');
  assert.equal(r.active?.plan, 'Claude Max 20×');
  assert.equal(r.active?.left, 70);
  assert.equal(r.accounts[0].plan, 'Claude Pro');
  assert.ok(r.accounts[0].limited);
  assert.equal(accountStatusText(r.accounts[0]).tone, 'warn');
});

test('Claude Code: an added login that lapsed shows as signed out', () => {
  const st = { state: 'ready', bin: '/x', version: null, plan: 'Claude Pro', email: 'a@example.com', usage: null } as any;
  const pool = {
    active: 'default',
    autoSwitch: true,
    login: null,
    accounts: [claudeRow('default', 'a@example.com'), claudeRow('c1', 'c@example.com', false)],
  };
  const r = claudeAccounts(st, pool, {});
  assert.equal(r.accounts[1].status, 'signin');
  assert.equal(r.active?.id, 'default');
});

test('Claude Code: a Console login in use bills per use; the other logins keep their own plan and usage', () => {
  const st = { state: 'apikey', bin: '/x', version: null, plan: 'API key', email: 'k@example.com', usage: null } as any;
  const pool = {
    active: 'k1',
    autoSwitch: true,
    login: null,
    accounts: [{ ...claudeRow('k1', 'k@example.com'), authMethod: 'console' }, claudeRow('m1', 'm@example.com', true, 'max')],
  };
  const usage = { m1: { windows: [{ label: '5h', usedPercent: 25, resetsAt: null }], at: 0 } } as any;
  // the key setting bills each login as itself
  const own = claudeAccounts(st, pool, usage, false);
  assert.deepEqual(
    own.accounts.map((a) => [a.id, a.plan, a.kind, a.left]),
    [
      ['k1', 'API key', 'apiKey', null],
      ['m1', 'Claude Max', 'subscription', 75],
    ],
  );
  // a key (or credits, or a cloud route) bills every login; unknown yet: as the status says
  for (const all of [true, null]) {
    const keyed = claudeAccounts(st, pool, usage, all);
    assert.deepEqual(
      keyed.accounts.map((a) => [a.id, a.plan, a.kind, a.left]),
      [
        ['k1', 'API key', 'apiKey', null],
        ['m1', 'API key', 'apiKey', null],
      ],
      String(all),
    );
  }
  // the login in use says who the key bills; the others are keyed alike
  const cloud = claudeAccounts({ ...st, plan: 'API key · your cloud account' }, pool, usage, true);
  assert.deepEqual(
    cloud.accounts.map((a) => a.plan),
    ['API key · your cloud account', 'API key'],
  );
  // signed in on a subscription while the key bills all: the label is the key's, not the status's plan
  assert.equal(claudeAccounts({ ...st, state: 'ready', plan: 'Claude Max' }, pool, usage, true).active?.plan, 'API key');
});

test('the Claude key setting bills every login with a key, credits or a cloud route', () => {
  const k = (mode: string, cloudEnv = false, cloudDetected = false) => ({ mode, cloudEnv, cloudDetected });
  assert.equal(claudeKeyForAll(null), null);
  assert.equal(claudeKeyForAll(k('subscription')), false);
  assert.equal(claudeKeyForAll(k('subscription', true, false)), false, 'opted in, but the shell has no cloud provider');
  assert.equal(claudeKeyForAll(k('subscription', true, true)), true);
  assert.equal(claudeKeyForAll(k('apiKey')), true);
  assert.equal(claudeKeyForAll(k('mopilot')), true);
});

test('plan names', () => {
  assert.equal(planName('prolite'), 'Pro Lite');
  assert.equal(planName('team'), 'Team');
});

// WP3-10: one UsageSnapshot per account; MoPilot shows its balance; no reading reads "unknown"
test('usage snapshots: account-scoped Codex windows, parsed Claude text, none for a key', () => {
  const rateLimits = { rateLimits: { primary: { usedPercent: 40 }, secondary: { usedPercent: 5 } } };
  const r = codexAccounts({
    accounts: pool([managed('default', 'a@example.com', 10), managed('b1', 'b@example.com', 30)], 'default') as any,
    account: null,
    rateLimits,
  });
  assert.equal(r.accounts[0].usage.source, 'polled');
  assert.equal(r.accounts[0].usage.windows[0].usedPercent, 10);
  assert.equal(r.accounts[1].usage.source, 'polled');
  const st = {
    state: 'ready',
    bin: '/x',
    version: null,
    plan: 'Claude Max',
    email: 'c@example.com',
    usage: { windows: [{ label: '5h', usedPercent: 59, resetsAt: null }], at: 123 },
  } as any;
  assert.deepEqual(claudeAccounts(st).active?.usage, { windows: st.usage.windows, source: 'parsed', at: 123 });
  const key = codexAccounts({ accounts: pool([], null) as any, account: { type: 'apiKey' }, rateLimits: null });
  assert.equal(key.active?.usage.source, 'none');
});

test('a Codex account carries each window of its reading, so menus can name the one running out', () => {
  const limits = {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 50 },
    secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: null },
    used: 88,
    reached: false,
    resetsAt: null,
    at: 7,
  };
  const r = codexAccounts({ accounts: pool([managed('a', 'a@example.com', 88, { limits })], 'a') as any, account: null, rateLimits: null });
  assert.deepEqual(r.active?.usage, {
    windows: [
      { label: '5h', usedPercent: 20, resetsAt: 50 },
      { label: 'Weekly', usedPercent: 88, resetsAt: null },
    ],
    source: 'polled',
    at: 7,
  });
  assert.equal(r.active?.left, 12);
  // a reading with no windows keeps how much is used overall
  const bare = codexAccounts({ accounts: pool([managed('b', 'b@example.com', 30)], 'b') as any, account: null, rateLimits: null });
  assert.deepEqual(bare.active?.usage.windows, [{ label: 'Usage', usedPercent: 30, resetsAt: null }]);
});

test('no reading is "unknown", never blank', () => {
  const r = codexAccounts({
    accounts: pool([managed('default', 'a@example.com', null)], 'default') as any,
    account: null,
    rateLimits: null,
  });
  assert.equal(r.active?.usage.source, 'none');
  assert.deepEqual(accountStatusText(r.active!), { text: 'Usage unknown', tone: 'muted' });
});

test('MoPilot credits show the balance, or that it is unknown', () => {
  const mp = managed('mopilot', 'm@example.com', null, { kind: 'apiKey', mopilot: true, planType: null });
  const state = pool([managed('default', 'a@example.com', 10), mp], 'mopilot') as any;
  const r = codexAccounts({ accounts: state, account: null, rateLimits: null, balanceMicros: 12_400_000 });
  assert.equal(r.active?.usage.balanceMicros, 12_400_000);
  assert.equal(r.active?.left, null);
  assert.deepEqual(accountStatusText(r.active!), { text: '$12.40 left', tone: 'ok' });
  assert.equal(accountStatusText(codexAccounts({ accounts: state, account: null, rateLimits: null }).active!).text, 'Balance unknown');
});

test("the account view's switcher excludes credits while retaining subscriptions, keys and expired accounts", () => {
  const entries = [
    managed('default', 'a@example.com', 10),
    managed('expired', 'b@example.com', null, { status: 'expired' }),
    managed('key', null as any, null, { kind: 'apiKey' }),
    managed('mopilot', null as any, null, { kind: 'apiKey', mopilot: true }),
  ];
  const view = codexAccounts({ accounts: pool(entries, 'mopilot') as any, account: null, rateLimits: null });
  const v = harnessAccountView({ state: 'apikey', usage: null } as any, view);
  assert.deepEqual(
    v.accounts.map((r) => r.account.id),
    ['default', 'expired', 'key'],
  );
  assert.equal(v.active?.name, 'MoPilot credits');
  assert.equal(view.active?.id, 'mopilot');
  assert.equal(v.all.length, 4);
  const creditsOnly = codexAccounts({ accounts: pool([entries[3]], 'mopilot') as any, account: null, rateLimits: null });
  assert.deepEqual(harnessAccountView({ state: 'apikey', usage: null } as any, creditsOnly).accounts, []);
});

test('the account view names the account in use and keeps each plan whole', () => {
  const ready = { state: 'ready', usage: null } as any;
  const codex = codexAccounts({
    accounts: pool([managed('default', 'a@example.com', 10)], 'default') as any,
    account: null,
    rateLimits: null,
  });
  assert.equal(harnessAccountView(ready, codex).active?.name, 'a@example.com');
  assert.equal(harnessAccountView(ready, codex).accounts[0].plan, 'Pro Lite');
  const st = { state: 'ready', email: 'c@example.com', plan: 'Claude Max 20×', usage: null } as any;
  const claude = claudeAccounts(st);
  assert.equal(harnessAccountView(st, claude).active?.name, 'c@example.com');
  assert.equal(harnessAccountView(st, claude).accounts[0].plan, 'Claude Max 20×');
  assert.equal(harnessAccountView(ready, { ...codex, active: null, accounts: [] }).active, null);
});

test("the picker's usage is the chat account's own short status and never borrows another account quota", () => {
  const st = { state: 'ready', usage: { windows: [{ label: 'Weekly', usedPercent: 20 }], at: 1 } } as any;
  const view = codexAccounts({
    accounts: pool(
      [
        managed('default', 'a@example.com', 20),
        managed('other', 'b@example.com', 63),
        managed('unknown', 'c@example.com', null),
        managed('mopilot', null as any, null, { kind: 'apiKey', mopilot: true }),
      ],
      'default',
    ) as any,
    account: null,
    rateLimits: null,
  });
  const v = harnessAccountView(st, view);
  const short = (id: string) => v.all.find((r) => r.account.id === id)?.short;
  assert.equal(short('default'), '80% left');
  assert.equal(short('other'), '37% left');
  assert.equal(short('unknown'), null);
  // MoPilot credits say their balance; it is not known here
  assert.equal(short('mopilot'), 'Balance unknown');
  assert.deepEqual(
    v.accounts.map((r) => r.account.id),
    ['default', 'other', 'unknown'],
  );
});

test("sign in again for a chat's own Claude login, not the one new chats use (D-43)", () => {
  const poolOf = { active: 'a', accounts: [{ id: 'default' }, { id: 'a' }, { id: 'b' }] };
  const chats = { c1: { id: 'b' }, c2: { id: 'gone' }, c3: { id: 'default' } };
  assert.equal(signInAccountFor(chats, poolOf, 'c1'), 'b');
  assert.equal(signInAccountFor(chats, poolOf, 'c3'), 'default');
  // a login that was removed, or a chat with none of its own, uses the one in use
  assert.equal(signInAccountFor(chats, poolOf, 'c2'), 'a');
  assert.equal(signInAccountFor(chats, poolOf, 'c9'), 'a');
});

test('Fast carries a billing note on a Codex API key only (D-57)', () => {
  assert.match(fastBillingNote('codex', { kind: 'apiKey' })!, /priority rate/);
  assert.equal(fastBillingNote('codex', { kind: 'subscription' }), null);
  assert.equal(fastBillingNote('codex', null), null);
  assert.equal(fastBillingNote('claude', { kind: 'apiKey' }), null);
});

test("the signed-out banner follows the chat's own login and offers the logins still signed in (D-43)", () => {
  const acct = (id: string, loggedIn: boolean) => ({ id, email: `${id}@x.test`, loggedIn });
  const poolOf = { active: 'default', accounts: [acct('default', true), acct('b', false), acct('c', true)] };
  const ok = { state: 'ready', email: 'default@x.test' };
  // a chat on a lapsed login that is not the one in use: the banner names that login
  const r = claudeSignedOut(ok, poolOf, { c1: { id: 'b' } }, 'c1');
  assert.deepEqual(r, {
    login: 'b',
    email: 'b@x.test',
    others: [
      { id: 'default', email: 'default@x.test' },
      { id: 'c', email: 'c@x.test' },
    ],
  });
  // a chat on a healthy login shows nothing, even when the login in use is signed out
  assert.equal(claudeSignedOut({ state: 'signin', email: 'default@x.test' }, poolOf, { c1: { id: 'c' } }, 'c1'), null);
  // the login in use, outside a chat, only once it has been signed in before
  const never = { active: 'default', accounts: [{ id: 'default', email: null, loggedIn: false }] };
  assert.equal(claudeSignedOut({ state: 'signin' }, never, {}, null), null);
  assert.equal(claudeSignedOut({ state: 'signin', email: 'e@x.test' }, poolOf, {}, null)?.login, 'default');
  assert.equal(claudeSignedOut({ state: 'signin' }, poolOf, {}, 'c9')?.login, 'default');
});

// D-65: the model picker's harness row shows the chat's own account, plan and usage included
test("the picker row reads the chat's own account, not the one new chats use", () => {
  const st = {
    state: 'ready',
    bin: '/x',
    version: null,
    plan: 'Claude Max',
    email: 'a@example.com',
    usage: { windows: [{ label: '5h', usedPercent: 59, resetsAt: null }], at: 1 },
  } as any;
  const mk = (id: string, plan: string, used: number | null) =>
    ({
      id,
      plan,
      usage: { windows: used == null ? [] : [{ label: '5h', usedPercent: used, resetsAt: null }], at: 7, source: 'parsed' },
    }) as any;
  const def = mk('default', 'Claude Max', 59);
  assert.deepEqual(rowAccountInfo(st, def, def), { plan: 'Claude Max', usage: st.usage });
  assert.deepEqual(rowAccountInfo(st, def, null), { plan: 'Claude Max', usage: st.usage });
  const other = mk('b', 'Claude Pro', 12);
  assert.deepEqual(rowAccountInfo(st, def, other), { plan: 'Claude Pro', usage: { windows: other.usage.windows, at: 7 } });
  assert.equal(rowAccountInfo(st, def, mk('c', 'Claude Pro', null)).usage, null);
});

// Claude usage retrieval exposes states and keeps cached readings tied to their account.
test('Claude usage distinguishes unloaded, loading, unavailable and failed readings', () => {
  const st = { state: 'ready', bin: '/x', version: null, plan: 'Claude Pro', usage: null } as any;
  assert.equal(accountStatusText(claudeAccounts(st).active!).text, 'Usage not loaded');
  for (const [fetchState, expected] of [
    ['loading', 'Fetching usage…'],
    ['unavailable', 'Usage unavailable'],
    ['error', 'Usage refresh failed'],
  ] as const) {
    const usage = { windows: [], at: 0, fetchState, fetchError: 'Reason from CLI' };
    const a = claudeAccounts({ ...st, usage }).active!;
    assert.deepEqual(accountStatusText(a), { text: expected, tone: 'muted' });
    assert.equal(a.usage.fetchError, 'Reason from CLI');
  }
});

test('Claude failed refresh keeps the last percentage and labels it as an older reading', () => {
  const now = Date.now();
  const usage = {
    windows: [{ label: '5h', usedPercent: 35, resetsAt: null }],
    at: now - 5 * 60_000,
    fetchState: 'error',
    fetchError: 'Network unavailable',
  };
  const a = claudeAccounts({ state: 'ready', bin: '/x', version: null, plan: 'Claude Pro', usage } as any).active!;
  assert.equal(a.left, 65);
  assert.equal(a.usage.at, usage.at);
  assert.equal(accountStatusText(a).tone, 'muted');
  assert.match(accountStatusText(a).text, /^65% left · updated 5m ago$/);
});

test("a Claude limit read from an old cached answer says how old it is; a fresh one doesn't", () => {
  const now = Date.now();
  const st = (at: number) =>
    ({
      state: 'ready',
      bin: '/x',
      version: null,
      plan: 'Claude Max',
      usage: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: null }], at, fetchState: 'success' },
    }) as any;
  const old = claudeAccounts(st(now - 47 * 60_000)).active!;
  assert.deepEqual(accountStatusText(old), { text: 'Limit reached · updated 47m ago', tone: 'warn' });
  const fresh = claudeAccounts(st(now)).active!;
  assert.deepEqual(accountStatusText(fresh), { text: 'Limit reached', tone: 'warn' });
});

test('Claude account cache wins over another account remaining in harness status', () => {
  const reading = (usedPercent: number) => ({ windows: [{ label: '5h', usedPercent, resetsAt: null }], at: Date.now() });
  const st = { state: 'ready', bin: '/x', version: null, plan: 'Claude Pro', usage: reading(90) } as any;
  const pool = {
    active: 'b',
    autoSwitch: true,
    login: null,
    accounts: [claudeRow('default', 'a@example.com'), claudeRow('b', 'b@example.com')],
  };
  const usage = { default: reading(90), b: reading(20) };
  const result = claudeAccounts(st, pool, usage);
  assert.equal(result.active?.left, 80);
  assert.equal(result.accounts[0].left, 10);
  const switched = claudeAccounts(st, { ...pool, active: 'default' }, usage);
  assert.equal(switched.active?.left, 10);
  assert.equal(switched.accounts[1].left, 80);
});

test('an empty cache for the selected account cannot fall back to another account percentage', () => {
  const st = {
    state: 'ready',
    bin: '/x',
    version: null,
    plan: 'Claude Pro',
    usage: { windows: [{ label: '5h', usedPercent: 90, resetsAt: null }], at: Date.now() },
  } as any;
  const pool = {
    active: 'b',
    autoSwitch: true,
    login: null,
    accounts: [claudeRow('default', 'a@example.com'), claudeRow('b', 'b@example.com')],
  };
  const result = claudeAccounts(st, pool, { b: { windows: [], at: 0, fetchState: 'loading' } });
  assert.equal(result.active?.left, null);
  assert.equal(accountStatusText(result.active!).text, 'Fetching usage…');
});
