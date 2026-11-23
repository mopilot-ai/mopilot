// Which Codex accounts the usage schedule counts as in use (electron/identity/contract/usageRefresh.cjs through
// electron/identity/codexAccounts.cjs): an account serving a chat, through the relay or the main app-server, is read as often
// as the active one, and a removed account leaves no schedule behind. Codex is faked (tests/support/electron-accounts.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sub, chatgptAuth } from './support/electron-accounts.ts';

const homes = { b: 'b@example.com', c: 'c@example.com' };

test('an account the relay serves a chat on, kept or newly placed, counts as used', (t) => {
  const { a } = setup(t, {
    state: { pool: 'spread', accounts: [sub('b', { limits: { used: 5 } }), sub('c', { limits: { used: 90 } })] },
    homes,
  });
  a.get('default').limits = { used: 60 };
  assert.equal(a.usageRefresh.hot('b', a.state.active), false);
  assert.equal(a.pickFor('fresh', new Set()).id, 'b');
  assert.equal(a.usageRefresh.hot('b', a.state.active), true);
  // a chat pinned to c that keeps its account marks c too
  a.pins.set('kept', { id: 'c', at: 0 });
  assert.equal(a.pickFor('kept', new Set()).id, 'c');
  assert.equal(a.usageRefresh.hot('c', a.state.active), true);
});

test('a turn on the main app-server marks the login it holds as used; one started mid-switch marks nobody', (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes });
  a.state.active = a.applied = 'b';
  a.onMainMessage({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
  assert.equal(a.usageRefresh.hot('b', 'default'), true);
  a.applied = 'default';
  a.onMainMessage({ method: 'turn/started', params: { threadId: 't2', turn: { id: 'u2' } } });
  assert.equal(a.usageRefresh.hot('default', 'b'), false);
});

test('a removed account leaves no backoff or activity behind', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] }, homes });
  a.readUsage = async () => {
    throw new Error('429 Too Many Requests');
  };
  await a.refreshUsage(['b'], 'now');
  a.usageRefresh.used('b');
  assert.notEqual(a.usageRefresh.retryAt('b'), null);
  await a.remove('b');
  assert.equal(a.usageRefresh.retryAt('b'), null);
  assert.equal(a.usageRefresh.hot('b', null), false);
});

test("the CLI's own login replaced in a terminal is read at once and announced on the next tick, even with nothing due", async (t) => {
  const { a, codexHome } = setup(t, {
    state: { active: 'default', accounts: [{ id: 'default', kind: 'chatgpt', chatgptAccountId: 'acct-default', email: 'a@example.com' }] },
  });
  const reads: string[] = [];
  a.readUsage = async (row: any) => (reads.push(row.id), { rateLimits: { primary: { usedPercent: 10 } } });
  await a.refreshUsage(undefined, 'now');
  let changes = 0;
  a.changed = () => changes++;
  await a.refreshUsage();
  assert.deepEqual([reads, changes], [['default'], 0], 'nothing due and nothing new: no broadcast');
  // another login in the CLI's folder: its usage is not the old one's, and the view says who it is now
  chatgptAuth(codexHome, 'other@example.com', 'acct-other');
  await a.refreshUsage();
  assert.deepEqual(reads, ['default', 'default']);
  assert.equal(a.get('default').email, 'other@example.com');
  assert.equal(changes, 1);
  // the CLI signed out: nothing to read, but the view changed
  a.readUsage = async () => assert.fail('nothing to read');
  (await import('node:fs')).rmSync((await import('node:path')).join(codexHome, 'auth.json'));
  await a.refreshUsage();
  assert.equal(changes, 2);
});
