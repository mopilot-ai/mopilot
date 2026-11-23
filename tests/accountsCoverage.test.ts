// The Codex account pool (electron/identity/codexAccounts.cjs): auth files, usage windows, the main app-server
// plumbing, token refresh, per-chat routing, failover and usage reads. Codex, the relay and the main
// app-server are faked (tests/support/electron-accounts.ts); data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAuth, limitInfo, setup, codex, relayCtl, flush, tmp, jwt, chatgptAuth, sub, NEVER } from './support/electron-accounts.ts';
import { defined } from './support/defined.ts';

const POLL_MS = 60_000;
const defaultAnswer = (m: string) => (m === 'account/read' ? { account: { planType: 'plus' } } : {});

/* ---------- auth files and usage windows ---------- */
test('readAuth reads ChatGPT tokens from either token, an API key, or nothing', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'auth-'));
  const write = (v: any) => fs.writeFileSync(path.join(home, 'auth.json'), typeof v === 'string' ? v : JSON.stringify(v));
  const access = jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-x' },
    'https://api.openai.com/profile': { email: 'p@example.com' },
    exp: 5,
  });
  write({ tokens: { access_token: access } });
  assert.deepEqual(readAuth(home), {
    kind: 'chatgpt',
    accessToken: access,
    chatgptAccountId: 'acc-x',
    email: 'p@example.com',
    planType: null,
    exp: 5,
  });
  write({ tokens: { access_token: 'opaque', account_id: 'own' } });
  assert.deepEqual(readAuth(home), {
    kind: 'chatgpt',
    accessToken: 'opaque',
    chatgptAccountId: 'own',
    email: null,
    planType: null,
    exp: 0,
  });
  write({ tokens: { access_token: 'opaque' } });
  assert.equal(readAuth(home).chatgptAccountId, '');
  write({ OPENAI_API_KEY: 'sk-1' });
  assert.deepEqual(readAuth(home), { kind: 'apiKey', apiKey: 'sk-1' });
  write({});
  assert.equal(readAuth(home), null);
  write('{ nope');
  assert.equal(readAuth(home), null);
  assert.equal(readAuth(path.join(home, 'missing')), null);
});

test('limitInfo: reached when the backend says so or a window is full, lifting at the latest reset', () => {
  assert.equal(limitInfo(null), null);
  const full = limitInfo({ primary: { usedPercent: 50, resetsAt: 100 }, secondary: { usedPercent: 100, resetsAt: 200 } });
  assert.deepEqual([full.used, full.reached, full.resetsAt], [100, true, 200]);
  const told = limitInfo({ rateLimitReachedType: 'primary', primary: { usedPercent: 10, resetsAt: 300 }, secondary: { resetsAt: 50 } });
  assert.deepEqual([told.used, told.reached, told.resetsAt], [10, true, 300]);
  assert.deepEqual({ ...limitInfo({}), at: 0 }, { primary: null, secondary: null, used: null, reached: false, resetsAt: null, at: 0 });
  assert.equal(limitInfo({ rateLimitReachedType: 'x', primary: { usedPercent: 1 } }).resetsAt, null);
});

/* ---------- construction ---------- */
test('a missing accounts file starts with the CLI login only; saved chat pins are sticky', (t) => {
  const fresh = setup(t);
  assert.deepEqual(
    fresh.a.state.accounts.map((x: any) => x.id),
    ['default'],
  );
  assert.equal(fresh.a.pins.size, 0);
  const pinned = setup(t, { state: { chatPins: { t1: 'default' } } });
  assert.equal(pinned.a.pins.get('t1').sticky, true);
  const nulled = setup(t, { state: { chatPins: null } });
  assert.equal(nulled.a.pins.size, 0);
});

test('the main app-server exiting fails its pending requests and forgets what was applied', async (t) => {
  const { a, server } = setup(t, { reply: () => undefined });
  a.mainMode = 'external';
  a.applied = 'default';
  const p = a.mainRequest('account/read', {});
  for (const l of server.listeners) l({ kind: 'stderr' });
  assert.equal(a.mainMode, 'external');
  for (const l of server.listeners) l({ kind: 'exit' });
  await assert.rejects(p, /Codex exited/);
  assert.deepEqual([a.mainMode, a.applied, a.mainPending.size], ['managed', null, 0]);
});

test('a restart on purpose (stopped) forgets what was applied too: the next process gets the account again', async (t) => {
  const { a, server } = setup(t, { reply: () => undefined });
  a.mainMode = 'external';
  a.applied = 'b';
  const p = a.mainRequest('account/read', {});
  for (const l of server.listeners) l({ kind: 'stopped' });
  await assert.rejects(p, /Codex exited/);
  assert.deepEqual([a.mainMode, a.applied, a.mainPending.size], ['managed', null, 0]);
});

