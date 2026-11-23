// Codex display deltas join per frame (src/store/notifications.ts), commits stay bounded, and reopening a chat keeps its turn objects (src/store/threads.ts).
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const { flushStreamNotifications } = await import('../src/store/notifications.ts');
const { reuseTurn, sameValue } = await import('../src/store/turnReuse.ts');
const st = () => S.useStore.getState();
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
const items = (chat: string, turn = 0) => st().runtime[chat].turns[turn].items as any[];
const serverTurn = (id: string, o: any = {}) => ({
  id,
  status: 'completed',
  items: [{ id: `${id}-m`, type: 'agentMessage', text: `reply ${id}` }],
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
  error: null,
  ...o,
});

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

function commits(fn: () => void) {
  let n = 0;
  const stop = S.useStore.subscribe(() => n++);
  fn();
  flushStreamNotifications();
  stop();
  return n;
}

test('hundreds of deltas across chats and items cost one commit in a frame, with the same text', () => {
  const T = { turnId: 'T' };
  const n = commits(() => {
    for (let i = 0; i < 200; i++) {
      note('item/agentMessage/delta', { ...T, threadId: 'a', itemId: 'm', delta: `${i},` });
      note('item/commandExecution/outputDelta', { ...T, threadId: 'a', itemId: 'cmd', delta: `o${i};` });
      note('item/agentMessage/delta', { ...T, threadId: 'b', itemId: 'm', delta: `${i}.` });
    }
  });
  // each (chat, item) is one patch, and the frame's patches are one store commit (before: one commit per patch, 3 here)
  assert.equal(n, 1);
  const want = (sep: string) => Array.from({ length: 200 }, (_, i) => `${i}${sep}`).join('');
  assert.equal(items('a')[0].text, want(','));
  assert.equal(items('b')[0].text, want('.'));
});

test('long command output is joined once per frame and keeps the order of its pieces', () => {
  note('item/started', { threadId: 'a', turnId: 'T', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: '' } });
  const pieces = Array.from({ length: 500 }, (_, i) => `line ${i}\n`);
  const n = commits(() => {
    for (const p of pieces) note('item/commandExecution/outputDelta', { threadId: 'a', turnId: 'T', itemId: 'cmd', delta: p });
  });
  assert.equal(n, 1);
  assert.equal(items('a')[0].aggregatedOutput, pieces.join(''));
});

test('a notification that is not a delta first delivers the text held before it, so the transcript keeps its order', () => {
  note('item/agentMessage/delta', { threadId: 'a', turnId: 'T', itemId: 'm', delta: 'before ' });
  assert.equal(st().runtime.a, undefined, 'held for the frame');
  note('item/completed', { threadId: 'a', turnId: 'T', item: { id: 'tool', type: 'commandExecution', status: 'completed' } });
  assert.deepEqual(
    items('a').map((i) => [i.id, i.text]),
    [
      ['m', 'before '],
      ['tool', undefined],
    ],
  );
  note('item/agentMessage/delta', { threadId: 'a', turnId: 'T', itemId: 'm', delta: 'after' });
  flushStreamNotifications();
  assert.equal(items('a')[0].text, 'before after');
});

test('held deltas show up on their own after a frame, and a non-notification event flushes them too', () => {
  note('item/agentMessage/delta', { threadId: 'a', turnId: 'T', itemId: 'm', delta: 'x' });
  mock.timers.tick(100);
  assert.equal(items('a')[0].text, 'x');
  note('item/agentMessage/delta', { threadId: 'a', turnId: 'T', itemId: 'm', delta: 'y' });
  listeners['codex.onItem']({ kind: 'lease', threadId: 'a', held: true });
  assert.equal(items('a')[0].text, 'xy');
});

test('opening a loaded chat again keeps every turn object the read did not change', async () => {
  const id = 'reopen';
  impl['api.threadRead'] = async () => ({ thread: { id, updatedAt: 5, status: { type: 'active', activeFlags: [] } } });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t2'), serverTurn('t1')], nextCursor: null });
  await S.openThread(id);
  const first = st().runtime[id].turns;
  assert.deepEqual(
    first.map((t) => t.id),
    ['t1', 't2'],
  );
  // t2 changed on disk, t1 did not
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t2', { items: [] }), serverTurn('t1')], nextCursor: null });
  await S.openThread(id);
  const again = st().runtime[id].turns;
  assert.equal(again[0], first[0], 'unchanged turn keeps its object');
  assert.notEqual(again[1], first[1]);
  assert.equal(again[1].items.length, 0);
});

test('a loaded idle chat whose details are unchanged is not read again; a changed one is', async () => {
  const id = 'quiet';
  let updatedAt = 7;
  impl['api.threadRead'] = async () => ({ thread: { id, updatedAt, status: { type: 'idle' } } });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t1')], nextCursor: null });
  await S.openThread(id);
  assert.equal(callsOf('api.threadTurns').length, 1);
  const shown = st().runtime[id].turns;
  await S.openThread(id);
  assert.equal(callsOf('api.threadTurns').length, 1, 'nothing changed, so the turns are not read');
  assert.equal(st().runtime[id].turns, shown);
  updatedAt = 8;
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t1', { status: 'failed' })], nextCursor: null });
  await S.openThread(id);
  assert.equal(callsOf('api.threadTurns').length, 2);
});

test('details refreshed by a lease or the list do not stand in for a turns read', async () => {
  const id = 'leased';
  let updatedAt = 3;
  impl['api.threadRead'] = async () => ({ thread: { id, updatedAt, status: { type: 'idle' } } });
  impl['api.threadTurns'] = async () => ({ data: [serverTurn('t1')], nextCursor: null });
  await S.openThread(id);
  // another app wrote the chat; a lease then stored its new details without reading the turns
  updatedAt = 9;
  st().threads[id] && S.useStore.setState({ threads: { ...st().threads, [id]: { ...st().threads[id], updatedAt: 9 } } });
  await S.openThread(id);
  assert.equal(callsOf('api.threadTurns').length, 2);
});

test('a blocked hook run lands as a note after the text held before it', () => {
  note('item/agentMessage/delta', { threadId: 'h', turnId: 'T', itemId: 'm', delta: 'text' });
  note('hook/completed', { threadId: 'h', turnId: 'T', run: { id: 'r1', eventName: 'preToolUse', status: 'blocked', entries: [] } });
  assert.deepEqual(
    items('h').map((i) => i.id),
    ['m', 'hook-r1'],
  );
  // a run with nothing to show adds nothing
  note('hook/completed', { threadId: 'h', turnId: 'T', run: { id: 'r2', eventName: 'preToolUse', status: 'completed', entries: [] } });
  assert.equal(items('h').length, 2);
});

test('turn reuse compares what the read carries, not what this window added', () => {
  const shown: any = { ...serverTurn('t'), diff: undefined, itemTimes: { m: { start: 1 } } };
  assert.equal(reuseTurn(shown, { ...serverTurn('t'), diff: undefined, itemTimes: {} } as any), shown);
  const changed: any = { ...serverTurn('t'), status: 'failed', itemTimes: {} };
  assert.equal(reuseTurn(shown, changed), changed);
  assert.equal(reuseTurn(undefined, changed), changed);
  assert.equal(sameValue([1, { a: 1 }], [1, { a: 1 }]), true);
  assert.equal(sameValue([1], { 0: 1 }), false);
  assert.equal(sameValue({ a: 1 }, { b: 1 }), false);
  assert.equal(sameValue({ a: 1 }, null), false);
  assert.equal(sameValue({ a: 1, b: 2 }, { a: 1 }), false);
});
