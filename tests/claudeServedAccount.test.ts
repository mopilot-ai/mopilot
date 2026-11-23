// Main keeps the login a Claude chat's turn ran on (electron/session/adapterSettings.cjs served), as it keeps a move: a window only hears it, so no echo of an older login undoes a newer move (#2538).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { adapterSettings, servedOn } = require('../electron/session/adapterSettings.cjs');

/** A chat store with the two calls adapterSettings makes; a missing record reads empty, as ChatsStore.record does. */
function liveChats() {
  const records = new Map<string, any>();
  const writes: any[] = [];
  const chats = {
    records,
    record: (id: string) => records.get(id) ?? { id, meta: { account: null, notes: [] } },
    patchMeta: (id: string, patch: any) => {
      writes.push([id, patch]);
      const rec = chats.record(id);
      records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
      return true;
    },
  };
  return { live: { chats }, writes, account: (id: string) => chats.record(id).meta.account };
}

test('a turn on an unpinned chat moves it to that login; a pinned chat keeps its pin and notes where the turn ran', () => {
  assert.deepEqual(servedOn(undefined, 'a'), { id: 'a', pinned: false });
  assert.deepEqual(servedOn(null, 'a'), { id: 'a', pinned: false });
  assert.equal(servedOn({ id: 'a', pinned: false }, 'a'), null);
  assert.deepEqual(servedOn({ id: 'a', pinned: false }, 'b'), { id: 'b', pinned: false });
  assert.deepEqual(servedOn({ id: 'w', pinned: true }, 'h'), { id: 'w', pinned: true, serving: 'h' });
  assert.equal(servedOn({ id: 'w', pinned: true, serving: 'h' }, 'h'), null);
  assert.deepEqual(servedOn({ id: 'w', pinned: true, serving: 'h' }, 'w'), { id: 'w', pinned: true });
  assert.equal(servedOn({ id: 'w', pinned: true }, 'w'), null);
  // an older record without pinned reads as unpinned
  assert.equal(servedOn({ id: 'a' }, 'a'), null);
});

test('main writes the login a turn started on, only when it changes, and ignores a turn without one', () => {
  const t = liveChats();
  const { served } = adapterSettings(t.live);
  served('claude:x', 'a');
  assert.deepEqual(t.account('claude:x'), { id: 'a', pinned: false });
  served('claude:x', 'a');
  served('claude:x', null);
  served('claude:x', '');
  assert.equal(t.writes.length, 1);
  t.live.chats.records.set('claude:p', { id: 'claude:p', meta: { account: { id: 'w', pinned: true }, notes: [] } });
  served('claude:p', 'h');
  assert.deepEqual(t.account('claude:p'), { id: 'w', pinned: true, serving: 'h' });
});

test('two quick moves and the turns between them end on the newest login, whatever order the windows hear them in (#2538)', () => {
  const t = liveChats();
  const { moved, served } = adapterSettings(t.live);
  const note = (id: string) => ({ id, kind: 'account', text: id });
  served('claude:x', 'a');
  // a limit hit moves the chat A→B, a turn starts on B, a second limit moves it B→C
  moved('claude:x', { account: 'b', note: note('n1') });
  served('claude:x', 'b');
  moved('claude:x', { account: 'c', note: note('n2') });
  // every write is main's own: no window patch carries an account, so nothing written after C names B
  assert.deepEqual(t.account('claude:x'), { id: 'c', pinned: false });
  assert.deepEqual(
    t.writes.map(([, p]) => p.account.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    t.live.chats.record('claude:x').meta.notes.map((n: any) => n.id),
    ['n1', 'n2'],
  );
});

test("a window's late push of an older login never overrides the one main moved the chat to (#2538)", () => {
  const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
  const { SessionStore } = require('../electron/session/state.cjs');
  const t = liveChats();
  const settings = adapterSettings(t.live);
  const login = (id: string) => ({ id, email: `${id}@example.test`, authMethod: 'claude.ai', loggedIn: true });
  const a = new ClaudeAdapter({
    api: { accounts: () => ({ active: 'a', autoSwitch: true, accounts: [login('a'), login('b'), login('c')] }) },
    state: new SessionStore(),
    prefs: () => ({}),
    send: async () => ({ elsewhere: [] }),
    enqueue: () => {},
    chatOf: (k: string) => k,
    ref: (c: string) => ({ kind: 'claude', id: c, key: c }),
    ...settings,
  });
  settings.moved('claude:x', { account: 'b', note: { id: 'n1' } });
  settings.moved('claude:x', { account: 'c', note: { id: 'n2' } });
  // the window heard B and pushes it after main moved on to C
  a.setOwn('claude:x', { account: 'b' });
  assert.equal(a.pickOf('claude:x'), 'c');
  assert.equal(a.accountOf('claude:x'), 'c');
});
