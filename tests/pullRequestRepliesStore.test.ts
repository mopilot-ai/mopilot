// Main's store of the sidebar PR badges' replies (electron/app/ipc/pullRequestReplies.cjs): kept by chat and history
// version across launches, bounded in size, written a few seconds after a change and at quit, and a deleted chat's go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const {
  SavedReplies,
  register,
  cleanReplies,
  MAX_BYTES,
  MAX_ENTRY_BYTES,
  WRITE_MS,
} = require('../electron/app/ipc/pullRequestReplies.cjs');

const reply = (text: string, extra = {}) => ({ status: 'completed', items: [{ type: 'agentMessage', text, phase: null, ...extra }] });

/** A store over an in-memory file whose timers run when the test says. */
function harness(initial: unknown = null) {
  const file = { saved: initial as unknown, writes: 0, asyncWrites: [] as { data: string; current: () => boolean }[] };
  const timers: (() => void)[] = [];
  const store = new SavedReplies({
    file: () => '/u/pull-request-replies.json',
    io: {
      readFile: () => file.saved,
      write: (_f: string, data: string) => {
        file.writes++;
        file.saved = JSON.parse(data);
      },
      writeAsync: async (_f: string, data: string, current: () => boolean) => {
        file.asyncWrites.push({ data, current });
        file.saved = JSON.parse(data);
      },
      setTimer: (fn: () => void, ms: number) => {
        assert.equal(ms, WRITE_MS);
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    },
  });
  const tick = () => timers.splice(0).forEach((fn) => fn());
  return { store, file, timers, tick };
}

test('replies are kept by chat and version, survive a launch, and only their read fields are kept', () => {
  const h = harness();
  assert.equal(h.store.get('a', 'v1'), null);
  assert.equal(h.store.put('a', 'v1', [reply('Opened PR #1.', { id: 'item-1', extra: 'x' })]), true);
  assert.deepEqual(h.store.get('a', 'v1'), [reply('Opened PR #1.')]);
  assert.equal(h.store.get('a', 'v2'), null, 'another version of the chat is read again');
  assert.equal(h.timers.length, 1, 'one write is scheduled for many changes');
  h.store.put('b', 'v1', []);
  assert.equal(h.timers.length, 1);
  h.tick();
  assert.equal(h.file.asyncWrites.length, 1);
  // the next launch loads what was written
  const next = harness(h.file.saved);
  assert.deepEqual(next.store.get('a', 'v1'), [reply('Opened PR #1.')]);
  assert.deepEqual(next.store.get('b', 'v1'), []);
});

test('what is not replies, or too long to keep, is not kept and drops what the chat had', () => {
  const h = harness();
  for (const bad of [
    null,
    {},
    [null],
    [{ status: 'failed', items: [] }],
    [{ status: 'completed' }],
    [{ status: 'completed', items: [{ text: 'x' }] }],
    [{ status: 'completed', items: [{ type: 'agentMessage', text: 3 }] }],
  ])
    assert.equal(cleanReplies(bad), null);
  assert.deepEqual(cleanReplies([{ status: 'completed', items: [{ type: 'agentMessage' }] }]), [
    { status: 'completed', items: [{ type: 'agentMessage', text: undefined, phase: null }] },
  ]);
  assert.deepEqual(cleanReplies([{ ...reply('Opened PR #1.'), completedAt: Number.NaN }]), [reply('Opened PR #1.')]);
  assert.equal(h.store.put('a', 'v1', [reply('Opened PR #1.', { phase: 'final' })]), true);
  assert.deepEqual(h.store.get('a', 'v1'), [reply('Opened PR #1.', { phase: 'final' })]);
  h.tick();
  assert.equal(h.store.put('a', 'v2', [reply('x'.repeat(MAX_ENTRY_BYTES))]), false);
  assert.equal(h.store.get('a', 'v1'), null, "the chat's older replies went with it");
  assert.equal(h.timers.length, 1, 'dropping what the chat had is written');
  h.tick();
  // nothing kept and nothing had: nothing written
  assert.equal(h.store.put('c', 'v1', 'nonsense'), false);
  assert.equal(h.timers.length, 0);
});

test('past the file budget the chat shown least recently goes, and a saved file that is not the store loads empty', () => {
  const h = harness({ v: 1, chats: { ok: { version: 'v1', replies: [] }, bad: { replies: [] }, '': { version: 'v1', replies: [] } } });
  assert.deepEqual(h.store.get('ok', 'v1'), []);
  assert.equal(h.store.get('bad', undefined), null);
  const big = [reply('y'.repeat(MAX_ENTRY_BYTES - 200))];
  // one more than fit: exactly one chat goes
  const count = Math.floor(MAX_BYTES / (Buffer.byteLength(JSON.stringify(cleanReplies(big))) + 1)) + 1;
  for (let i = 0; i < count; i++) {
    h.store.put(`c${i}`, 'v', big);
    // c0 is shown again, so c1 is the one shown least recently
    if (i === 1) h.store.get('c0', 'v');
  }
  assert.ok(h.store.get('c0', 'v'), 'a chat shown recently stays');
  assert.equal(h.store.get('c1', 'v'), null, 'the chat shown least recently went');
  assert.ok(h.store.total <= MAX_BYTES);
  for (const saved of [null, { v: 2, chats: { a: { version: 'v', replies: [] } } }, { v: 1 }, { v: 1, chats: 'x' }])
    assert.equal(harness(saved).store.get('a', 'v'), null);
});

test('a deleted chat is forgotten and written; a quit writes what is pending at once, and nothing when nothing is', () => {
  const h = harness();
  h.store.forget('nobody');
  assert.equal(h.timers.length, 0);
  h.store.put('a', 'v1', [reply('Opened PR #4.')]);
  h.tick();
  h.store.forget('a');
  assert.equal(h.store.get('a', 'v1'), null);
  assert.equal(h.timers.length, 1);
  h.store.flush();
  assert.equal(h.file.writes, 1);
  assert.deepEqual(h.file.saved, { v: 1, chats: {} });
  h.store.flush();
  assert.equal(h.file.writes, 1, 'nothing pending: nothing written');
  // a write already on its way is outdated by the quit's
  h.store.put('b', 'v1', []);
  h.tick();
  const onItsWay = h.file.asyncWrites.at(-1)!;
  assert.equal(onItsWay.current(), true);
  h.store.put('c', 'v1', []);
  h.store.flush();
  assert.equal(onItsWay.current(), false);
});

test('failed writes are noted, not thrown', async (t) => {
  t.mock.method(console, 'debug', () => {});
  clearIgnored();
  const timers: (() => void)[] = [];
  const store = new SavedReplies({
    file: () => '/u/f.json',
    io: {
      readFile: () => null,
      write: () => {
        throw new Error('read-only');
      },
      writeAsync: () => Promise.reject(new Error('disk full')),
      setTimer: (fn: () => void) => (timers.push(fn), 1),
      clearTimer: () => {},
    },
  });
  store.put('a', 'v', []);
  timers.shift()!();
  await new Promise((r) => setImmediate(r));
  store.put('b', 'v', []);
  assert.doesNotThrow(() => store.flush());
  const said = recentIgnored().map((e: any) => JSON.stringify(e));
  assert.equal(said.filter((m: string) => m.includes("save the PR badges' replies")).length, 2, said.join('\n'));
});

test('the IPC answers valid requests, forgets a deleted chat, writes at quit, and needs the chat deletion made first', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const ipcMain = { handle: (channel: string, fn: (...a: any[]) => any) => handlers.set(channel, fn) };
  const quit: (() => void)[] = [];
  const app = { getPath: () => '/u', on: (event: string, fn: () => void) => event === 'will-quit' && quit.push(fn) };
  const deletion: { onDeleted?: (r: { chatId: string }) => void } = {};
  const h = harness();
  assert.equal(register(ipcMain, { app, live: { chatDeletion: deletion } }, h.store), h.store);
  const save = handlers.get('pullRequests:saveReplies')!;
  const get = handlers.get('pullRequests:savedReplies')!;
  assert.equal(save({}, 'a', 'v1', [reply('Opened PR #5.')]), true);
  assert.deepEqual(get({}, 'a', 'v1'), [reply('Opened PR #5.')]);
  for (const [id, version] of [
    ['', 'v1'],
    ['a', ''],
    [3, 'v1'],
    ['a', 'x'.repeat(513)],
  ]) {
    assert.equal(get({}, id, version), null);
    assert.equal(save({}, id, version, []), false);
  }
  deletion.onDeleted!({ chatId: 'a' });
  assert.equal(get({}, 'a', 'v1'), null);
  quit[0]();
  assert.equal(h.file.writes, 1);
  // the default store lives in userData
  const real = register({ handle: () => {} }, { app, live: { chatDeletion: {} } });
  assert.equal(real.file(), '/u/pull-request-replies.json');
  assert.throws(() => register(ipcMain, { app, live: {} }, h.store), /after ipc\/chats/);
});

test('main registers ipc/chats, which makes the chat deletion, before this module', () => {
  const { listIpcModules } = require('../electron/app/ipc/modules.cjs');
  const names: string[] = listIpcModules().map((m: { name: string }) => m.name);
  assert.ok(names.indexOf('chats') >= 0 && names.indexOf('chats') < names.indexOf('pullRequestReplies'), names.join(', '));
});
