// Which login a Claude Code chat runs on when main decides alone (electron/harness/claude/adapter.cjs accountOf): the chat's
// own pick, else the one saved in its file (after a restart with no window), and a signed-out pick is stood in for
// only by a login of the same billing lane. Also the lane comparison (shared/switch.mjs) and what the identity drivers
// report (electron/identity/drivers). Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { ClaudeDriver } = require('../electron/identity/drivers/claude.cjs');
const { LoginMarks } = require('../electron/identity/contract/loginMarks.cjs');
const { providerFor } = require('../electron/identity/contract/registry.cjs');
const shared = require('../shared/switch.mjs');

const CHAT = 'claude:s1';
const login = (id: string, extra: any = {}) => ({ id, email: `${id}@example.test`, authMethod: 'claude.ai', loggedIn: true, ...extra });
const consoleKey = (id: string, extra: any = {}) => login(id, { authMethod: 'console api key', ...extra });

function adapter(accounts: any[], o: { active?: string; saved?: Record<string, string> } = {}) {
  return new ClaudeAdapter({
    api: { accounts: () => ({ active: o.active ?? 'default', autoSwitch: true, accounts }) },
    state: new SessionStore(),
    prefs: () => ({}),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c, key: c }),
    ...(o.saved ? { savedAccount: (chatId: string) => o.saved![chatId] ?? null } : {}),
  });
}

/* ---------- A-7: the saved pick survives a restart ---------- */
test('with no window after a restart, a chat runs on the login saved in its file, not the active one', () => {
  const a = adapter([login('default'), login('b')], { saved: { [CHAT]: 'b' } });
  assert.equal(a.accountOf(CHAT), 'b');
  assert.equal(a.pickOf(CHAT), 'b');
  // the file wins over a window's push: main writes its moves there and a user's pick reaches it too, while a push can be
  // a window's echo of an older move (#2538)
  a.setOwn(CHAT, { account: 'default' });
  assert.equal(a.accountOf(CHAT), 'b');
  // a chat with nothing saved yet runs on what a window pushed
  a.setOwn('claude:new', { account: 'b' });
  assert.equal(a.pickOf('claude:new'), 'b');
  // a chat with nothing saved uses the active login
  assert.equal(a.accountOf('claude:other'), 'default');
  assert.equal(a.pickOf('claude:other'), null);
  // with no reader of the file, only the window's pick counts
  assert.equal(adapter([login('default'), login('b')]).pickOf(CHAT), null);
});

/* ---------- A-9: no silent lane change ---------- */
test('a signed-out pick is stood in for by a login of its own lane, never by a Console-key login', () => {
  const accounts = [login('default', { loggedIn: false }), consoleKey('console'), login('third')];
  const a = adapter(accounts, { active: 'console' });
  a.setOwn(CHAT, { account: 'default' });
  assert.equal(a.accountOf(CHAT), 'third');
  // the active login stands in when it is in the same lane
  const b = adapter([login('default', { loggedIn: false }), login('second'), login('active')], { active: 'active' });
  b.setOwn(CHAT, { account: 'default' });
  assert.equal(b.accountOf(CHAT), 'active');
  // nothing of the lane signed in: the chat stays on its pick, so its turn asks to sign in (decideClaudeSwitch decides)
  const c = adapter([login('default', { loggedIn: false }), consoleKey('console')], { active: 'console' });
  c.setOwn(CHAT, { account: 'default' });
  assert.equal(c.accountOf(CHAT), 'default');
  // the reverse: a Console-key pick never lands on a subscription
  const d = adapter([consoleKey('key', { loggedIn: false }), login('default')]);
  d.setOwn(CHAT, { account: 'key' });
  assert.equal(d.accountOf(CHAT), 'key');
  // Stop: no stand-in at all, the chat stays on its pick and its turn asks
  const stop = new ClaudeAdapter({
    api: { accounts: () => ({ active: 'active', autoSwitch: false, accounts: [login('default', { loggedIn: false }), login('active')] }) },
    state: new SessionStore(),
    prefs: () => ({}),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c, key: c }),
  });
  stop.setOwn(CHAT, { account: 'default' });
  assert.equal(stop.accountOf(CHAT), 'default');
  assert.equal(stop.pickedLogin(CHAT), 'default');
  assert.equal(stop.pickedLogin('claude:none'), null);
  // logins main has seen lapse or run out are not stand-ins
  const marked = adapter([login('default', { loggedIn: false }), login('lapsed'), login('out'), login('ok')], { active: 'lapsed' });
  marked.setOwn(CHAT, { account: 'default' });
  marked.marks.expired({ login: true }, 'lapsed');
  marked.marks.limited({ login: true }, 'out', Date.now(), 60_000);
  assert.equal(marked.accountOf(CHAT), 'ok');
  // a pick that is no longer listed (removed) has no lane to keep: the active login
  const e = adapter([login('default')]);
  e.setOwn(CHAT, { account: 'gone' });
  assert.equal(e.accountOf(CHAT), 'default');
});

