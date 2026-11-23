// A phone puts an open chat on one login of its agent, or back on the agent's own choice: the pin each harness holds, what is refused, and the method through the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createChatAccount } = require('../electron/app/chromePanelChatAccount.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r.result));
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};

function world(perChat: Record<string, boolean> = { claude: true, codex: true }) {
  const calls: any[][] = [];
  const logins: Record<string, any[]> = {
    claude: [
      { account: 'work', label: 'Work', status: 'ok' },
      { account: 'old', label: 'Old', status: 'signedOut' },
    ],
    codex: [{ account: 'a', label: 'a@x.com', status: 'ok' }],
  };
  const live: any = {
    identity: { instances: (f: string) => logins[f] ?? [], driver: (f: string) => ({ perChat: perChat[f] }) },
    chats: { patchMeta: (...a: any[]) => calls.push(['patchMeta', ...a]), get: (id: string) => ({ id }) },
    claudeTurns: { setOwn: (...a: any[]) => calls.push(['setOwn', ...a]) },
    accounts: { pinChat: (...a: any[]) => calls.push(['pinChat', ...a]) },
    controller: { ref: (id: string) => ({ key: `thread-of-${id}` }) },
  };
  const kinds: Record<string, string> = { c1: 'claude', c2: 'codex', c3: 'acp:kimi' };
  const set = createChatAccount({
    live,
    kindOf: (id: string) => kinds[id] ?? null,
    labelOf: (k: string | null) => (k === 'codex' ? 'Codex' : k === 'claude' ? 'Claude Code' : k ? 'Kimi' : null),
    broadcast: (...a: any[]) => calls.push(['broadcast', ...a]),
  });
  return { set, calls };
}

test('Claude Code: a login is pinned in the chat’s file and its session; null gives the choice back; both reach the windows', () => {
  const w = world();
  assert.deepEqual(w.set({ chatId: 'c1', account: 'work' }), { chatId: 'c1', account: 'work', pinned: true });
  assert.deepEqual(w.calls, [
    ['patchMeta', 'c1', { account: { id: 'work', pinned: true } }],
    ['setOwn', 'c1', { account: 'work' }],
    ['broadcast', 'chats:changed', { id: 'c1', chat: { id: 'c1' } }],
  ]);
  const back = world();
  assert.deepEqual(back.set({ chatId: 'c1', account: null }), { chatId: 'c1', account: null, pinned: false });
  assert.deepEqual(back.calls.slice(0, 2), [
    ['patchMeta', 'c1', { account: null }],
    ['setOwn', 'c1', { account: null }],
  ]);
});

test('Codex: the pool pins the chat’s thread; Automatic releases it', () => {
  const w = world();
  w.set({ chatId: 'c2', account: 'a' });
  w.set({ chatId: 'c2', account: null });
  assert.deepEqual(
    w.calls.filter((c) => c[0] === 'pinChat'),
    [
      ['pinChat', 'thread-of-c2', 'a'],
      ['pinChat', 'thread-of-c2', null],
    ],
  );
});

