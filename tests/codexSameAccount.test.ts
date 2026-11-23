// One ChatGPT account is one record in the Codex pool (#1312): when $CODEX_HOME/auth.json is signed in again outside
// MoPilot as an account already added, electron/identity/accounts/cliLogin.cjs folds the CLI login into that record
// (the login in use and chats move with it), so the list, usage polls, the relay and failover see one quota. The same
// workspace with another member, or an added login that lapsed, stays its own record. Codex is faked; data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, chatgptAuth, sub, flush, codex } from './support/electron-accounts.ts';

/** The CLI's own login signed in again as `email` of workspace `acct`. */
const resign = (codexHome: string, email: string, acct: string) => chatgptAuth(codexHome, email, acct);

test('the CLI login signed in again as an added account folds into it, with what was on it', (t) => {
  const { a, codexHome } = setup(t, {
    state: { active: 'default', accounts: [sub('b'), sub('c')], chatPins: { pinned: 'default', other: 'c' } },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  assert.deepEqual(
    a.view().accounts.map((x: any) => x.id),
    ['default', 'b', 'c'],
  );
  a.pins.set('t1', { id: 'default', at: Date.now() });
  resign(codexHome, 'B@example.com', 'acct-b');
  a.syncDefault();
  const v = a.view();
  assert.deepEqual(
    v.accounts.map((x: any) => x.id),
    ['b', 'c'],
  );
  assert.deepEqual(v.same, { default: 'b' });
  assert.equal(v.active, 'b');
  assert.equal(a.pins.get('t1').id, 'b');
  assert.deepEqual(a.state.chatPins, { pinned: 'b', other: 'c' });
  // one record per quota: the pool counts two subscriptions, not three
  assert.equal(a.subscriptions().length, 2);
  // signed in again as someone else: the CLI login is listed by itself again, with no usage carried over
  resign(codexHome, 'new@example.com', 'acct-new');
  a.syncDefault();
  assert.deepEqual(a.view().same, {});
  assert.deepEqual(
    a.view().accounts.map((x: any) => [x.id, x.email, x.limits]),
    [
      ['default', 'new@example.com', null],
      ['b', 'b@example.com', null],
      ['c', 'c@example.com', null],
    ],
  );
  assert.equal(a.state.active, 'b');
});

test('another member of the same workspace, an added login that lapsed, or an API key is never folded', (t) => {
  const { a, codexHome } = setup(t, { state: { accounts: [sub('b'), sub('x', { status: 'expired' })] }, homes: { b: 'b@example.com' } });
  resign(codexHome, 'teammate@example.com', 'acct-b');
  a.syncDefault();
  assert.deepEqual(a.view().same, {});
  assert.equal(a.get('default').email, 'teammate@example.com');
  // the CLI login is the account whose added login lapsed: both stay, so that one can be signed in again or removed
  resign(codexHome, 'x@example.com', 'acct-x');
  a.syncDefault();
  assert.deepEqual(
    a.view().accounts.map((x: any) => x.id),
    ['default', 'b', 'x'],
  );
  fs.writeFileSync(`${codexHome}/auth.json`, JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
  a.syncDefault();
  assert.deepEqual(a.view().same, {});
});

test('the folded account alone in the pool is a single account: the relay passes requests through', (t) => {
  // an older accounts.json with no chat pins at all
  const { a, codexHome } = setup(t, { state: { active: 'b', accounts: [sub('b')], chatPins: null }, homes: { b: 'b@example.com' } });
  assert.equal(a.subscriptions().length, 2);
  resign(codexHome, 'b@example.com', 'acct-b');
  a.syncDefault();
  assert.equal(a.subscriptions().length, 1);
  assert.equal(a.pickFor('t1', new Set()), null);
  assert.deepEqual(a.candidates(a.get('b')), []);
});

test('removing the account the CLI login folded into lists the CLI login again and leaves it signed in', async (t) => {
  const { a, codexHome, requests } = setup(t, { state: { active: 'b', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  resign(codexHome, 'b@example.com', 'acct-b');
  a.syncDefault();
  assert.deepEqual(
    a.view().accounts.map((x: any) => x.id),
    ['b'],
  );
  await a.remove('b');
  await flush(12);
  assert.deepEqual(
    a.view().accounts.map((x: any) => x.id),
    ['default'],
  );
  assert.equal(a.state.active, 'default');
  // the main app-server is never told to sign out: that would clear the CLI's own auth.json
  assert.equal(requests().includes('account/logout'), false);
  assert.equal(fs.existsSync(`${codexHome}/auth.json`), true);
});

test('a sign-in matches the record of the same workspace and member, never one with no workspace', async (t) => {
  const { a, codexHome, notices } = setup(t, {
    state: { accounts: [sub('b'), sub('k', { kind: 'apiKey', chatgptAccountId: undefined, email: null })] },
    homes: { b: 'b@example.com' },
  });
  resign(codexHome, 'b@example.com', 'acct-b');
  a.syncDefault();
  // the sign-in's own account read names no email: the token's claims do
  codex.handle = (m) => (m === 'account/read' ? { account: {} } : m === 'account/login/start' ? { loginId: 'L', authUrl: 'u' } : {});
  await a.startLogin();
  chatgptAuth(codex.procs.at(-1)!.home, 'B@example.com', 'acct-b');
  codex.procs.at(-1)!.send({ method: 'account/login/completed', params: { success: true } });
  await flush(12);
  // the account already listed (folded with the CLI login) is signed in again, not added
  assert.equal(notices().at(-1).added, false);
  assert.deepEqual(
    a.state.accounts.map((x: any) => x.id),
    ['b', 'k'],
  );
});

test('the background poll keeps checking a CLI login folded into a lone account, and lists it again once re-signed', async (t) => {
  const { a, codexHome } = setup(t, { state: { active: 'b', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  resign(codexHome, 'b@example.com', 'acct-b');
  a.syncDefault();
  resign(codexHome, 'new@example.com', 'acct-new');
  t.mock.timers.tick(10 * 60_000);
  await flush(12);
  assert.deepEqual(
    a.view().accounts.map((x: any) => x.id),
    ['default', 'b'],
  );
  assert.deepEqual(a.view().same, {});
});

test("the app-server's own usage readings on the folded CLI login are charged to the account it folded into", (t) => {
  for (const [mode, applied] of [
    ['managed', null],
    ['external', 'default'],
  ] as const) {
    const { a, codexHome } = setup(t, { state: { active: 'default', accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
    Object.assign(a, { mainMode: mode, applied });
    resign(codexHome, 'b@example.com', 'acct-b');
    a.syncDefault();
    assert.equal(a.heldLogin()?.id, 'b', mode);
    a.onAppServerUsage({ primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 9e9 } });
    assert.equal(a.get('b').limits.used, 42, mode);
  }
  // a login applied that is neither the one in use nor folded into it still holds nobody's readings
  const { a } = setup(t, { state: { active: 'b', accounts: [sub('b'), sub('c')] }, homes: { b: 'b@example.com', c: 'c@example.com' } });
  a.applied = 'c';
  assert.equal(a.heldLogin(), null);
});