/* ---------- A-11: lanes compare provider ids ---------- */
test('two instances on the same custom endpoint are in one lane (providers compare by id, not by object)', () => {
  const x = { id: 'x', provider: providerFor('https://gw.example.test/v1', 'openai'), billing: 'apiKey', status: 'ok' };
  const y = { id: 'y', provider: providerFor('https://gw.example.test/v2', 'openai'), billing: 'apiKey', status: 'ok' };
  const z = { id: 'z', provider: providerFor('https://other.example.test', 'openai'), billing: 'apiKey', status: 'ok' };
  assert.notEqual(x.provider, y.provider);
  assert.equal(shared.sameLane(x, y), true);
  assert.equal(shared.sameLane(x, z), false);
  assert.equal(shared.sameLane({ ...x, provider: 'custom:gw.example.test' }, y), true);
  assert.equal(shared.onUnavailable({ from: x, candidates: [y] }).action, 'switch');
  // another provider is only offered; pay-per-use of the same provider is confirmed
  assert.equal(shared.onUnavailable({ from: x, candidates: [z] }).action, 'offer');
  const s = { id: 's', provider: providerFor(null, 'openai'), billing: 'subscription', status: 'ok' };
  const k = { id: 'k', provider: providerFor(null, 'openai'), billing: 'apiKey', status: 'ok' };
  assert.equal(shared.onUnavailable({ from: s, candidates: [{ ...k, provider: 'openai' }] }).action, 'confirm');
  assert.equal(shared.sameLane(null, s), false);
});

/* ---------- A-11: the Claude driver reports what main knows ---------- */
test('Claude per-chat accounts exist only on the subscription, and marks show in the instances', () => {
  const marks = new LoginMarks();
  const now = 5_000;
  let mode = 'subscription';
  const driver = new ClaudeDriver({
    accounts: () => ({
      view: () => ({ active: 'default', accounts: [login('default'), login('b'), login('c', { loggedIn: false })] }),
      state: { autoSwitch: true },
    }),
    keyInfo: () => ({ set: true, mode, baseUrl: null }),
    gatewaySet: () => false,
    readUsage: async () => '',
    marks: () => marks,
    now: () => now,
  });
  assert.equal(driver.perChat, true);
  marks.expired({ login: true }, 'default');
  marks.limited({ login: true }, 'b', now, 1000);
  const by = Object.fromEntries(driver.instances().map((i: any) => [i.account, i]));
  assert.deepEqual([by.default.status, by.default.limited], ['expired', false]);
  assert.deepEqual([by.b.status, by.b.limited], ['ok', true]);
  assert.deepEqual([by.c.status, by.c.limited], ['signedOut', false]);
  assert.equal(by.apiKey.limited, false);
  mode = 'apiKey';
  assert.equal(driver.perChat, false);
  // with no marks to read, the logins read as their status says
  const bare = new ClaudeDriver({
    accounts: () => null,
    keyInfo: () => null,
    gatewaySet: () => false,
    readUsage: async () => '',
  });
  assert.deepEqual(bare.instances(), []);
  assert.equal(bare.perChat, true);
});
