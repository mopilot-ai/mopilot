// What the panel's start does with an account and a worktree: refused before a chat exists, applied after, cleaned up when the chat then fails; on a Codex, a Claude Code and an ACP fake starter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shapeStart, startChat, loginsOf } = require('../electron/app/chromePanelShape.cjs');

function fakes(o: { accounts?: any; worktree?: any; fail?: boolean; pinFails?: boolean; perChat?: boolean; otherLane?: boolean } = {}) {
  const calls: any[][] = [];
  const starts = {
    newWorktree: async (...a: any[]) => (calls.push(['newWorktree', ...a]), 'worktree' in o ? o.worktree : { path: '/wt/1' }),
    discardWorktree: async (...a: any[]) => (calls.push(['discardWorktree', ...a]), { discarded: true }),
    startClaude: (...a: any[]) => (calls.push(['startClaude', ...a]), o.fail ? Promise.reject(new Error('no')) : 'claude:1'),
    startCodex: async (...a: any[]) => (calls.push(['startCodex', ...a]), 'thread-1'),
    startAcp: (...a: any[]) => (calls.push(['startAcp', ...a]), 'acp:fake:1'),
  };
  const rows: Record<string, any[]> = o.accounts ?? {
    claude: [
      { account: 'work', label: 'Work', status: 'ok' },
      { account: 'old', label: null, status: 'signedOut' },
      { account: 'lapsed', label: 'Lapsed', status: 'expired' },
    ],
    codex: [
      { account: 'a', label: 'a@x.com', status: 'ok' },
      { account: 'b', label: 'b@x.com', status: 'ok' },
      { account: 'c', label: 'c@x.com', status: 'expired' },
    ],
  };
  const live = {
    identity: { instances: (family: string) => rows[family] ?? [], driver: () => ({ perChat: o.perChat ?? true }) },
    accounts: {
      get: (id: string) => ({ id }),
      inChatLane: () => !o.otherLane,
      pinChat: (...a: any[]) => {
        calls.push(['pinChat', ...a]);
        if (o.pinFails) throw new Error('lane');
      },
    },
    claudeTurns: { setOwn: (...a: any[]) => calls.push(['setOwn', ...a]) },
  };
  return { calls, starts, live };
}
const project = { path: '/repo' };

test('a Claude Code chat picks a signed-in account; applied once the chat exists', async () => {
  const { calls, starts, live } = fakes();
  const shaped = await shapeStart({ live, starts, harness: 'claude', project, account: 'work', worktree: false });
  assert.equal(shaped.cwd, '/repo');
  assert.equal(shaped.worktreeOf, null);
  assert.deepEqual(calls, []);
  assert.equal(await startChat(starts, shaped, '/repo'), 'claude:1');
  assert.deepEqual(calls, [
    ['startClaude', '/repo', null],
    ['setOwn', 'claude:1', { account: 'work' }],
  ]);
});

