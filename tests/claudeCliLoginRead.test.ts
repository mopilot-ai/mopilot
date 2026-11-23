// #3157: the CLI's own Claude login lists as signed out until its first status read, and main never read it on its own,
// so a limit in the first seconds after launch (or with no window ever open) could not move the chat there. A turn now
// waits (bounded, one shared read) for that read before it starts (electron/harness/claude/cliLoginRead.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { controlledReads } from './support/async-scenarios.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-cli-login-read-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'shared');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const require = createRequire(import.meta.url);
const { ClaudeAccounts } = require('../electron/harness/claude/accounts.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { readCliLogin, cliLoginRead, READ_WAIT_MS } = require('../electron/harness/claude/cliLoginRead.cjs');
const { createIdentityApi } = require('../electron/harness/claude/identityApi.cjs');

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'cli@example.test', subscriptionType: 'max' });
let n = 0;

/** A real ClaudeAccounts whose added login "second" is in use; the CLI's own login is signed in but not read yet. */
function accountsWith(run: (bin: string, args: string[], id: string) => Promise<string>) {
  const userData = path.join(tmp, `ud${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  const second = { id: 'second', email: 'second@example.test', subscriptionType: 'max', authMethod: 'claude.ai', loggedIn: true };
  fs.writeFileSync(path.join(userData, 'claude-accounts.json'), JSON.stringify({ active: 'second', autoSwitch: true, accounts: [second] }));
  return new ClaudeAccounts({ userData, broadcast: () => {}, run });
}

test('renewing the CLI login retires an older status read in either completion order', async () => {
  const signedOut = JSON.stringify({ loggedIn: false, email: 'old@example.test' });
  for (const oldFirst of [true, false]) {
    const { read, requests } = controlledReads<string>();
    const accounts = accountsWith(read);
    const old = readCliLogin(accounts, '/bin/claude');
    const refresh = readCliLogin(accounts, '/bin/claude', true);
    if (oldFirst) {
      requests[0].resolve(signedOut);
      await old;
      assert.equal(accounts.defaultChecked, false, 'the old credential remains unpublished while the new read is pending');
    }
    requests[1].resolve(SIGNED_IN);
    await refresh;
    if (!oldFirst) {
      requests[0].resolve(signedOut);
      await old;
    }
    const login = accounts.view().accounts.find((a: any) => a.id === 'default');
    assert.deepEqual([login.email, login.loggedIn], ['cli@example.test', true]);
  }
});

function world(o: { run?: (bin: string, args: string[], id: string) => Promise<string>; api?: any; waitMs?: number } = {}) {
  const runs: string[] = [];
  const accts = accountsWith(o.run ?? (async (_b, _a, id) => (runs.push(id), id === 'default' ? SIGNED_IN : '{}')));
  const sent: any[] = [];
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      accounts: () => accts.view(),
      sessionCwd: async () => '/work',
      keyMode: () => false,
      readCliLogin: (bin: string) => readCliLogin(accts, bin),
      ...o.api,
    },
    state: new SessionStore(),
    prefs: () => ({ claudeBin: '/bin/claude' }),
    send: async (...a: any[]) => (sent.push(a), {}),
    enqueue: () => {},
    chatOf: (id: string) => id,
    ref: (chatId: string) => ({ id: chatId.slice(7), key: chatId, kind: 'claude' }),
    emit: () => false,
    setGoal: () => {},
    moved: () => {},
    notifyLimit: () => {},
  });
  if (o.waitMs !== undefined) adapter.loginReadWaitMs = o.waitMs;
  const turn = async (chatId = 'claude:c1') => {
    adapter.registerSession(chatId, { cwd: '/work', resume: true });
    return adapter.startTurn(chatId, { id: chatId.slice(7), key: chatId, kind: 'claude' }, { text: 'hello', opts: {} });
  };
  return { accts, adapter, sent, runs, turn };
}

test('a limit on the first turn after launch moves the chat to the CLI login, which the turn read before it started', async () => {
  const w = world();
  assert.equal(w.accts.view().accounts.find((a: any) => a.id === 'default').checked, false);
  assert.equal((await w.turn()).started, true);
  assert.deepEqual(w.runs, ['default']);
  assert.equal(w.sent.at(-1)[2].account, 'second');
  w.adapter.limited('claude:c1', 'claude:c1', 'second', 'limit');
  assert.equal(w.adapter.pickOf('claude:c1'), 'default');
  assert.equal(w.adapter.stuck.has('claude:c1'), false);
});

test('a read that never answers holds the turns at most the bound once; turns meanwhile share one read', async () => {
  let asks = 0;
  const w = world({ waitMs: 20, api: { readCliLogin: () => (asks++, new Promise(() => {})) } });
  const [a, b] = await Promise.all([w.turn('claude:c1'), w.turn('claude:c2')]);
  assert.equal(a.started && b.started, true);
  assert.equal(asks, 1);
  // waited out once: later turns start at once, with no second read of a CLI that hangs
  assert.equal(cliLoginRead(w.adapter), null);
  assert.equal((await w.turn('claude:c3')).started, true);
  assert.equal(asks, 1);
  // the bound is a few seconds by default
  assert.equal(READ_WAIT_MS, 5000);
});

test('a read that fails is noted and the turn starts; a failed status read counts as read', async () => {
  const thrown = world({ api: { readCliLogin: async () => Promise.reject(new Error('no CLI')) } });
  assert.equal((await thrown.turn()).started, true);
  const failed = world({ run: async () => Promise.reject(new Error('timed out')) });
  assert.equal((await failed.turn()).started, true);
  assert.equal(failed.accts.defaultChecked, true);
});

test('nothing to read: a key, a single login, a login already read, or a harness that cannot read', async () => {
  const view = (accounts: any[]) => ({ api: { readCliLogin: async () => {}, keyMode: () => false, accounts: () => ({ accounts }) } });
  const unread = [
    { id: 'default', checked: false },
    { id: 'second', checked: true },
  ];
  const reading = cliLoginRead({ ...view(unread), prefs: () => ({}) });
  assert.ok(reading);
  assert.equal(cliLoginRead({ api: { ...view(unread).api, keyMode: () => true } }), null);
  assert.equal(cliLoginRead(view([{ id: 'default', checked: false }])), null);
  assert.equal(
    cliLoginRead(
      view([
        { id: 'default', checked: true },
        { id: 'second', checked: true },
      ]),
    ),
    null,
  );
  assert.equal(cliLoginRead({ api: { accounts: () => ({ accounts: unread }) } }), null);
  assert.ok(cliLoginRead({ api: { readCliLogin: async () => {}, accounts: () => ({ accounts: unread }) }, prefs: () => ({}) }));
  await reading;
});

test("readCliLogin reads once, and a window's later read that already landed is not overwritten", async () => {
  await readCliLogin(null, '/bin/claude');
  const w = world();
  await readCliLogin(w.accts, '/bin/claude');
  await readCliLogin(w.accts, '/bin/claude');
  assert.deepEqual(w.runs, ['default']);
  assert.equal(w.accts.view().accounts.find((a: any) => a.id === 'default').loggedIn, true);

  let release: (v: string) => void = () => {};
  const slow = world({ run: (_b, _a, id) => (id === 'default' ? new Promise((r) => (release = r)) : Promise.resolve('{}')) });
  const mine = readCliLogin(slow.accts, '/bin/claude');
  // a window's refresh asks after and lands first
  slow.accts.statusReads.set('default', {});
  slow.accts.takeDefault({ loggedIn: false, email: null, subscriptionType: null, authMethod: null });
  release(SIGNED_IN);
  await mine;
  assert.equal(slow.accts.view().accounts.find((a: any) => a.id === 'default').loggedIn, false);
});

test("the identity layer's pieces of the Claude harness", async () => {
  const usage = async (_bin: string, account: string) =>
    account === 'bad'
      ? { state: 'error', error: 'boom' }
      : account === 'gone'
        ? { state: 'retired' }
        : { state: 'ok', text: `u:${account}` };
  const api = createIdentityApi({
    state: { accts: 'A', gatewayKey: () => 'k' },
    auth: { apiKeyInfo: () => 'info' },
    cli: { findBinary: async () => '/bin/claude' },
    usageSchedule: { usage },
  });
  assert.equal(api.accounts(), 'A');
  assert.equal(api.keyInfo(), 'info');
  assert.equal(api.gatewaySet(), true);
  assert.equal(await api.readUsage('x'), 'u:x');
  await assert.rejects(api.readUsage('bad'), /boom/);
  await assert.rejects(api.readUsage('gone'), /login changed/);
  const none = createIdentityApi({ state: {}, auth: {}, cli: { findBinary: async () => null }, usageSchedule: { usage } });
  assert.equal(await none.readUsage('x'), '');
});
