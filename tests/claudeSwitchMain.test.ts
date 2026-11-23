// WP3-7: Claude's account-switch policy runs in main with no window (A12, A23): a limit or a lapsed
// login moves the chat to another login of the same billing type, writes the note, and goes on (a goal
// set again); pay-per-use and other providers are never taken on their own, and with no window to ask
// the chat pauses with one notification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { decideClaudeSwitch } = require('../electron/identity/contract/switch.cjs');

const CHAT = 'claude:s1';
const sub = (id: string, extra: any = {}) => ({
  id,
  email: `${id}@example.test`,
  subscriptionType: 'max',
  authMethod: 'claude.ai',
  loggedIn: true,
  ...extra,
});
const view = (accounts: any[], extra: any = {}) => ({ active: 'default', autoSwitch: true, accounts, ...extra });
const NOW = 1_000_000;

test('policy: another subscription takes over, with the note and the goal carried', () => {
  const d = decideClaudeSwitch({
    account: 'default',
    view: view([sub('default'), sub('second')]),
    marks: new Map(),
    now: NOW,
    goal: { status: 'active', objective: 'x' },
  });
  assert.equal(d.action, 'switch');
  assert.equal(d.to, 'second');
  // the note names the login that ran out, so the user knows which one did
  assert.equal(d.note, 'Max limit reached on default@example.test. Continued on second@example.test · Goal and plan mode carried over');
});

test('policy: a lapsed login says it needs to sign in again', () => {
  const d = decideClaudeSwitch({
    account: 'default',
    reason: 'expired',
    view: view([sub('default'), sub('second')]),
    marks: new Map(),
    now: NOW,
  });
  assert.equal(d.note, 'default@example.test needs to sign in again. Continued on second@example.test');
});

test('policy: never silently from a subscription to pay-per-use or to another provider; off, temporary, key mode and loops stay put', () => {
  const key = sub('key', { authMethod: 'console api key' });
  assert.equal(decideClaudeSwitch({ account: 'default', view: view([sub('default'), key]), marks: new Map(), now: NOW }).action, 'confirm');
  assert.equal(
    decideClaudeSwitch({
      account: 'default',
      view: view([sub('default'), sub('second')], { autoSwitch: false }),
      marks: new Map(),
      now: NOW,
    }).action,
    'none',
  );
  assert.equal(
    decideClaudeSwitch({ account: 'default', view: view([sub('default'), sub('second')]), marks: new Map(), now: NOW, ephemeral: true })
      .action,
    'none',
  );
  assert.equal(
    decideClaudeSwitch({ account: 'default', view: view([sub('default'), sub('second')]), marks: new Map(), now: NOW, keyMode: true })
      .action,
    'none',
  );
  assert.equal(
    decideClaudeSwitch({
      account: 'default',
      view: view([sub('default'), sub('second')]),
      marks: new Map(),
      now: NOW,
      recent: [NOW - 1, NOW - 2, NOW - 3],
    }).action,
    'none',
  );
  // the next login is itself out of usage, or signed out
  assert.equal(
    decideClaudeSwitch({
      account: 'default',
      view: view([sub('default'), sub('second')]),
      marks: new Map([['second', { limitedUntil: NOW + 5000 }]]),
      now: NOW,
    }).action,
    'none',
  );
  assert.equal(
    decideClaudeSwitch({ account: 'default', view: view([sub('default'), sub('second', { loggedIn: false })]), marks: new Map(), now: NOW })
      .action,
    'none',
  );
});

test('policy: the login in use goes first, then the one with the most left', () => {
  const v = view([sub('default'), sub('a'), sub('b')]);
  assert.equal(decideClaudeSwitch({ account: 'a', view: v, marks: new Map(), now: NOW }).to, 'default');
  assert.equal(
    decideClaudeSwitch({
      account: 'default',
      view: v,
      marks: new Map([
        ['a', { left: 10 }],
        ['b', { left: 80 }],
      ]),
      now: NOW,
    }).to,
    'b',
  );
});