test('an account that is signed out, unknown, or on a harness with no accounts is refused; the menu is absent, not faked', async () => {
  const { live, starts } = fakes();
  for (const [harness, account] of [
    ['claude', 'old'],
    ['claude', 'lapsed'],
    ['claude', 'nobody'],
    ['codex', 'c'],
    ['codex', 'work'],
    ['acp:fake', 'work'],
  ])
    await assert.rejects(shapeStart({ live, starts, harness, project, account, worktree: false }), /account isn't available/);
  await assert.rejects(
    shapeStart({ live: {}, starts, harness: 'claude', project, account: 'work', worktree: false }),
    /account isn't available/,
  );
  await assert.rejects(
    shapeStart({ live: { identity: {} }, starts, harness: 'claude', project, account: 'work', worktree: false }),
    /account isn't available/,
  );
});

test('a Codex chat picks a signed-in login; the pool pins the new thread to it, and a refused pin leaves the chat running', async () => {
  const { calls, starts, live } = fakes();
  const shaped = await shapeStart({ live, starts, harness: 'codex', project, account: 'b', worktree: false });
  assert.equal(await startChat(starts, shaped, '/repo'), 'thread-1');
  assert.deepEqual(calls, [
    ['startCodex', '/repo', null],
    ['pinChat', 'thread-1', 'b'],
  ]);
  const refused = fakes({ pinFails: true });
  const again = await shapeStart({ live: refused.live, starts: refused.starts, harness: 'codex', project, account: 'a', worktree: false });
  assert.equal(await startChat(refused.starts, again, '/repo'), 'thread-1');
});

test('loginsOf lists every login of a family with its sign-in state, and none for a family without logins', () => {
  const { live } = fakes();
  assert.deepEqual(loginsOf(live, 'claude'), [
    { id: 'work', label: 'Work', loggedIn: true, limited: false },
    { id: 'old', label: 'old', loggedIn: false, limited: false },
    { id: 'lapsed', label: 'Lapsed', loggedIn: false, limited: false },
  ]);
  assert.equal(loginsOf(live, 'codex').length, 3);
  assert.deepEqual(loginsOf(live, 'acp'), []);
  assert.deepEqual(loginsOf({}, 'claude'), []);
});

for (const [harness, method, args] of [
  ['codex', 'startCodex', ['/wt/1', '/repo']],
  ['claude', 'startClaude', ['/wt/1', '/repo']],
  ['acp:fake', 'startAcp', ['fake', '/wt/1', '/repo']],
] as const) {
  test(`${harness} starts in a worktree of its project, recorded as the worktree's origin`, async () => {
    const { calls, starts, live } = fakes();
    const shaped = await shapeStart({ live, starts, harness, project, account: undefined, worktree: true });
    assert.equal(shaped.cwd, '/wt/1');
    assert.equal(shaped.worktreeOf, '/repo');
    await startChat(starts, shaped, shaped.cwd);
    assert.deepEqual(calls, [
      ['newWorktree', '/repo', { what: 'a remote chat' }],
      [method, ...args],
    ]);
  });
}

test('a worktree needs a project that can hold one; a chat that then fails does not leave its worktree behind', async () => {
  await assert.rejects(shapeStart({ ...fakes(), harness: 'codex', project: null, account: undefined, worktree: true }), /Pick a project/);
  for (const worktree of [null, { unsupported: 'Not a Git repository' }])
    await assert.rejects(
      shapeStart({ ...fakes({ worktree }), harness: 'codex', project, account: undefined, worktree: true }),
      /worktree can't be made/,
    );
  const f = fakes({ fail: true });
  const shaped = await shapeStart({ live: f.live, starts: f.starts, harness: 'claude', project, account: undefined, worktree: true });
  await assert.rejects(startChat(f.starts, shaped, shaped.cwd), /no/);
  assert.deepEqual(f.calls.at(-1), ['discardWorktree', '/wt/1']);
  const plain = await shapeStart({ live: f.live, starts: f.starts, harness: 'claude', project, account: undefined, worktree: false });
  const before = f.calls.length;
  await assert.rejects(startChat(f.starts, plain, '/repo'), /no/);
  assert.equal(f.calls.filter((c) => c[0] === 'discardWorktree').length, 1);
  assert.ok(f.calls.length > before);
});

test('an account is refused before any chat exists when its agent cannot pin a chat now, or the login is billed another way', async () => {
  const noPin = fakes({ perChat: false });
  await assert.rejects(
    shapeStart({ live: noPin.live, starts: noPin.starts, harness: 'codex', project, account: 'a', worktree: false }),
    /can't put a chat on its own account now/,
  );
  const lane = fakes({ otherLane: true });
  await assert.rejects(
    shapeStart({ live: lane.live, starts: lane.starts, harness: 'codex', project, account: 'a', worktree: false }),
    /billed differently/,
  );
  // Claude Code has no lane rule, and a pool without the lane check accepts the login
  await shapeStart({ live: lane.live, starts: lane.starts, harness: 'claude', project, account: 'work', worktree: false });
  const bare = fakes();
  (bare.live.accounts as any).get = () => null;
  await shapeStart({ live: bare.live, starts: bare.starts, harness: 'codex', project, account: 'a', worktree: false });
  delete (bare.live.accounts as any).inChatLane;
  (bare.live.accounts as any).get = () => ({ id: 'a' });
  await shapeStart({ live: bare.live, starts: bare.starts, harness: 'codex', project, account: 'a', worktree: false });
  assert.deepEqual([...noPin.calls, ...lane.calls], [], 'nothing was made');
});