test('refused with a reason: a signed-out or unknown login, an agent without accounts, a harness that cannot pin now, an unknown chat kind', () => {
  const w = world({ claude: true, codex: false, 'acp:kimi': true } as any);
  assert.throws(() => w.set({ chatId: 'c1', account: 'old' }), /isn't available/);
  assert.throws(() => w.set({ chatId: 'c1', account: 'nobody' }), /isn't available/);
  assert.throws(() => w.set({ chatId: 'c2', account: 'a' }), /Codex can't put a chat on its own account now/);
  assert.throws(() => w.set({ chatId: 'c3', account: null }), /Kimi has no accounts/);
  assert.throws(() => w.set({ chatId: 'zzz', account: null }), /This agent has no accounts/);
  assert.deepEqual(w.calls, [], 'a refused change touches nothing');
});

test('chat.account through the service: params checked, a chat main does not know is gone, an older Mac says so', async () => {
  const seen: any[] = [];
  const r = rig({
    ops: {
      reachable: (id: string) => id !== 'gone',
      setChatAccount: (p: any) => (seen.push(p), { chatId: p.chatId, account: p.account, pinned: !!p.account }),
    },
  });
  const p = r.phone('p1');
  assert.deepEqual(ok(await p.ask('chat.account', { chatId: 'c1', account: 'work' })), { chatId: 'c1', account: 'work', pinned: true });
  assert.deepEqual(ok(await p.ask('chat.account', { chatId: 'c1' })), { chatId: 'c1', account: null, pinned: false });
  assert.deepEqual(seen, [
    { chatId: 'c1', account: 'work' },
    { chatId: 'c1', account: null },
  ]);
  fail(await p.ask('chat.account', { chatId: 'c1', account: 'bad id!' }), 'invalid');
  fail(await p.ask('chat.account', { chatId: 'gone', account: null }), 'gone');
  const old = rig({ ops: { reachable: () => true } });
  fail(await old.phone('p1').ask('chat.account', { chatId: 'c1', account: null }), 'failed', /Update MoPilot/);
  const refusing = rig({
    ops: {
      reachable: () => true,
      setChatAccount: () => {
        throw new Error('Codex has no accounts.');
      },
    },
  });
  fail(await refusing.phone('p1').ask('chat.account', { chatId: 'c1', account: null }), 'invalid', /has no accounts/);
  const odd = rig({
    ops: {
      reachable: () => true,
      setChatAccount: () => {
        throw 'boom';
      },
    },
  });
  fail(await odd.phone('p1').ask('chat.account', { chatId: 'c1', account: null }), 'invalid', /Could not change the account/);
});

test('the dev host’s fake app answers it, for a phone tested against it', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const logs: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: (l: string) => void logs.push(l),
    now: () => 1,
    sleep: async () => undefined,
    status: async () => '',
  });
  assert.deepEqual(app.ops.setChatAccount({ chatId: 'c', account: 'work' }), { chatId: 'c', account: 'work', pinned: true });
  assert.deepEqual(app.ops.setChatAccount({ chatId: 'c', account: null }), { chatId: 'c', account: null, pinned: false });
  assert.match(logs.join('\n'), /c on work[\s\S]*own choice/);
});

test('the dev host’s menus offer stand-in logins, and a chat’s pin shows in its next menu', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const fresh = await app.ops.options({ harness: 'claude' });
  assert.deepEqual(
    fresh.accounts.map((a: any) => [a.id, a.loggedIn]),
    [
      ['work', true],
      ['personal', true],
      ['old', false],
      ['spare', true],
    ],
  );
  assert.equal('account' in fresh, false);
  const open = await app.ops.options({ chatId: 'c' });
  assert.deepEqual([open.perChat, open.account], [true, { id: null, pinned: false, serving: 'Work' }]);
  app.ops.setChatAccount({ chatId: 'c', account: 'personal' });
  assert.deepEqual((await app.ops.options({ chatId: 'c' })).account, { id: 'personal', pinned: true, serving: 'Personal' });
  app.ops.setChatAccount({ chatId: 'c', account: 'gone' });
  assert.equal((await app.ops.options({ chatId: 'c' })).account?.serving, null);
});

test('a login picked on New chat is the new chat’s pin in the dev host', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const { chatId } = await app.ops.start({ harness: 'claude', text: 'go', account: 'personal', attachments: [] });
  assert.deepEqual((await app.ops.options({ chatId })).account, { id: 'personal', pinned: true, serving: 'Personal' });
  const { chatId: plain } = await app.ops.start({ harness: 'claude', text: 'go', attachments: [] });
  assert.equal((await app.ops.options({ chatId: plain })).account?.pinned, false);
});

test('the dev host’s request line leads with the new chat’s harness and the login it picked (an id), so the cut never takes it', async () => {
  const { requestLine } = await import('../scripts/mobile-dev-host/format.mjs');
  const long = 'x'.repeat(200);
  const line = requestLine('p_abcdef', 'chat.start', {
    text: long,
    startId: 'start-1',
    attachments: [],
    harness: 'claude',
    account: 'personal',
    credential: { source: 'key' },
  });
  assert.match(line, /chat\.start \{"harness":"claude","account":"personal","credential":\{"source":"key"\}/);
  assert.doesNotMatch(requestLine('p_abcdef', 'chat.start', { text: 'go', harness: 'claude' }), /account/);
  assert.match(requestLine('p_abcdef', 'chat.start', undefined), /chat\.start \{\}/);
  assert.match(requestLine('p_abcdef', 'chats.recent', { limit: 1 }), /chats\.recent \{"limit":1\}/);
});
