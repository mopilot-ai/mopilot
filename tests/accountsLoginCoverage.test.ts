// The Codex account pool (electron/identity/codexAccounts.cjs), part two: the sidecar app-server protocol, browser
// sign-in (add and re-verify), removal, API keys, MoPilot credits, mode switching and chat pins.
// Codex, the relay, the main app-server and fetch are faked; data is made up.
import { test } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, codex, relayCtl, flush, chatgptAuth, keyHome, sub, sealedAuth, sealedAfterSidecar } from './support/electron-accounts.ts';
import { defined } from './support/defined.ts';

test('account provider methods use the public manager prototype and one shared state owner', async (t) => {
  const require = createRequire(import.meta.url);
  const { Accounts } = require('../electron/identity/codexAccounts.cjs');
  const { AccountProviders } = require('../electron/identity/accounts/providers.cjs');
  const { a } = setup(t);
  assert.equal(a instanceof Accounts, true);
  for (const name of ['apiBase', 'addApiKey', 'setMoPilotKey', 'setMode']) {
    assert.equal(a[name], AccountProviders.prototype[name]);
    assert.equal(Accounts.prototype[name], AccountProviders.prototype[name]);
  }
});

const staging = () => codex.procs.at(-1)!.home;
const complete = (params: object) => codex.procs.at(-1)!.send({ method: 'account/login/completed', params });

/* ---------- sidecar ---------- */
test('a sidecar answers requests, refuses server requests and passes notifications on', async (t) => {
  const { a } = setup(t);
  codex.handle = (m) => (m === 'bad' ? { __error: { message: 'Nope' } } : m === 'bare' ? { __error: {} } : { ok: m });
  const sc = a.sidecar(a.active());
  assert.equal(a.sidecar(a.active()), sc);
  const proc = codex.procs[0];
  assert.deepEqual(await sc.call('x/y', {}), { ok: 'x/y' });
  assert.deepEqual(
    proc.written.slice(0, 2).map((m: any) => m.method),
    ['initialize', 'initialized'],
  );
  await assert.rejects(sc.call('bad', {}), /Nope/);
  await assert.rejects(sc.call('bare', {}), /Request failed/);
  const got: any[] = [];
  sc.notify.add((m: string, p: any) => got.push([m, p]));
  proc.stdout.emit('data', 'not json\nnull\n[]\n1\ntrue\n"text"\n{"method":"x/changed","par');
  proc.stdout.emit('data', 'ams":{"a":1}}\n');
  assert.deepEqual(got, [['x/changed', { a: 1 }]]);
  proc.send({ id: 99, method: 'item/approve' });
  assert.deepEqual(proc.written.at(-1), { id: 99, error: { code: -32601, message: 'Not supported' } });
  // an answer nobody waits for is dropped
  proc.send({ id: 12345, result: {} });
  // an error event from a running process isn't the end
  proc.emit('error', new Error('EPIPE'));
  assert.ok(sc.proc);
  await sc.close();
  assert.equal(proc.killed, true);
  assert.equal(sc.proc, null);
  await sc.close();
  await assert.rejects(sc.request('x/y'), /Codex exited/);
  // the next use starts a new one
  assert.notEqual(a.sidecar(a.active()), sc);
});

test('a failed sidecar spawn ends startup and a late error cannot remove its replacement', async (t) => {
  const { a } = setup(t);
  codex.spawnFail = true;
  const failed = a.sidecar(a.active());
  const proc = codex.procs.at(-1)!;
  await assert.rejects(failed.call('account/read', {}), /Codex exited/);
  assert.equal(failed.proc, null);
  assert.equal(a.sidecars.size, 0);

  codex.spawnFail = false;
  const replacement = a.sidecar(a.active());
  await replacement.ready;
  proc.emit('error', new Error('late spawn error'));
  assert.equal(a.sidecar(a.active()), replacement);
  assert.ok(replacement.proc);
});

test('an idle sidecar closes itself; one kept alive does not', async (t) => {
  const { a } = setup(t);
  const sc = a.sidecar(a.active());
  await sc.ready;
  t.mock.timers.tick(45_000);
  assert.equal(codex.procs[0].killed, true);
  await flush();
  const kept = a.sidecar(a.active());
  kept.keepAlive = true;
  kept.touch();
  t.mock.timers.tick(45_000);
  assert.equal(codex.procs[1].killed, false);
});