test('the poll drops stale automatic pins and reads usage only with several subscriptions', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')], chatPins: { keep: 'b' } }, homes: { b: 'b@example.com' } });
  let reads = 0;
  a.refreshUsage = async () => {
    reads++;
    throw new Error('offline');
  };
  a.pins.set('old', { id: 'b', at: Date.now() - 7 * 3600_000 });
  a.pins.set('new', { id: 'b', at: Date.now() });
  t.mock.timers.tick(POLL_MS);
  await flush();
  assert.deepEqual([...a.pins.keys()].sort(), ['keep', 'new']);
  assert.equal(reads, 1);
  a.state.accounts = a.state.accounts.filter((x: any) => x.id !== 'b');
  t.mock.timers.tick(POLL_MS);
  assert.equal(reads, 1);
});

/* ---------- relay ---------- */
test('the relay is skipped by env or a config with its own endpoint, and dropped if it fails to start', async (t) => {
  const { a, codexHome } = setup(t);
  process.env.SAGE_NO_RELAY = '1';
  try {
    assert.equal(await a.startRelay(), null);
  } finally {
    delete process.env.SAGE_NO_RELAY;
  }
  // no config.toml: relay
  assert.deepEqual(await a.startRelay(), {
    openai_base_url: 'http://127.0.0.1:5555/v1',
    experimental_realtime_webrtc_call_base_url: 'http://127.0.0.1:5555/backend-api/codex',
    experimental_realtime_ws_base_url: 'http://127.0.0.1:5555/v1/live',
  });
  assert.deepEqual([a.view().relay, a.relaySkipped], [true, false]);
  const cfg = path.join(codexHome, 'config.toml');
  fs.writeFileSync(cfg, 'openai_base_url = "https://proxy.example.test/v1"\n');
  assert.deepEqual([await a.startRelay(), a.relaySkipped], [null, true]);
  fs.writeFileSync(cfg, 'model_provider = "azure"\n');
  assert.equal(await a.startRelay(), null);
  // a profile that isn't active doesn't count (tests/harnessRouteReader.test.ts has the active one); openai uses the relay
  fs.writeFileSync(cfg, 'model_provider = "openai"\n[profiles.x]\nopenai_base_url = "https://elsewhere"\n');
  relayCtl.start = async () => {
    throw new Error('EADDRINUSE');
  };
  assert.equal(await a.startRelay(), null);
  assert.equal(a.relay, null);
  assert.equal(relayCtl.made, 2);
});

/* ---------- records ---------- */
test('providerInput: only an active API key with its own endpoint, and only when its key is readable', (t) => {
  const { a, userData } = setup(t, {
    state: {
      active: 'gw',
      accounts: [
        { id: 'gw', kind: 'apiKey', baseUrl: 'https://gw.example.test/v1', status: 'ok' },
        { id: 'plain', kind: 'apiKey', baseUrl: null, status: 'ok' },
      ],
    },
    homes: { gw: 'key:sk-gw' },
  });
  assert.deepEqual(a.providerInput(), { account: 'gw', baseUrl: 'https://gw.example.test/v1', name: 'gw.example.test', key: 'sk-gw' });
  fs.rmSync(path.join(userData, 'accounts', 'gw', 'auth.json.enc'));
  assert.equal(a.providerInput(), null);
  a.state.active = 'plain';
  assert.equal(a.providerInput(), null);
  a.state.active = 'default';
  assert.equal(a.providerInput(), null);
  const none = setup(t, { defaultAuth: 'none' });
  assert.equal(none.a.providerInput(), null);
});

test('the view lists records without a kind as ChatGPT and shows a sign-in in progress', (t) => {
  const { a } = setup(t, { state: { accounts: [{ id: 'b', email: 'b@example.com', status: 'ok' }] } });
  a.login = { authUrl: 'https://auth.example.com/x', targetId: 'b', loginId: 'L' };
  const v = a.view();
  a.login = null;
  assert.deepEqual(v.login, { authUrl: 'https://auth.example.com/x', targetId: 'b' });
  assert.deepEqual(v.accounts[1], {
    id: 'b',
    email: 'b@example.com',
    planType: undefined,
    kind: 'chatgpt',
    baseUrl: null,
    mopilot: false,
    isDefault: false,
    status: 'ok',
    error: null,
    limits: null,
    chats: 0,
  });
  assert.equal(a.subscriptions().length, 2);
});

test('setStatus says once that an account expired', (t) => {
  const { a, notices } = setup(t);
  const d = a.get('default');
  a.setStatus(d, 'ok');
  a.setStatus(d, 'expired', 'gone');
  a.setStatus(d, 'expired', 'gone');
  a.setStatus(d, 'expired', 'again');
  assert.deepEqual(notices(), [{ kind: 'expired', id: 'default', email: 'a@example.com' }]);
  assert.equal(d.error, 'again');
});

