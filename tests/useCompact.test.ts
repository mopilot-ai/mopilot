// Context compaction state follows main's queue and isolates pending requests by chat and invocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeStore, render, settle } from './support/shell-panels-kit';
import { mockContextModules } from './support/context-kit';
import { deferred } from './support/async-scenarios';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
const { useCompact } = await import('../src/components/context/useCompact');
let action: ReturnType<typeof useCompact>;
function Probe({ id = 'a', running = false }: { id?: string; running?: boolean }) {
  action = useCompact(id, running);
  return h('span', null, action.label);
}
function reset() {
  store.set({ runtime: {}, segments: {} });
  Object.assign(ctx, {
    blocked: null,
    compactCap: 'native',
    turn: 'idle',
    queue: [],
    compaction: null,
    activeTurn: null,
    compactWait: Promise.resolve(),
    compactReceipt: { action: 'started', id: 'compact' },
  });
  ctx.compacted.length = 0;
}

test('the shared hook refuses blocked, queued and already compacting actions at execution', async () => {
  reset();
  ctx.blocked = 'Unavailable';
  const r = await render(h(Probe));
  await act(() => action.compact());
  assert.deepEqual(ctx.compacted, []);
  ctx.blocked = null;
  ctx.queue = [{ opts: { compact: { args: '' } } }];
  await r.rerender(h(Probe));
  assert.equal(action.queued, true);
  await act(() => action.compact());
  ctx.queue = [];
  ctx.compaction = 'active';
  await r.rerender(h(Probe));
  assert.equal(action.compacting, true);
  await act(() => action.compact());
  assert.deepEqual(ctx.compacted, []);
  await r.unmount();
});

test('manual compaction stays active on a second surface and after remount until main ends the turn', async () => {
  reset();
  ctx.activeTurn = { id: 'at-native', human: true, compact: true };
  const first = await render(h(Probe, { running: true }));
  assert.equal(action.label, 'Compacting…');
  await act(() => action.compact());
  const second = await render(h(Probe, { running: true }));
  assert.equal(action.label, 'Compacting…');
  await act(() => action.compact());
  await first.unmount();
  const reopened = await render(h(Probe, { running: true }));
  assert.equal(action.label, 'Compacting…');
  assert.deepEqual(ctx.compacted, []);
  ctx.activeTurn = null;
  await reopened.rerender(h(Probe));
  assert.equal(action.label, 'Compact now');
  await second.unmount();
  await reopened.unmount();
});

test('a queued or refused receipt cannot claim a later empty turn as its own compaction', async () => {
  for (const receipt of [{ action: 'queued', id: 'q' }, undefined]) {
    reset();
    ctx.compactReceipt = receipt;
    const r = await render(h(Probe));
    await act(() => action.compact());
    await settle(act);
    await act(() => store.set({ runtime: { a: { turns: [{ id: 'later', status: 'inProgress', items: [] }] } } }));
    await r.rerender(h(Probe, { running: true }));
    assert.equal(action.compacting, false);
    assert.equal(action.label, 'Compact after turn');
    await r.unmount();
  }
});

for (const oldOutcome of ['success', 'failure', 'queued', 'refused']) {
  test(`an old ${oldOutcome} cannot clear another chat's pending compaction`, async () => {
    reset();
    const old = deferred<void>();
    const next = deferred<void>();
    ctx.compactWait = old.promise;
    const r = await render(h(Probe));
    await act(() => action.compact());
    assert.equal(action.compacting, true);
    await r.rerender(h(Probe, { id: 'b' }));
    assert.equal(action.compacting, false);
    ctx.compactWait = next.promise;
    await act(() => action.compact());
    assert.equal(action.compacting, true);
    if (oldOutcome === 'queued') ctx.compactReceipt = { action: 'queued', id: 'old' };
    if (oldOutcome === 'refused') ctx.compactReceipt = undefined;
    await act(() => (oldOutcome === 'failure' ? old.reject(new Error('old failure')) : old.resolve()));
    await settle(act);
    assert.equal(action.compacting, true);
    ctx.compactReceipt = { action: 'started', id: 'new' };
    await act(() => next.resolve());
    await settle(act);
    assert.equal(action.compacting, false);
    assert.deepEqual(ctx.compacted, ['a', 'b']);
    await r.unmount();
  });
}