/* ---------- sign-in ---------- */
test('signing in adds the account in its own folder and opens the browser', async (t) => {
  const { a, opened, notices, userData } = setup(t);
  codex.handle = (m) =>
    m === 'account/login/start'
      ? { loginId: 'L1', authUrl: 'https://auth.example.com/go' }
      : m === 'account/read'
        ? { account: { email: 'N@example.com', planType: 'pro' } }
        : {};
  const v = await a.startLogin();
  assert.deepEqual(opened, ['https://auth.example.com/go']);
  assert.deepEqual(v.login, { authUrl: 'https://auth.example.com/go', targetId: null });
  const dir = staging();
  assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
  chatgptAuth(dir, 'n@example.com', 'acct-n');
  complete({ success: true });
  await flush(12);
  const added = a.state.accounts.find((x: any) => x.chatgptAccountId === 'acct-n');
  assert.deepEqual([added.email, added.planType, added.status], ['N@example.com', 'pro', 'ok']);
  assert.equal((await sealedAfterSidecar(a, path.join(userData, 'accounts', added.id))).tokens.account_id, 'acct-n');
  assert.ok(!fs.existsSync(dir));
  assert.equal(a.state.active, 'default');
  assert.deepEqual(
    notices().find((x) => x.kind === 'signedIn'),
    { kind: 'signedIn', email: 'N@example.com', added: true, mismatch: null },
  );
  assert.equal(a.login, null);
});