test("syncDefault follows the CLI's own login: removed, replaced, or an API key", (t) => {
  const { a, codexHome } = setup(t, {
    state: {
      active: 'default',
      accounts: [
        { id: 'default', kind: 'chatgpt', chatgptAccountId: 'acct-default', email: 'a@example.com', planType: 'pro', limits: { used: 50 } },
        { id: 'mopilot', kind: 'apiKey', mopilot: true },
        sub('b'),
      ],
    },
  });
  // the same login keeps its usage; the plan stays when the token has none
  assert.deepEqual([a.get('default').limits.used, a.get('default').planType], [50, 'plus']);
  chatgptAuth(codexHome, 'other@example.com', 'acct-other', 4e9, '');
  a.syncDefault();
  assert.deepEqual([a.get('default').email, a.get('default').limits, a.get('default').planType], ['other@example.com', null, 'plus']);
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-cli' }));
  a.syncDefault();
  assert.deepEqual([a.get('default').kind, a.get('default').email, a.get('default').status], ['apiKey', null, 'ok']);
  fs.rmSync(path.join(codexHome, 'auth.json'));
  a.syncDefault();
  assert.equal(a.get('default'), null);
  assert.equal(a.state.active, 'b');
  // an unknown active account falls back to the CLI's login when there is one
  chatgptAuth(codexHome, 'a@example.com', 'acct-default');
  a.state.active = 'gone';
  a.syncDefault();
  assert.equal(a.state.active, 'default');
  // nothing left but credits: nothing else is made active
  a.state.accounts = [{ id: 'mopilot', kind: 'apiKey', mopilot: true }];
  fs.rmSync(path.join(codexHome, 'auth.json'));
  a.syncDefault();
  assert.equal(a.state.active, 'default');
});

/* ---------- main app-server plumbing ---------- */
test('main requests: answers, errors, a failed send and a timeout', async (t) => {
  let mode = 'ok';
  const { a, server } = setup(t, {
    reply: () =>
      mode === 'ok'
        ? { result: { n: 1 } }
        : mode === 'err'
          ? { error: { message: 'Denied' } }
          : mode === 'bare'
            ? { error: {} }
            : undefined,
  });
  assert.deepEqual(await a.mainRequest('x/y', {}), { n: 1 });
  mode = 'err';
  await assert.rejects(a.mainRequest('x/y', {}), /Denied/);
  mode = 'bare';
  await assert.rejects(a.mainRequest('x/y', {}), /Request failed/);
  mode = 'none';
  const slow = a.mainRequest('slow/one', {});
  t.mock.timers.tick(30_000);
  await assert.rejects(slow, /slow\/one timed out/);
  const send = server.send;
  server.send = () => {
    throw new Error('not connected');
  };
  await assert.rejects(a.mainRequest('x/y', {}), /not connected/);
  server.send = send;
  assert.equal(a.mainPending.size, 0);
  // a late answer for a request that is gone is still swallowed
  assert.equal(a.onMainMessage({ id: 'accounts:999', result: {} }), true);
  assert.equal(a.onMainMessage({ id: 7, result: {} }), false);
});

test('the main app-server asking for fresh tokens is answered; other traffic passes', async (t) => {
  const { a, sent } = setup(t);
  assert.equal(a.onMainMessage({ id: 3, method: 'account/chatgptAuthTokens/refresh', params: {} }), true);
  await flush();
  assert.equal(sent.find((m) => m.id === 3).result.chatgptAccountId, 'acct-default');
  assert.equal(a.onMainMessage({ method: 'account/chatgptAuthTokens/refresh' }), false);
  assert.equal(a.onMainMessage({ method: 'thread/started', params: { thread: { id: 'kept' } } }), false);
  a.onMainMessage({ method: 'thread/started', params: { thread: { id: 'tmp', ephemeral: true } } });
  a.onMainMessage({ method: 'item/started' });
  assert.deepEqual([...a.ephemeral], ['tmp']);
});

