// First-breakdown feedback with reported usage, empty answers and overlapping reads follows the current owner's latest request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeStore, render, one } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { deferred } from './support/async-scenarios.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
const { ContextPanel } = await import('../src/components/context/ContextPanel.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
const owner = ownerOf('chat', 'claude', 'native');
function reset(runtime: any = { turns: [] }) {
  resetContextSnapshots();
  store.set({ runtime: { chat: runtime }, segments: { chat: [{ harness: 'claude', nativeId: 'native' }] } });
  ctx.asks.length = 0;
  ctx.ignored.length = 0;
}

test('reported totals remain visible through the first breakdown wait, null/rejection and successful retry', async () => {
  for (const reject of [false, true]) {
    reset({ turns: [], tokenUsage: { last: { totalTokens: 35000 }, modelContextWindow: 100000 }, tokenUsageOwner: owner });
    const answer = deferred();
    ctx.answer = () => answer.promise;
    const r = await render(h(ContextPanel, { threadId: 'chat' }));
    assert.ok(r.host.querySelector('.ctx-loading'));
    assert.equal(one(r.host, '.ctx-big').textContent, '35%');
    assert.equal(one(r.host, '.ctx-of').textContent, '35k / 100k');
    await act(async () => (reject ? answer.reject(new Error('offline')) : answer.resolve(null)));
    assert.equal(r.host.querySelector('.ctx-loading'), null);
    assert.equal(one(r.host, '.ctx-big').textContent, '35%');
    assert.match(r.host.textContent!, /Couldn't load the breakdown/);
    const retry = deferred();
    ctx.answer = () => retry.promise;
    await act(() => one(r.host, '.ctx-retry').click());
    assert.ok(r.host.querySelector('.ctx-loading'));
    await act(async () => retry.resolve(snapshotOf(owner, { used: 40, window: 100 })));
    assert.equal(one(r.host, '.ctx-big').textContent, '40%');
    await r.unmount();
  }
});

test('an empty snapshot ends loading with Retry and retries despite the cached empty snapshot', async () => {
  reset();
  const answer = deferred();
  ctx.answer = () => answer.promise;
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await act(async () => answer.resolve(snapshotOf(owner)));
  assert.match(r.host.textContent!, /Context unavailable/);
  assert.equal(r.host.querySelector('.ctx-loading'), null);
  const retry = deferred();
  ctx.answer = () => retry.promise;
  await act(() => one(r.host, '.ctx-retry').click());
  assert.ok(r.host.querySelector('.ctx-loading'));
  await act(async () => retry.resolve(snapshotOf(owner, { used: 50, window: 100, at: 2000 })));
  assert.equal(one(r.host, '.ctx-big').textContent, '50%');
  await r.unmount();
});

test('an older same-owner success, empty answer or rejection cannot end or overwrite the replacement read in either order', async () => {
  for (const result of ['null', 'empty', 'reject', 'success']) {
    for (const oldFirst of [true, false]) {
      reset();
      const old = deferred();
      ctx.answer = () => old.promise;
      const r = await render(h(ContextPanel, { threadId: 'chat' }));
      const next = deferred();
      ctx.answer = () => next.promise;
      await act(async () => store.set({ runtime: { chat: { turns: [{ status: 'inProgress' }] } } }));
      assert.equal(ctx.asks.length, 2);
      const settleOld = () =>
        act(async () => {
          if (result === 'reject') old.reject(new Error('retired'));
          else old.resolve(result === 'null' ? null : snapshotOf(owner, result === 'success' ? { used: 99, window: 100 } : {}));
        });
      const settleNext = () => act(async () => next.resolve(snapshotOf(owner, { used: 20, window: 100 })));
      if (oldFirst) {
        await settleOld();
        assert.ok(r.host.querySelector('.ctx-loading'));
        await settleNext();
      } else {
        await settleNext();
        await settleOld();
      }
      assert.equal(r.host.querySelector('.ctx-loading'), null);
      assert.equal(one(r.host, '.ctx-big').textContent, '20%');
      assert.equal(ctx.ignored.length, 0, 'an obsolete rejection must not invalidate the newer asked marker');
      await r.unmount();
    }
  }
});