test('signing in again re-verifies a known account in place and says when it was another one', async (t) => {
  const { a, notices, userData, sent } = setup(t, {
    state: { accounts: [sub('b', { status: 'expired' }), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.applied = 'b';
  a.mainMode = 'external';
  codex.handle = (m) =>
    m === 'account/read'
      ? { __error: { message: 'offline' } }
      : m === 'account/login/start'
        ? { loginId: 'L', authUrl: 'https://auth.example.com/x' }
        : {};
  await a.startLogin('c');
  chatgptAuth(staging(), 'B@example.com', 'acct-b', 4e9, 'team');
  complete({ success: true });
  await flush(12);
  const b = a.get('b');
  assert.deepEqual([b.status, b.email, b.planType], ['ok', 'B@example.com', 'team']);
  // the app-server held b's old token: the active login is pushed again
  assert.ok(sent.some((m) => m.method === 'account/login/start' && m.params.type === 'chatgptAuthTokens'));
  assert.equal(a.applied, 'default');
  assert.equal((await sealedAfterSidecar(a, path.join(userData, 'accounts', 'b'))).tokens.account_id, 'acct-b');
  assert.equal(a.state.accounts.length, 3);
  assert.deepEqual(notices().at(-1), { kind: 'signedIn', email: 'B@example.com', added: false, mismatch: 'c@example.com' });
  // re-verifying the account asked for, while it is not the one applied
  a.applied = 'default';
  await a.startLogin('b');
  chatgptAuth(staging(), 'b@example.com', 'acct-b');
  complete({ success: true });
  await flush(12);
  assert.deepEqual(notices().at(-1), { kind: 'signedIn', email: 'b@example.com', added: false, mismatch: null });
  assert.equal(a.applied, 'default');
});

test('a new login becomes active when the current one expired, is the one, or there is none', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  a.get('default').status = 'expired';
  await a.startLogin();
  chatgptAuth(staging(), 'n@example.com', 'acct-n');
  complete({ success: true });
  await flush(12);
  assert.equal(a.active().email, 'side@example.com');
  // the active account re-verified stays active
  await a.startLogin();
  chatgptAuth(staging(), 'side@example.com', 'acct-n');
  complete({ success: true });
  await flush(12);
  assert.equal(a.active().chatgptAccountId, 'acct-n');
  const none = setup(t, { defaultAuth: 'none' });
  await none.a.startLogin();
  chatgptAuth(staging(), 'z@example.com', 'acct-z');
  complete({ success: true });
  await flush(12);
  assert.equal(none.a.active().chatgptAccountId, 'acct-z');
  // an account without an email matches one without an email
  const blank = setup(t, { state: { accounts: [sub('q', { email: null, chatgptAccountId: 'acct-q' })] } });
  codex.handle = (m) => (m === 'account/read' ? { account: {} } : m === 'account/login/start' ? { loginId: 'L', authUrl: 'u' } : {});
  await blank.a.startLogin();
  fs.writeFileSync(path.join(staging(), 'auth.json'), JSON.stringify({ tokens: { access_token: 'opaque', account_id: 'acct-q' } }));
  complete({ success: true });
  await flush(12);
  assert.equal(blank.a.state.accounts.filter((x: any) => x.chatgptAccountId === 'acct-q').length, 1);
});

test('a failed or cancelled sign-in cleans up and says why, unless the user cancelled', async (t) => {
  const { a, notices } = setup(t);
  for (const [params, expected] of [
    [{ success: false, error: 'Login cancelled by user' }, undefined],
    [{ success: false, error: 'Port closed' }, 'Port closed'],
    [{ success: false }, 'Sign in failed'],
    [{ success: true }, 'Sign in did not return ChatGPT credentials'],
  ] as const) {
    const before = notices().length;
    await a.startLogin();
    const dir = staging();
    complete(params);
    await flush(12);
    assert.ok(!fs.existsSync(dir));
    assert.equal(a.login, null);
    assert.deepEqual(
      notices()
        .slice(before)
        .map((x) => x.error),
      expected ? [expected] : [],
    );
  }
});

test('a sign-in that cannot be installed is reported; other sidecar traffic is ignored', async (t) => {
  const { a, notices, userData } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  codex.handle = (m) =>
    m === 'account/read' ? { __error: { message: 'offline' } } : m === 'account/login/start' ? { loginId: 'L', authUrl: 'u' } : {};
  await a.startLogin();
  codex.procs.at(-1)!.send({ method: 'account/updated', params: {} });
  fs.rmSync(path.join(userData, 'accounts', 'b'), { recursive: true });
  chatgptAuth(staging(), 'b@example.com', 'acct-b');
  complete({ success: true });
  await flush(12);
  assert.equal(notices().at(-1).kind, 'loginFailed');
  assert.match(notices().at(-1).error, /ENOENT/);
  // an error that isn't an Error
  await a.startLogin();
  a.finishLogin = async () => {
    throw 'plain';
  };
  complete({ success: true });
  await flush();
  assert.deepEqual(notices().at(-1), { kind: 'loginFailed', error: 'plain' });
  // a completion for a login that is no longer current
  a.login = null;
  complete({ success: true });
  await flush();
  assert.equal(notices().at(-1).error, 'plain');
});

test('starting a sign-in cancels the one in progress; an unfinished one is dropped after 15 minutes', async (t) => {
  const { a, events } = setup(t);
  await a.startLogin();
  const first = staging();
  const firstProc = codex.procs.at(-1)!;
  await a.startLogin();
  assert.ok(firstProc.written.some((m: any) => m.method === 'account/login/cancel' && m.params.loginId === 'L1'));
  assert.ok(!fs.existsSync(first));
  const second = staging();
  t.mock.timers.tick(15 * 60_000);
  await flush(12);
  assert.equal(a.login, null);
  assert.ok(!fs.existsSync(second));
  assert.equal((await a.cancelLogin()).login, null);
  assert.ok(events.length > 0);
});

test('a sign-in that cannot start says why and leaves nothing behind', async (t) => {
  const { a, userData } = setup(t);
  codex.handle = (m) =>
    m === 'account/login/start' ? { __error: { message: 'listen EADDRINUSE: address already in use 127.0.0.1:1455' } } : {};
  await assert.rejects(a.startLogin(), /Another sign-in is already in progress/);
  codex.handle = (m) => (m === 'account/login/start' ? { __error: { message: 'Bad request' } } : {});
  await assert.rejects(a.startLogin(), /^Error: Bad request$/);
  codex.handle = (m) => (m === 'account/login/start' ? { __error: { message: '' } } : {});
  await assert.rejects(a.startLogin(), /Request failed/);
  assert.deepEqual(fs.readdirSync(path.join(userData, 'accounts')), []);
});

/* ---------- removal ---------- */
test('removing the active login moves to the healthiest other one and signs the removed one out', async (t) => {
  const { a, userData } = setup(t, {
    state: {
      active: 'b',
      accounts: [sub('b'), sub('c', { limits: { used: 90 } }), sub('d', { limits: { used: 10 } })],
      chatPins: { t1: 'b', t2: 'c' },
    },
    homes: { b: 'b@example.com', c: 'c@example.com', d: 'd@example.com' },
  });
  a.mainRequest = async () => ({});
  const sc = a.sidecar(a.get('b'));
  // a chat routed to it without being put there
  a.pins.set('t3', { id: 'b', at: Date.now() });
  const v = await a.remove('b');
  assert.equal(v.active, 'default');
  assert.deepEqual(a.state.chatPins, { t2: 'c' });
  // nothing is listed on the removed account any more
  assert.deepEqual(v.chatAccounts, { t2: { id: 'c', pinned: true } });
  assert.ok(codex.procs.some((p) => p.home === sc.home && p.written.some((m: any) => m.method === 'account/logout')));
  assert.equal(sc.proc, null);
  assert.ok(!fs.existsSync(path.join(userData, 'accounts', 'b')));
  assert.deepEqual((await a.remove('nope')).accounts.length, 3);
  a.state.chatPins = null;
  await a.remove('c');
  assert.equal(a.state.chatPins, null);
});

test("removing the CLI's login deletes its auth.json; the last account logs the app-server out", async (t) => {
  const { a, codexHome, sent } = setup(t, {
    state: { accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
    extra: {
      forgetProvider: async () => {
        throw new Error('ignored');
      },
    },
  });
  await a.remove('default');
  assert.ok(!fs.existsSync(path.join(codexHome, 'auth.json')));
  assert.equal(a.state.active, 'b');
  a.mainMode = 'external';
  await a.remove('b');
  assert.ok(sent.some((m) => m.method === 'account/logout'));
  assert.deepEqual([a.mainMode, a.applied, a.state.active, a.state.accounts.length], ['managed', null, 'default', 0]);
});

test('removing the active account falls back to a working subscription only, never a key or credits', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: {
      active: 'b',
      accounts: [
        sub('b'),
        { id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' },
        { id: 'k', kind: 'apiKey', status: 'ok' },
        sub('x', { status: 'expired' }),
      ],
    },
    homes: { b: 'b@example.com', k: 'key:sk-k' },
  });
  a.mainRequest = async () => ({});
  await a.remove('b');
  // a key, credits and a lapsed login are left: the lapsed subscription, which asks to sign in again
  assert.equal(a.state.active, 'x');
  await a.remove('x');
  // only pay-per-use is left: nothing is taken up on its own (paying per use asks first)
  assert.equal(a.state.active, null);
  assert.equal(a.active(), null);
});

test('removing a login when the active one is gone picks one that is not credits', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'gone', accounts: [{ id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' }, sub('b'), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.state.active = 'gone';
  await a.remove('c');
  assert.equal(a.state.active, 'b');
});

/* ---------- API keys ---------- */
test('adding an API key checks it, stores it in its own home and switches to it', async (t) => {
  const { a, userData } = setup(t);
  a.mainRequest = async () => ({});
  const calls: any[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, init: any) => {
    calls.push([url, init.headers.Authorization]);
    if (status === 0) throw new Error('offline');
    return { status };
  });
  await assert.rejects(a.addApiKey('   '), /Enter an API key/);
  await assert.rejects(a.addApiKey('sk a'), /doesn’t look like an API key/);
  await assert.rejects(a.addApiKey('sk-1', 'not a url'), /isn’t a valid URL/);
  await assert.rejects(a.addApiKey('sk-1', 'ftp://host/v1'), /isn’t a valid URL/);
  status = 401;
  await assert.rejects(a.addApiKey('sk-1'), /rejected that API key/);
  assert.deepEqual(calls, [['https://api.openai.com/v1/models', 'Bearer sk-1']]);
  status = 0;
  const v = await a.addApiKey(' sk-1 ', 'https://gw.example.test/v1//');
  assert.equal(defined(calls.at(-1))[0], 'https://gw.example.test/v1/models');
  const k = a.state.accounts.find((x: any) => x.kind === 'apiKey');
  assert.deepEqual([v.active, k.baseUrl], [k.id, 'https://gw.example.test/v1']);
  assert.equal(sealedAuth(path.join(userData, 'accounts', k.id)).OPENAI_API_KEY, 'sk-1');
  assert.equal(a.apiBase(), 'https://gw.example.test/v1');
  assert.equal(a.state.lastSubscription, 'default');
  // the same key and endpoint again: no second row
  status = 200;
  await a.addApiKey('sk-1', 'https://gw.example.test/v1');
  assert.equal(a.state.accounts.filter((x: any) => x.kind === 'apiKey').length, 1);
  // replacing a key that isn't a key account adds a row instead
  await a.addApiKey('sk-2', '', 'default');
  assert.equal(a.state.accounts.filter((x: any) => x.kind === 'apiKey').length, 2);
  await a.addApiKey('sk-2', '');
  assert.equal(a.state.accounts.filter((x: any) => x.kind === 'apiKey').length, 2);
  assert.equal(a.apiBase(), 'https://api.openai.com/v1');
  a.state.active = 'default';
  assert.equal(a.apiBase(), 'https://api.openai.com/v1');
});

test('replacing the key in use logs the app-server in again', async (t) => {
  const { a } = setup(t, {
    state: { active: 'k', accounts: [{ id: 'k', kind: 'apiKey', baseUrl: null, status: 'expired' }] },
    homes: { k: 'key:sk-old' },
  });
  const logins: any[] = [];
  a.mainRequest = async (_m: string, p: any) => void logins.push(p);
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }));
  a.applied = 'k';
  a.mainMode = 'managed';
  await a.addApiKey('sk-new', '', 'k');
  assert.deepEqual(
    logins.map((p) => p.apiKey),
    ['sk-new'],
  );
  assert.equal(a.get('k').status, 'ok');
  // replacing one that isn't applied doesn't touch what is
  a.applied = 'other';
  await a.addApiKey('sk-newer', '', 'k');
  assert.equal(a.applied, 'k');
});