test('a turn that hit the usage limit is handled once, and never for a temporary chat', async (t) => {
  const { a } = setup(t);
  const handled: string[] = [];
  a.onTurnLimit = async (id: string) => {
    handled.push(id);
    throw new Error('ignored');
  };
  const limit = (turn: string, threadId: string) => ({
    method: 'turn/completed',
    params: { threadId, turn: { id: turn, error: { codexErrorInfo: 'usageLimitExceeded' } } },
  });
  a.onMainMessage(limit('u1', 't1'));
  assert.equal(a.onMainMessage(limit('u1', 't1')), false);
  a.ephemeral.add('tmp');
  a.onMainMessage(limit('u2', 'tmp'));
  a.onMainMessage({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u3', error: { codexErrorInfo: 'other' } } } });
  a.onMainMessage({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u4' } } });
  await flush();
  assert.deepEqual(handled, ['t1']);
});

test("a sign-in on the main app-server updates the CLI's login only while it manages its own auth", (t) => {
  const { a, events, codexHome } = setup(t);
  chatgptAuth(codexHome, 'new@example.com', 'acct-new');
  a.mainMode = 'external';
  a.onMainMessage({ method: 'account/updated', params: {} });
  assert.equal(a.get('default').email, 'a@example.com');
  assert.equal(events.length, 0);
  a.mainMode = 'managed';
  a.onMainMessage({ method: 'account/login/completed', params: {} });
  assert.equal(a.get('default').email, 'new@example.com');
  a.onMainMessage({ method: 'account/updated' });
  assert.equal(events.filter((e) => e.type === 'changed').length, 2);
});

/* ---------- apply, tokens and refresh ---------- */
test('with several logins the active one is pushed as external tokens, once', async (t) => {
  const { a, sent } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  await a.apply();
  const login = sent.find((m) => m.method === 'account/login/start');
  assert.deepEqual(
    [login.params.type, login.params.chatgptAccountId, login.params.chatgptPlanType],
    ['chatgptAuthTokens', 'acct-default', 'plus'],
  );
  assert.deepEqual([a.mainMode, a.applied], ['external', 'default']);
  await a.apply();
  assert.equal(sent.filter((m) => m.method === 'account/login/start').length, 1);
  a.get('b').planType = undefined;
  await a.switchTo('b');
  assert.equal(sent.filter((m) => m.method === 'account/login/start').at(-1).params.chatgptPlanType, null);
  // nothing active: nothing to do
  const none = setup(t, { defaultAuth: 'none' });
  assert.equal((await none.a.apply()).active, null);
  assert.equal(none.sent.length, 0);
});

test('a token near expiry is refreshed through the sidecar; a failed refresh marks the account expired', async (t) => {
  const { a, codexHome, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  chatgptAuth(codexHome, 'a@example.com', 'acct-default', Math.floor(Date.now() / 1000) + 60);
  const d = a.get('default');
  d.status = 'error';
  const one = a.tokens(d);
  const two = a.tokens(d);
  const tok = await one;
  assert.equal(await two, tok);
  assert.equal(tok.chatgptAccountId, 'acct-default');
  assert.deepEqual([d.planType, d.status], ['pro', 'ok']);
  assert.equal(defined(codex.procs.at(-1)).home, codexHome);
  // fresh enough: read as it is, unless forced
  const b = a.get('b');
  await a.tokens(b);
  assert.equal(codex.procs.length, 1);
  codex.handle = (m) => (m === 'account/read' ? { account: {} } : {});
  await a.tokens(b, true);
  assert.deepEqual([b.status, b.planType], ['ok', undefined]);
  codex.handle = () => ({});
  await assert.rejects(a.tokens(b, true), /expired/);
  assert.equal(b.status, 'expired');
  assert.deepEqual(
    notices().map((x) => x.kind),
    ['expired'],
  );
  assert.equal(a.refreshing.size, 0);
});

test('a refused token fails over to a healthy login, or tells the app-server to sign in again', async (t) => {
  const { a, sent, notices } = setup(t, { state: { accounts: [sub('b'), sub('c')] }, homes: { b: 'b@example.com', c: 'c@example.com' } });
  // only c can refresh; b's own token is stale too
  chatgptAuth(path.join(a.root, 'b'), 'b@example.com', 'acct-b', 1);
  codex.handle = (m, _p, home) => (m === 'account/read' && !home.endsWith(path.join('accounts', 'c')) ? {} : defaultAnswer(m));
  await a.answerRefresh({ id: 1 });
  assert.equal(a.state.active, 'c');
  assert.equal(sent.find((m) => m.id === 1).result.chatgptAccountId, 'acct-c');
  assert.deepEqual(
    notices().filter((x) => x.kind === 'switched'),
    [{ kind: 'switched', reason: 'expired', from: 'a@example.com', to: 'c@example.com' }],
  );
  // a login without a known plan answers with none
  a.get('c').planType = undefined;
  codex.handle = (m) => (m === 'account/read' ? { account: {} } : {});
  await a.answerRefresh({ id: 5 });
  assert.equal(sent.find((m) => m.id === 5).result.chatgptPlanType, null);
  // nothing can serve
  codex.handle = () => ({});
  await a.answerRefresh({ id: 2 });
  assert.equal(sent.find((m) => m.id === 2).error.code, -32000);
  // no active account: any healthy login takes over, and the notice names no "from"
  const none = setup(t, { defaultAuth: 'none', state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  none.a.active = () => null;
  await none.a.answerRefresh({ id: 4 });
  assert.equal(none.sent.find((m) => m.id === 4).result.chatgptPlanType, null);
  assert.equal(none.notices().at(-1).from, null);
  const lone = setup(t, { defaultAuth: 'none' });
  await lone.a.answerRefresh({ id: 3 });
  assert.match(lone.sent.find((m) => m.id === 3).error.message, /Sign in again/);
});

/* ---------- routing ---------- */
test('pickFor: single logins pass through; tried accounts and auto-switch off stop the search', (t) => {
  const one = setup(t);
  assert.equal(one.a.pickFor('t', new Set()), null);
  assert.equal(one.a.pickFor('t', new Set(['default'])), undefined);
  const { a } = setup(t, { state: { autoSwitch: false, accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  assert.equal(a.pickFor('t', new Set(['default'])), undefined);
});

test('pickFor spreads new chats by load, keeps a healthy pin and moves a pinned chat that ran out', (t) => {
  const { a, notices } = setup(t, {
    state: { accounts: [sub('b', { limits: { used: 10 } }), sub('c', { limits: { used: 20 } })], chatPins: { sticky: 'b' } },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.get('default').limits = { used: 30 };
  // other accounts' pins and old pins don't weigh on b
  a.pins.set('x', { id: 'c', at: Date.now() });
  a.pins.set('y', { id: 'b', at: Date.now() - 3600_000 });
  // b: 10 + 15 (sticky) = 25; c: 20 + 15 = 35; default: 30
  assert.equal(a.pickFor('t1', new Set()).id, 'b');
  assert.equal(a.pins.get('t1').id, 'b');
  // b now 40: default (30) is lighter
  assert.equal(a.pickFor('t2', new Set()).id, 'default');
  const before = a.pins.get('sticky').at;
  assert.equal(a.pickFor('sticky', new Set()).id, 'b');
  assert.ok(a.pins.get('sticky').at >= before);
  a.markLimited(a.get('b'), 9e9);
  const moved = a.pickFor('sticky', new Set());
  assert.notEqual(moved.id, 'b');
  assert.equal(a.state.chatPins.sticky, undefined);
  assert.deepEqual(notices().at(-1), { kind: 'moved', threadId: 'sticky', from: 'b@example.com', to: moved.email, reason: 'limit' });
  // a pin the user didn't make moves without touching chatPins
  a.pins.set('auto', { id: 'b', at: Date.now() });
  assert.notEqual(a.pickFor('auto', new Set()).id, 'b');
  // no thread: the active account if it can serve
  assert.equal(a.pickFor(null, new Set()).id, 'default');
  // nothing healthy: the active account first, then nothing
  for (const x of a.state.accounts) a.markLimited(x, 9e9);
  assert.equal(a.pickFor('t3', new Set()).id, 'default');
  assert.equal(a.pickFor('t3', new Set(['default'])), undefined);
  // with no chatPins record at all
  a.state.chatPins = undefined;
  a.get('c').limits = null;
  a.pins.set('t4', { id: 'b', at: Date.now() });
  assert.equal(a.pickFor('t4', new Set()).id, 'c');
});

test('pickFor ties go to the active account', (t) => {
  const { a } = setup(t, { state: { active: 'b', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  assert.equal(a.pickFor('t1', new Set()).id, 'b');
  a.pins.clear();
  a.state.active = 'default';
  assert.equal(a.pickFor('t2', new Set()).id, 'default');
});

test('in single mode the account taking over becomes the active one', async (t) => {
  const { a, notices } = setup(t, {
    state: { pool: 'single', accounts: [sub('b', { limits: { used: 70 } }), sub('c', { limits: { used: 20 } }), sub('d')] },
    homes: { b: 'b@example.com', c: 'c@example.com', d: 'd@example.com' },
  });
  const switched: string[] = [];
  a.switchTo = async (id: string) => void switched.push(id);
  a.pins.set('t0', { id: 'default', at: Date.now() });
  a.markLimited(a.get('default'), 9e9);
  assert.equal(a.pickFor('t0', new Set()).id, 'd');
  await flush();
  assert.deepEqual(switched, ['d']);
  assert.deepEqual(notices().at(-1), { kind: 'switched', reason: 'limit', from: 'a@example.com', to: 'd@example.com' });
  // the active account itself when it can serve: no switch
  a.state.active = 'c';
  assert.equal(a.pickFor('t1', new Set()).id, 'c');
  assert.equal(switched.length, 1);
  a.switchTo = async () => {
    throw new Error('no');
  };
  a.state.active = 'default';
  assert.equal(a.pickFor('t2', new Set(['d'])).id, 'c');
  await flush();
  // with nothing active, the switch names no "from"
  const none = setup(t, { defaultAuth: 'none', state: { pool: 'single', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  none.a.state.accounts.push(sub('c'));
  none.a.active = () => null;
  none.a.switchTo = async () => {};
  none.a.pickFor('t', new Set());
  await flush();
  assert.equal(none.notices().at(-1).from, null);
});

test('why an account is unavailable, and where a key-pinned chat goes', (t) => {
  const { a, userData } = setup(t, {
    state: { accounts: [sub('b'), { id: 'k', kind: 'apiKey', status: 'ok' }, { id: 'k2', kind: 'apiKey', status: 'expired' }] },
    homes: { b: 'b@example.com', k: 'key:sk-k', k2: 'key:sk-2' },
  });
  assert.equal(a.unavailableReason({ status: 'ok', limits: { reached: true } }), 'limit');
  assert.equal(a.keyRoute(null), null);
  a.pins.set('t-b', { id: 'b', at: 0 });
  a.pins.set('t-k', { id: 'k', at: 0 });
  a.pins.set('t-k2', { id: 'k2', at: 0 });
  a.pins.set('t-gone', { id: 'gone', at: 0 });
  assert.equal(a.keyRoute('t-b'), null);
  assert.equal(a.keyRoute('t-k2'), null);
  assert.equal(a.keyRoute('t-gone'), null);
  assert.deepEqual(a.keyRoute('t-k'), { base: 'https://api.openai.com/v1', key: 'sk-k' });
  fs.writeFileSync(path.join(userData, 'accounts', 'k', 'auth.json'), '{}');
  assert.equal(a.keyRoute('t-k'), null);
});

test('limits: marked by hand or read from response headers; a past reset is not a limit', (t) => {
  const { a } = setup(t);
  const d = a.get('default');
  a.markLimited(d);
  assert.deepEqual([d.limits.reached, d.limits.resetsAt], [true, null]);
  assert.equal(a.limited(d), true);
  d.limits.resetsAt = 1;
  assert.equal(a.limited(d), false);
  a.markLimited(d);
  assert.equal(d.limits.resetsAt, 1);
  a.markLimited(d, 9e9);
  assert.equal(d.limits.resetsAt, 9e9);

  d.limits = null;
  a.noteUsageHeaders(d, { 'x-other': '1' });
  assert.equal(d.limits, null);
  const now = Math.floor(Date.now() / 1000);
  a.noteUsageHeaders(d, {
    'x-codex-primary-used-percent': '40',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': '60',
  });
  assert.equal(d.limits.primary.usedPercent, 40);
  assert.equal(d.limits.primary.windowDurationMins, 300);
  assert.ok(d.limits.primary.resetsAt >= now + 60 && d.limits.primary.resetsAt <= now + 62);
  assert.equal(d.limits.secondary, null);
  a.noteUsageHeaders(d, {
    'x-codex-secondary-used-percent': '100',
    'x-codex-secondary-reset-at': '123',
    'x-codex-secondary-window-minutes': 'abc',
  });
  assert.deepEqual(d.limits.secondary, { usedPercent: 100, windowDurationMins: null, resetsAt: 123 });
  assert.equal(d.limits.primary.usedPercent, 40);
  a.noteUsageHeaders(d, { 'x-codex-primary-used-percent': '', 'x-codex-secondary-used-percent': '5' });
  assert.deepEqual(d.limits.secondary, { usedPercent: 5, windowDurationMins: null, resetsAt: null });
  a.noteUsageHeaders(d, { 'x-codex-primary-used-percent': '8' });
  assert.equal(d.limits.secondary.usedPercent, 5);
  d.limits = undefined;
  a.noteUsageHeaders(d, { 'x-codex-primary-used-percent': '7' });
  assert.equal(d.limits.secondary, null);
  d.limits = undefined;
  a.noteUsageHeaders(d, { 'x-codex-secondary-used-percent': '9' });
  assert.equal(d.limits.primary, null);
});

/* ---------- turn limits and failover ---------- */
test('a limited turn moves its chat and asks to continue, at most three times in ten minutes', async (t) => {
  const { a, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  const switched: string[] = [];
  // the switch succeeds (a failed switch is covered in tests/accountSwitching.test.ts: no move is announced)
  a.switchTo = async (id: string) => {
    switched.push(id);
  };
  a.refreshUsage = async () => {
    throw new Error('offline');
  };
  a.pins.set('t1', { id: 'default', at: Date.now() });
  const continued: string[] = [];
  a.prepareContinue = (t: string) => () => void continued.push(t);
  await a.onTurnLimit('t1');
  assert.equal(a.pins.get('t1').id, 'b');
  assert.deepEqual(switched, ['b']);
  assert.deepEqual(notices().at(-1), { kind: 'resume', threadId: 't1', from: 'a@example.com', to: 'b@example.com' });
  // main continues the chat itself, with or without a window
  assert.deepEqual(continued, ['t1']);
  assert.equal(a.get('default').limits.reached, true);
  // with the relay spreading chats, no switch is needed
  a.relay = {};
  a.get('default').limits = null;
  a.pins.set('t1', { id: 'default', at: Date.now() });
  await a.onTurnLimit('t1');
  assert.equal(switched.length, 1);
  // with the relay but one account at a time, it still switches
  a.state.pool = 'single';
  a.get('default').limits = null;
  a.pins.set('t5', { id: 'b', at: Date.now() });
  await a.onTurnLimit('t5');
  assert.deepEqual(switched, ['b', 'default']);
  a.relay = null;
  // no thread: the active account was serving, and no pin is made
  a.get('default').limits = null;
  a.get('b').limits = null;
  await a.onTurnLimit(undefined);
  assert.equal(notices().at(-1).threadId, undefined);
  a.resumes.set('t1', [Date.now(), Date.now(), Date.now()]);
  const before = notices().length;
  a.get('b').limits = null;
  await a.onTurnLimit('t1');
  assert.equal(notices().length, before);
});

test('a limited turn with nowhere to go says so once per half hour; auto-switch off only marks it', async (t) => {
  const { a, notices } = setup(t);
  await a.onTurnLimit(null);
  await a.onTurnLimit('t2');
  assert.deepEqual(notices(), [{ kind: 'exhausted' }]);
  t.mock.timers.tick(30 * 60_000);
  assert.equal(a.exhaustedNoticeAt, 0);
  a.state.autoSwitch = false;
  a.get('default').limits = null;
  await a.onTurnLimit('t3');
  assert.equal(a.get('default').limits.reached, true);
  assert.equal(notices().length, 1);
  // nothing served it at all
  const none = setup(t, { defaultAuth: 'none' });
  none.a.state.autoSwitch = false;
  await none.a.onTurnLimit('t');
  assert.deepEqual(none.notices(), []);
  // a pinned account that is no longer there: the active one served it
  const pinned = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  pinned.a.state.autoSwitch = false;
  pinned.a.pins.set('t', { id: 'gone', at: Date.now() });
  await pinned.a.onTurnLimit('t');
  assert.equal(pinned.a.get('default').limits.reached, true);
  // a served account with nowhere to go, without an active one
  const lone = setup(t, { defaultAuth: 'none', state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  lone.a.active = () => null;
  lone.a.refreshUsage = async () => {};
  await lone.a.onTurnLimit('t');
  assert.equal(lone.notices().at(-1).from, null);
});

test('pool mode, auto-switch and failover candidates without a current account', (t) => {
  const { a } = setup(t, {
    state: { accounts: [sub('b', { limits: { used: 50 } }), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  assert.equal(a.setPool('single').pool, 'single');
  assert.equal(a.setPool('anything').pool, 'spread');
  assert.equal(a.setAutoSwitch(0).autoSwitch, false);
  assert.deepEqual(
    a.candidates(null).map((x: any) => x.id),
    ['default', 'c', 'b'],
  );
  // a record saved before kinds existed is a ChatGPT login
  a.state.accounts.push({ id: 'old', email: 'old@example.com', status: 'ok', limits: { used: 70 } });
  assert.equal(a.healthy(a.get('old')), true);
  assert.deepEqual(
    a.candidates(a.get('b')).map((x: any) => x.id),
    ['default', 'c', 'old'],
  );
});

test('a record without a kind has its usage read too', async (t) => {
  const { a } = setup(t, {
    state: { accounts: [{ id: 'old', email: 'old@example.com', status: 'ok' }] },
    homes: { old: 'old@example.com' },
  });
  await a.refreshUsage(['old']);
  assert.equal(a.get('old').limits.used, 30);
});

test("without CODEX_HOME the CLI's login is in ~/.codex", (t) => {
  const { a } = setup(t);
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  chatgptAuth(path.join(home, '.codex'), 'home@example.com', 'acct-home');
  const was = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  delete process.env.CODEX_HOME;
  process.env.HOME = home;
  try {
    a.syncDefault();
  } finally {
    process.env.HOME = was.HOME;
    process.env.CODEX_HOME = was.CODEX_HOME;
  }
  assert.equal(a.get('default').email, 'home@example.com');
});

test("usage is read from each account's own sidecar, even for the applied account", async (t) => {
  const { a, sent } = setup(t, {
    state: { accounts: [sub('b'), sub('c'), sub('e', { status: 'expired' }), { id: 'k', kind: 'apiKey', status: 'ok' }] },
    homes: { b: 'b@example.com', c: 'c@example.com', e: 'e@example.com' },
  });
  a.applied = 'default';
  const c = a.get('c');
  c.status = 'error';
  let attempts = 0;
  codex.handle = (m, _p, home) => {
    const isE = home.endsWith(path.join('accounts', 'e'));
    if (m !== 'account/rateLimits/read') return isE ? {} : defaultAnswer(m);
    if (home.endsWith(path.join('accounts', 'b')))
      return attempts++
        ? { rateLimitsByLimitId: { codex: { primary: { usedPercent: 12 } } } }
        : { __error: { message: '401 Unauthorized' } };
    if (isE) return { __error: { message: 'token revoked' } };
    if (!home.includes(`${path.sep}accounts${path.sep}`)) return { rateLimits: { primary: { usedPercent: 5 } } };
    throw new Error('x'.repeat(300));
  };
  const v = await a.refreshUsage();
  assert.ok(
    !sent.some((m) => m.method === 'account/rateLimits/read'),
    'the main app-server is not asked: its cache can hold another account',
  );
  assert.equal(a.get('default').limits.used, 5);
  assert.equal(a.get('b').limits.used, 12);
  assert.equal(attempts, 2);
  assert.equal(c.error.length, 200);
  assert.equal(c.status, 'error');
  assert.equal(a.get('k').limits, undefined);
  assert.equal(v.accounts.length, 5);
  // e's refresh found it expired: that message stays, not the read's own error
  assert.deepEqual([a.get('e').error, a.get('e').status], ['Your sign-in expired. Sign in again to keep using this account.', 'expired']);
  a.usageRefresh.clear('c'); // only the stale ones, only the ids asked for (c waits out its backoff first)
  codex.handle = (m) => (m === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 1 } } } : defaultAnswer(m));
  await a.refreshUsage(['b', 'c'], 60_000);
  assert.equal(a.get('b').limits.used, 12);
  assert.equal(c.limits.used, 1);
  assert.equal(c.status, 'ok');
  // an error with no message
  a.readUsage = async () => {
    throw { message: '' };
  };
  await a.refreshUsage(['c'], 'now');
  assert.equal(c.error, '[object Object]');
});

test('failover switches to the first candidate that takes, else says everything is out', async (t) => {
  const { a, notices } = setup(t, {
    state: { accounts: [sub('b'), sub('c', { limits: { used: 10 } })] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.refreshUsage = async () => {
    throw new Error('offline');
  };
  const tried: string[] = [];
  a.switchTo = async (id: string) => {
    tried.push(id);
    if (id === 'b') throw new Error('nope');
  };
  a.get('b').limits = { used: 1 };
  // a limit is only acted on once the login's own usage confirms it (offline here: the reading stands)
  a.markLimited(a.get('default'), 9e9);
  await a.failover('limit', 't9');
  assert.deepEqual(tried, ['b', 'c']);
  assert.deepEqual(notices(), [{ kind: 'switched', reason: 'limit', from: 'a@example.com', to: 'c@example.com', threadId: 't9' }]);
  await a.failover('expired');
  assert.equal(notices().at(-1).threadId, null);
  a.switchTo = async () => {
    throw new Error('nope');
  };
  await a.failover('limit');
  await a.failover('limit');
  assert.equal(notices().filter((x) => x.kind === 'exhausted').length, 1);
  t.mock.timers.tick(30 * 60_000);
  assert.equal(a.exhaustedNoticeAt, 0);
  a.switching = true;
  await a.failover('limit');
  a.switching = false;
  a.state.autoSwitch = false;
  await a.failover('limit');
  assert.equal(notices().filter((x) => x.kind === 'exhausted').length, 1);
  // one login with nothing to move to says nothing
  const one = setup(t);
  await one.a.failover('limit');
  assert.deepEqual(one.notices(), []);
  // no active account: the move names no "from"
  const none = setup(t, { defaultAuth: 'none', state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  none.a.active = () => null;
  none.a.switchTo = async () => {};
  none.a.refreshUsage = async () => {};
  await none.a.failover('limit');
  assert.equal(none.notices().at(-1).from, null);
});

test('switchTo refuses unknown and expired accounts and rolls back when applying fails', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('x', { status: 'expired' })] }, homes: { b: 'b@example.com' } });
  await assert.rejects(a.switchTo('nope'), /Unknown account/);
  await assert.rejects(a.switchTo('x'), /Sign in to this account again/);
  a.applyNow = async () => {
    throw new Error('app-server down');
  };
  await assert.rejects(a.switchTo('b'), /app-server down/);
  assert.equal(a.state.active, 'default');
});

test('ChatGPT headers for the active login, none for a key or a lapsed login', async (t) => {
  const { a } = setup(t, { state: { accounts: [{ id: 'k', kind: 'apiKey', status: 'ok' }] } });
  const h = await a.chatgptHeaders();
  assert.equal(h['ChatGPT-Account-Id'], 'acct-default');
  assert.match(h.Authorization, /^Bearer h\./);
  a.tokens = async () => ({ accessToken: 'tok' });
  assert.equal((await a.chatgptHeaders())['ChatGPT-Account-Id'], '');
  a.get('default').kind = undefined;
  assert.ok(await a.chatgptHeaders());
  a.tokens = async () => {
    throw new Error('expired');
  };
  assert.equal(await a.chatgptHeaders(), null);
  a.state.active = 'k';
  assert.equal(await a.chatgptHeaders(), null);
  const none = setup(t, { defaultAuth: 'none' });
  assert.equal(await none.a.chatgptHeaders(), null);
});

test('a sidecar request that never answers times out', async (t) => {
  const { a } = setup(t);
  codex.handle = (m) => (m === 'slow' ? NEVER : {});
  const sc = a.sidecar(a.active());
  await sc.ready;
  const p = sc.call('slow', {});
  await flush();
  t.mock.timers.tick(30_000);
  await assert.rejects(p, /slow timed out/);
});