function setup(o: { accounts?: any[]; window?: boolean; keyMode?: boolean; goal?: any } = {}) {
  const state = new SessionStore();
  const events: any[] = [];
  const enqueued: any[] = [];
  const moved: any[] = [];
  const told: any[] = [];
  const notices: any[] = [];
  let busy = false;
  const api: any = {
    isLive: () => false,
    control: async () => {},
    accounts: () => view(o.accounts ?? [sub('default'), sub('second')]),
    metered: () => false,
    keyMode: () => !!o.keyMode,
  };
  const adapter = new ClaudeAdapter({
    api,
    state,
    prefs: () => ({ permission: 'default' }),
    send: async () => ({ elsewhere: [] }),
    enqueue: (chatId: string, item: any) => void enqueued.push({ chatId, item }),
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c.replace(/^claude:/, ''), key: c }),
    emit: (e: any) => (events.push(e), o.window !== false),
    setGoal: (chatId: string, goal: any) => state.patch(chatId, { goal }),
    notifyGoal: (chatId: string, n: any) => void notices.push({ chatId, ...n }),
    moved: (chatId: string, m: any) => void moved.push({ chatId, ...m }),
    notifyLimit: (chatId: string, reason: string) => void told.push({ chatId, reason }),
    resumeMs: 0,
    now: () => NOW,
    graceMs: 0,
  });
  if (o.goal) state.patch(CHAT, { goal: o.goal });
  return { adapter, state, events, enqueued, moved, told, notices, setBusy: (b: boolean) => (busy = b), api };
}
const limit = () => ({
  key: CHAT,
  kind: 'message',
  msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: NOW / 1000 + 3600 } },
});
const limitReply = () => ({ key: CHAT, kind: 'message', msg: { type: 'assistant', error: 'rate_limit', message: { content: [] } } });
const result = () => ({ key: CHAT, kind: 'message', msg: { type: 'result', subtype: 'success', is_error: true } });
const tick = () => new Promise((r) => setTimeout(r, 15));
const goal = { objective: 'finish the list', status: 'active', updatedAt: 1, claude: { iterations: 1, lastReason: null, limit: null } };

test('no window: a limit moves the chat, writes the note, and continues on the other login after the turn ends', async () => {
  const t = setup({ window: false });
  t.adapter.observe(limit());
  t.adapter.observe(limitReply());
  assert.equal(t.moved.length, 1);
  assert.deepEqual(t.moved[0].account, 'second');
  assert.equal(t.moved[0].note.text, 'Max limit reached on default@example.test. Continued on second@example.test');
  assert.equal(t.moved[0].note.kind, 'account');
  // the chat now runs on the other login
  assert.equal(t.adapter.accountOf(CHAT), 'second');
  assert.equal(t.enqueued.length, 0);
  t.adapter.observe(result());
  await tick();
  assert.deepEqual(t.enqueued, [{ chatId: CHAT, item: { text: 'Continue where you left off.', attachments: [], opts: {} } }]);
  assert.equal(t.told.length, 0);
});

test('no window: a running goal is set again on the new login and is not settled by the turn that ran out', async () => {
  const t = setup({ window: false, goal });
  t.adapter.goalTurns.add(CHAT);
  t.adapter.observe(limit());
  assert.match(t.moved[0].note.text, /Goal and plan mode carried over$/);
  t.adapter.observe(result());
  await tick();
  assert.equal(t.enqueued[0].item.text, '/goal finish the list');
  assert.equal(t.enqueued[0].item.opts.human, undefined);
  assert.equal(t.state.get(CHAT).goal.status, 'active');
});

test('no window: a lapsed login moves the chat like a limit', async () => {
  const t = setup({ window: false });
  t.adapter.observe({
    key: CHAT,
    kind: 'message',
    msg: { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Please run /login' }] } },
  });
  assert.match(t.moved[0].note.text, /^default@example.test needs to sign in again\. Continued on second@example.test$/);
  assert.equal(t.adapter.accountOf(CHAT), 'second');
});

test('no window, only pay-per-use to go to: the goal is paused for Resume and one notification goes out; nothing moves', async () => {
  const key = sub('key', { authMethod: 'console api key' });
  const t = setup({ window: false, accounts: [sub('default'), key], goal });
  t.adapter.observe(limit());
  t.adapter.observe(limitReply());
  t.adapter.observe(result());
  await tick();
  assert.equal(t.moved.length, 0);
  assert.equal(t.enqueued.length, 0);
  assert.equal(t.state.get(CHAT).goal.status, 'usageLimited');
  assert.deepEqual(
    t.notices.map((n) => n.body),
    ['Goal paused · Usage limit reached'],
  );
  assert.equal(t.told.length, 0);
  assert.equal(t.adapter.accountOf(CHAT), 'default');
});

test('no window, no goal, nowhere to go: one notification per stopped turn', () => {
  const t = setup({ window: false, accounts: [sub('default')] });
  t.adapter.observe(limit());
  t.adapter.observe(limitReply());
  assert.deepEqual(t.told, [{ chatId: CHAT, reason: 'limit' }]);
  t.adapter.observe(result());
  t.adapter.observe(limit());
  assert.equal(t.told.length, 2);
});

test('with a window: the switch is announced to it, and when nothing can be moved to it is asked instead', () => {
  const t = setup();
  t.adapter.observe(limit());
  assert.deepEqual(
    t.events.map((e) => e.kind),
    ['accountSwitched'],
  );
  assert.equal(t.events[0].to, 'second');
  const u = setup({ accounts: [sub('default')] });
  u.adapter.observe(limit());
  assert.deepEqual(
    u.events.map((e) => [e.kind, e.reason]),
    [['limitUnresolved', 'limit']],
  );
  assert.equal(u.told.length, 0);
  assert.equal(u.moved.length, 0);
});

test('a key runs the whole harness: nothing moves', () => {
  const t = setup({ window: false, keyMode: true });
  t.adapter.observe(limit());
  assert.equal(t.moved.length, 0);
});