/* ---------- MoPilot credits ---------- */
test('MoPilot credits: added, updated, unchanged and removed', async (t) => {
  const { a, userData, notices } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  const logins: any[] = [];
  a.mainRequest = async (m: string, p: any) => void logins.push([m, p?.apiKey]);
  assert.equal((await a.setMoPilotKey(null)).accounts.length, 2);
  await a.setMoPilotKey('mpk-1', 'https://gw.example.test/v1');
  const mp = a.get('mopilot');
  assert.deepEqual([mp.mopilot, mp.baseUrl], [true, 'https://gw.example.test/v1']);
  assert.equal(sealedAuth(path.join(userData, 'accounts', 'mopilot')).OPENAI_API_KEY, 'mpk-1');
  const events = notices().length;
  await a.setMoPilotKey('mpk-1', 'https://gw.example.test/v1');
  await a.setMode('mopilot');
  assert.equal(a.state.lastSubscription, 'default');
  assert.equal(a.state.active, 'mopilot');
  // a new key under the active account is logged in again
  logins.length = 0;
  await a.setMoPilotKey('mpk-2', 'https://gw2.example.test/v1');
  assert.deepEqual(logins, [['account/login/start', 'mpk-2']]);
  assert.equal(mp.baseUrl, 'https://gw2.example.test/v1');
  // signing out of MoPilot falls back to a working subscription
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'default');
  assert.ok(!fs.existsSync(path.join(userData, 'accounts', 'mopilot')));
  assert.equal(notices().length, events);
  // removed while not in use: nothing else changes
  await a.setMoPilotKey('mpk-3', 'u');
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'default');
  // a key that fails to apply still shows the change
  await a.setMoPilotKey('mpk-3', 'u');
  a.state.active = 'mopilot';
  a.get('default').status = 'expired';
  a.get('b').status = 'expired';
  a.state.accounts.push({ id: 'k', kind: 'apiKey', status: 'ok' });
  keyHome(path.join(userData, 'accounts', 'k'), 'sk-k');
  a.applyNow = async () => {
    throw new Error('down');
  };
  // a lapsed subscription before the key, even when switching to it fails (it asks to sign in again)
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'default');
  assert.equal(a.get('mopilot'), null);
});

