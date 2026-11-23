// What main marks on a Claude Code login (electron/identity/contract/loginMarks.cjs) and how the adapter uses it: a lapse
// ends once the login works again, and a key's or MoPilot credits' failures are never put on the login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { LoginMarks } = require('../electron/identity/contract/loginMarks.cjs');
const { LIMIT_HOLD_MS } = require('../electron/identity/contract/switch.cjs');

const NOW = 1_000_000;
const CHAT_A = 'claude:a';
const CHAT_B = 'claude:b';
const sub = (id: string, extra: any = {}) => ({ id, email: `${id}@example.test`, authMethod: 'claude.ai', loggedIn: true, ...extra });

function setup(o: { accounts?: any[]; keyMode?: boolean } = {}) {
  const moved: any[] = [];
  const told: any[] = [];
  const events: any[] = [];
  let works = (_account: string): boolean => false;
  const adapter = new ClaudeAdapter({
    api: {
      isLive: () => false,
      control: async () => {},
      accounts: () => ({ active: 'default', autoSwitch: true, accounts: o.accounts ?? [sub('default'), sub('second')] }),
      metered: () => false,
      keyMode: () => !!o.keyMode,
      onLoginWorks: (fn: (account: string) => boolean) => (works = fn),
    },
    state: new SessionStore(),
    prefs: () => ({ permission: 'default' }),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c.replace(/^claude:/, ''), key: c }),
    emit: (e: any) => (events.push(e), false),
    setGoal: () => {},
    notifyGoal: () => {},
    moved: (chatId: string, m: any) => void moved.push({ chatId, ...m }),
    notifyLimit: (chatId: string, reason: string) => void told.push({ chatId, reason }),
    resumeMs: 0,
    now: () => NOW,
    graceMs: 0,
  });
  return { adapter, moved, told, events, works: (account: string) => works(account) };
}
const authFailure = (key: string, login?: boolean) => ({
  key,
  kind: 'message',
  ...(login === undefined ? {} : { login }),
  msg: { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid API key' }] } },
});
const rejected = (key: string, login?: boolean) => ({
  key,
  kind: 'message',
  ...(login === undefined ? {} : { login }),
  msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 1 } },
});
const allowed = (key: string, account?: string) => ({
  key,
  kind: 'message',
  login: true,
  ...(account ? { account } : {}),
  msg: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.25 } },
});

test('a lapsed login signed in again is a place to move to again (scenario A)', () => {
  const t = setup();
  // chat B runs on `second`, whose sign-in lapses
  t.adapter.setOwn(CHAT_B, { account: 'second' });
  t.adapter.observe(authFailure(CHAT_B, true));
  assert.equal(t.adapter.marks.get('second')?.expired, true);
  // the user signs `second` in again and Re-check verifies it (electron/harness/claude/index.cjs tells the adapter)
  assert.equal(t.works('second'), true);
  assert.equal(t.adapter.marks.get('second')?.expired, undefined);
  // later, chat A's login hits its limit: it moves to `second` instead of stopping
  t.adapter.observe(rejected(CHAT_A, true));
  assert.deepEqual(
    t.moved.filter((m) => m.chatId === CHAT_A).map((m) => m.account),
    ['second'],
  );
  assert.equal(t.works('second'), false);
});

test('a login that answers again (a rate-limit event) is no longer signed out', () => {
  const t = setup();
  t.adapter.setOwn(CHAT_B, { account: 'second' });
  t.adapter.observe(authFailure(CHAT_B, true));
  // a chat pinned to `second` gets an answer through it
  t.adapter.setOwn('claude:c', { account: 'second' });
  // the process that answered ran on `second` (the event names it); a pick still marked lapsed would not be served by it
  t.adapter.observe(allowed('claude:c', 'second'));
  assert.deepEqual(t.adapter.marks.get('second'), { left: 75 });
  t.adapter.observe(rejected(CHAT_A, true));
  assert.equal(t.moved.find((m) => m.chatId === CHAT_A)?.account, 'second');
});

test("a message is the login's whose process sent it, even while the chat moves to another", () => {
  const t = setup();
  // the chat runs on `default` now, but the old process on `second` still answers
  t.adapter.observe({ ...authFailure(CHAT_A, true), account: 'second' });
  assert.equal(t.adapter.marks.get('second')?.expired, true);
  assert.equal(t.adapter.marks.get('default'), undefined);
});

test('a key or MoPilot credits failing marks nothing on the login (scenario B)', () => {
  const t = setup({ keyMode: true });
  t.adapter.observe(authFailure(CHAT_A, false));
  t.adapter.observe(rejected(CHAT_A, false));
  t.adapter.observe({
    key: CHAT_A,
    kind: 'message',
    login: false,
    msg: { type: 'assistant', error: 'rate_limit', message: { content: [] } },
  });
  assert.deepEqual([...t.adapter.marks.snapshot()], []);
  // nothing moves while a key runs the harness; the chat is told once
  assert.equal(t.moved.length, 0);
  assert.deepEqual(t.told, [{ chatId: CHAT_A, reason: 'expired' }]);
});

test('a process that ran on a key says nothing about the login even after the mode changed back', () => {
  // the user switched back to the subscription while the key's process was still answering
  const t = setup({ keyMode: false });
  t.adapter.observe(authFailure(CHAT_A, false));
  assert.equal(t.adapter.marks.get('default'), undefined);
  assert.equal(t.moved.length, 0);
  assert.deepEqual(t.told, [{ chatId: CHAT_A, reason: 'expired' }]);
});

test('LoginMarks: scoped writes, a hold that is never shortened, and a lapse that ends', () => {
  const m = new LoginMarks();
  const login = { login: true };
  m.limited({ login: false }, 'a', NOW, LIMIT_HOLD_MS);
  m.expired({ login: false }, 'a');
  m.usage({ login: false }, 'a', { status: 'rejected', utilization: 1 }, NOW);
  assert.equal(m.get('a'), undefined);

  m.limited(login, 'a', NOW, 1000);
  assert.deepEqual(m.get('a'), { limitedUntil: NOW + 1000 });
  // already held back: kept as it is
  m.limited(login, 'a', NOW + 10, 5000);
  assert.deepEqual(m.get('a'), { limitedUntil: NOW + 1000 });
  // the hold has passed: a new one starts
  m.limited(login, 'a', NOW + 2000, 1000);
  assert.deepEqual(m.get('a'), { limitedUntil: NOW + 3000 });

  m.expired(login, 'a');
  m.usage(login, 'a', null, NOW);
  assert.equal(m.get('a')?.expired, true);
  m.usage(login, 'a', { status: 'allowed', utilization: 0.6 }, NOW);
  assert.deepEqual(m.get('a'), { limitedUntil: NOW + 3000, left: 40 });
  m.usage(login, 'a', { status: 'rejected', resetsAt: 9 }, NOW);
  assert.deepEqual(m.get('a'), { limitedUntil: 9000, left: 100 });

  m.expired(login, 'b');
  const snap = m.snapshot();
  snap.set('b', {});
  assert.deepEqual(m.get('b'), { expired: true });
  assert.equal(m.works('b'), true);
  assert.deepEqual(m.get('b'), {});
  assert.equal(m.works('b'), false);
  assert.equal(m.works('unknown'), false);
});
