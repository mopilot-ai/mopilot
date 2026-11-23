// src/store/core.ts batchStoreWrites + src/lib/streamNotifications.ts: a frame's held deltas for every chat reach the store as
// one commit (one pass of subscribers' selectors), with the reads, ordering and failure behaviour of separate writes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

installNative(fakeNative());
const { useStore, batchStoreWrites, patchRuntime, patchTurn, patchItem, patchStreamedItem, set, get } = await import(
  '../src/store/core.ts'
);
const { createStreamNotifications, setStreamBatch } = await import('../src/lib/streamNotifications.ts');
const { deletionVisibility } = await import('../src/store/deletionVisibility.ts');

const CHATS = Array.from({ length: 30 }, (_, i) => `c${i}`);
const DELTA = 'item/agentMessage/delta';
let commits = 0;
let selectorRuns = 0;
let off: () => void = () => {};

beforeEach(() => {
  off();
  useStore.setState({ runtime: {} });
  commits = 0;
  selectorRuns = 0;
  let last = get();
  // what React's subscribers do on every commit: run a selector over the state
  off = useStore.subscribe((s) => {
    commits++;
    selectorRuns++;
    last = s;
  });
  void last;
});

/** The delivery the app uses: a text delta extends the chat's item through the same helpers. */
function deliver(_method: string, params: Record<string, unknown>) {
  const chat = String(params.threadId);
  patchStreamedItem(chat, 't', 'i', { type: 'agentMessage', text: '' }, (it) => ({ ...it, text: `${it.text ?? ''}${params.delta}` }));
}

function streamFrame(rounds: number) {
  const paints: (() => void)[] = [];
  const stream = createStreamNotifications(deliver, (paint) => (paints.push(paint), () => {}));
  for (let r = 0; r < rounds; r++) for (const threadId of CHATS) stream.emit(DELTA, { threadId, turnId: 't', itemId: 'i', delta: `${r}.` });
  return { stream, paints };
}

test('30 chats streaming: one frame is one commit and one runtime clone (before: 30 commits)', () => {
  const { paints } = streamFrame(3);
  assert.equal(commits, 0, 'nothing is written before the paint');
  const runtimeBefore = get().runtime;
  paints[0]();
  assert.equal(commits, 1);
  assert.equal(selectorRuns, 1);
  const runtime = get().runtime;
  assert.notEqual(runtime, runtimeBefore, 'the published map is a new one');
  for (const c of CHATS) assert.equal((runtime[c].turns[0].items[0] as { text: string }).text, '0.1.2.', `${c} keeps its deltas in order`);
  // the next frame does not reach into the map the last commit published
  const published = get().runtime;
  const publishedChat = published.c0;
  streamFrame(1).paints[0]();
  assert.notEqual(get().runtime, published);
  assert.equal(published.c0, publishedChat, 'a published map is never changed in place');
  assert.equal(commits, 2);
});

test('writes inside a batch are read at once, committed once, in order', () => {
  const seen: unknown[] = [];
  batchStoreWrites(() => {
    set({ focused: false });
    seen.push(get().focused);
    set((s) => ({ focused: !s.focused }));
    seen.push(get().focused, useStore.getState().focused);
  });
  assert.deepEqual(seen, [false, true, true]);
  assert.equal(get().focused, true);
  assert.equal(commits, 1);
});

test('a replacing write inside a batch replaces the draft; a write that changes nothing commits nothing', () => {
  batchStoreWrites(() => {
    set((s) => s, false);
  });
  assert.equal(commits, 0);
  batchStoreWrites(() => undefined);
  assert.equal(commits, 0);
  const base = get();
  batchStoreWrites(() => {
    set({ ...base, focused: !base.focused }, true);
  });
  assert.equal(get().focused, !base.focused);
  assert.equal(commits, 1);
  set({ focused: base.focused });
});

test('a failing delivery still commits what was applied, and rethrows', () => {
  assert.throws(
    () =>
      batchStoreWrites(() => {
        patchRuntime('a', () => ({ loaded: true }));
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(get().runtime.a.loaded, true);
  assert.equal(commits, 1);
  // and the store is not left in batch mode
  set({ focused: !get().focused });
  assert.equal(commits, 2);
});

test('nested batches commit once, at the outermost end', () => {
  batchStoreWrites(() => {
    patchRuntime('a', () => ({ loaded: true }));
    batchStoreWrites(() => patchRuntime('b', () => ({ loaded: true })));
    assert.equal(commits, 0);
  });
  assert.equal(commits, 1);
  assert.deepEqual(Object.keys(get().runtime).sort(), ['a', 'b']);
});

test('another writer replacing the runtime map mid-batch is not mutated in place', () => {
  const outside = { z: { loaded: false } } as never;
  batchStoreWrites(() => {
    patchRuntime('a', () => ({ loaded: true }));
    set({ runtime: outside });
    patchRuntime('b', () => ({ loaded: true }));
  });
  assert.deepEqual(Object.keys(get().runtime).sort(), ['b', 'z']);
  assert.deepEqual(Object.keys(outside), ['z'], 'the map the other writer set keeps its keys');
});

test('without a batch registered, a flush delivers entry by entry', () => {
  setStreamBatch((run) => run());
  try {
    const { paints } = streamFrame(1);
    paints[0]();
    assert.equal(commits, CHATS.length);
  } finally {
    setStreamBatch(batchStoreWrites);
  }
});

test('patchItem replaces the last matching item from the end; an absent item leaves the list as it was', () => {
  patchTurn('p', 't', () => ({
    items: [
      { id: 'a', type: 'x' },
      { id: 'b', type: 'x' },
      { id: 'a', type: 'dup' },
    ] as never,
  }));
  patchItem('p', 't', 'a', (it) => ({ ...it, text: 'hit' }));
  const items = get().runtime.p.turns[0].items as { id: string; text?: string }[];
  assert.deepEqual(
    items.map((i) => i.text),
    [undefined, undefined, 'hit'],
    'the search starts at the end, as a delta extends the latest item',
  );
  const before = get().runtime.p.turns[0].items;
  patchItem('p', 't', 'missing', (it) => ({ ...it, text: 'no' }));
  assert.equal(get().runtime.p.turns[0].items, before);
});

test('deleted chats are filtered inside a batch, and the filter finds a deleted key without listing keys', () => {
  const receipt = { chatId: 'gone', nativeDeleted: true, metadata: 'retained', nativeKeys: ['gone'] };
  assert.deepEqual(deletionVisibility.accept(receipt), ['gone']);
  batchStoreWrites(() => {
    set({ pinned: { gone: true, kept: true } });
  });
  assert.deepEqual(Object.keys(get().pinned), ['kept']);
  set({ pinned: { kept: true } });
  assert.deepEqual(Object.keys(get().pinned), ['kept'], 'a map with no deleted key is passed through');
});