test('MoPilot sign-out goes to a lapsed subscription before ever a saved key', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: {
      active: 'mopilot',
      accounts: [
        { id: 'old', status: 'expired' },
        { id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' },
        { id: 'k', kind: 'apiKey', status: 'ok' },
      ],
    },
    homes: { mopilot: 'key:mpk', k: 'key:sk-k' },
  });
  a.mainRequest = async () => ({});
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'old');
});

/* ---------- modes ---------- */
test('setMode moves between subscription, API key and MoPilot, remembering the subscription', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { accounts: [sub('b'), sub('c')] },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  a.mainRequest = async () => ({});
  await assert.rejects(a.setMode('mopilot'), /Sign in to MoPilot first/);
  await assert.rejects(a.setMode('apiKey'), /Add an API key first/);
  a.state.accounts.push(
    { id: 'k1', kind: 'apiKey', status: 'ok' },
    { id: 'k2', kind: 'apiKey', status: 'ok' },
    { id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok' },
  );
  keyHome(path.join(a.root, 'k1'), 'sk-1');
  keyHome(path.join(a.root, 'k2'), 'sk-2');
  keyHome(path.join(a.root, 'mopilot'), 'mpk');
  await a.switchTo('c');
  await a.setMode('apiKey', 'k2');
  assert.deepEqual([a.state.active, a.state.lastSubscription], ['k2', 'c']);
  await a.setMode('apiKey', 'gone');
  assert.equal(a.state.active, 'k1');
  // from a key to credits: the subscription remembered stays
  await a.setMode('mopilot');
  assert.equal(a.state.lastSubscription, 'c');
  await a.setMode('subscription');
  assert.equal(a.state.active, 'c');
  a.state.lastSubscription = 'gone';
  await a.setMode('subscription');
  assert.equal(a.state.active, 'b');
  // a record without a kind is a subscription
  delete a.get('b').kind;
  await a.setMode('apiKey');
  assert.equal(a.state.lastSubscription, 'b');
  await a.switchTo('b');
  a.state.lastSubscription = null;
  await a.setMode('mopilot');
  assert.equal(a.state.lastSubscription, 'b');
  for (const x of a.state.accounts) if (x.kind === 'chatgpt' || !x.kind) x.status = 'expired';
  await assert.rejects(a.setMode('subscription'), /Sign in with ChatGPT first/);
  // from nothing active
  a.active = () => null;
  await a.setMode('apiKey');
  await a.setMode('mopilot');
});

/* ---------- chat pins, auto-switch, dispose ---------- */
test('a chat can be put on an account and back in the pool; the relay drops its connection', (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  assert.deepEqual(a.pinChat(null, 'b').chatAccounts, {});
  let v = a.pinChat('t1', 'b');
  assert.deepEqual(v.chatAccounts.t1, { id: 'b', pinned: true });
  assert.deepEqual(a.state.chatPins, { t1: 'b' });
  a.relay = { dropSession: (id: string) => relayCtl.dropped.push(id), stop() {} };
  v = a.pinChat('t1', null);
  assert.deepEqual(v.chatAccounts.t1, { id: 'b', pinned: false });
  assert.deepEqual(a.state.chatPins, {});
  assert.deepEqual(relayCtl.dropped, ['t1']);
  // an unknown account unpins; a chat that was never pinned is fine too
  a.state.chatPins = null;
  a.pinChat('t2', 'nope');
  assert.deepEqual(a.state.chatPins, {});
  assert.equal(a.pins.has('t2'), false);
  a.relay = null;
});

test('dispose stops the relay, the sidecars and a sign-in in progress', async (t) => {
  const { a } = setup(t);
  await a.startRelay();
  await a.startLogin();
  const sc = a.sidecar(a.active());
  a.dispose();
  await flush(12);
  assert.equal(relayCtl.stops, 1);
  assert.equal(sc.proc, null);
  assert.equal(a.login, null);
  a.relay = null;
});
