// Deferred context reads: the shared panel shows loading, ends it on failure, retries, and never exposes another owner's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act, StrictMode } from 'react';
import { fakeStore, render, one } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { deferred } from './support/async-scenarios.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
const { ContextPanel } = await import('../src/components/context/ContextPanel.tsx');
const { ContextBreakdown } = await import('../src/components/context/ContextBreakdown.tsx');
const { resetContextSnapshots, askContext } = await import('../src/session/useContextSnapshot.ts');

function reset(harness = 'claude', nativeId = 'native') {
  resetContextSnapshots();
  store.set({ runtime: {}, segments: { chat: [{ harness, nativeId }] } });
  ctx.asks.length = 0;
}

test('a deferred breakdown shows a full loading outline, then the actual composition', async () => {
  reset();
  const answer = deferred();
  ctx.answer = () => answer.promise;
  const r = await render(h(StrictMode, null, h(ContextPanel, { threadId: 'chat' })));
  assert.equal(one(r.host, '[role="status"]').getAttribute('aria-busy'), 'true');
  assert.match(r.host.textContent!, /Loading breakdown/);
  assert.equal(r.host.querySelectorAll('.ctx-loading-row').length, 5);
  assert.doesNotMatch(r.host.textContent!, /Waiting for a report|No context usage reported yet/);
  assert.equal(ctx.asks.length, 1);
  const owner = ownerOf('chat', 'claude', 'native');
  await act(async () => answer.resolve(snapshotOf(owner, { used: 30000, window: 100000 })));
  assert.equal(r.host.querySelector('.ctx-loading'), null);
  assert.equal(one(r.host, '.ctx-big').textContent, '30%');
  assert.ok(r.host.querySelector('.ctx-legend'));
  await r.unmount();
});

test('null and rejected reads stop loading; Retry stays usable and preserves no invented zero', async () => {
  for (const reject of [false, true]) {
    reset();
    const answer = deferred();
    ctx.answer = () => answer.promise;
    const r = await render(h(ContextPanel, { threadId: 'chat' }));
    await act(async () => (reject ? answer.reject(new Error('offline')) : answer.resolve(null)));
    assert.equal(r.host.querySelector('.ctx-loading'), null);
    assert.match(r.host.textContent!, /Context unavailable/);
    assert.equal(one(r.host, '.ctx-big').textContent, '—');
    const retry = deferred();
    ctx.answer = () => retry.promise;
    await act(() => one(r.host, '.ctx-retry').click());
    assert.ok(r.host.querySelector('.ctx-loading'));
    await act(async () => retry.resolve(snapshotOf(ownerOf('chat', 'claude', 'native'), { used: 10, window: 100 })));
    assert.equal(one(r.host, '.ctx-big').textContent, '10%');
    await r.unmount();
  }
});

test('pending reads never replace known usage on any harness', async () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    reset(harness);
    const owner = ownerOf('chat', harness, 'native');
    ctx.answer = async () => snapshotOf(owner, { used: 35, window: 100 });
    const r = await render(h(ContextPanel, { threadId: 'chat' }));
    const answer = deferred();
    ctx.answer = () => answer.promise;
    let pending!: Promise<unknown>;
    await act(() => {
      pending = askContext(owner, true, 'full');
    });
    assert.equal(r.host.querySelector('.ctx-loading'), null);
    assert.equal(one(r.host, '.ctx-big').textContent, '35%');
    await act(async () => {
      answer.resolve(null);
      await pending;
    });
    await r.unmount();
  }
});

test('an unavailable reading without a breakdown capability offers no retry', async () => {
  const r = await render(h(ContextBreakdown, { snapshot: null, state: 'unavailable', running: false, onRetry: null }));
  assert.match(r.host.textContent!, /Context unavailable/);
  assert.equal(r.host.querySelector('.ctx-retry'), null);
  await r.unmount();
});

test('switching chat, harness or native session while reading never reveals the retired result', async () => {
  for (const change of ['chat', 'harness', 'native']) {
    for (const reject of [false, true]) {
      reset();
      const old = deferred();
      ctx.answer = () => old.promise;
      const r = await render(h(ContextPanel, { threadId: 'chat' }));
      const next = deferred();
      ctx.answer = () => next.promise;
      const chatId = change === 'chat' ? 'next' : 'chat';
      const harness = change === 'harness' ? 'acp:kimi' : 'claude';
      const nativeId = change === 'native' ? 'next' : 'native';
      await act(async () => store.set({ segments: { [chatId]: [{ harness, nativeId }] } }));
      await r.rerender(h(ContextPanel, { threadId: chatId }));
      await act(async () =>
        reject ? old.reject(new Error('retired')) : old.resolve(snapshotOf(ownerOf('chat', 'claude', 'native'), { used: 99, window: 100 })),
      );
      assert.doesNotMatch(r.host.textContent!, /99%/);
      // A token-only harness has no expensive breakdown read: its empty state stays honest.
      assert.equal(!!r.host.querySelector('.ctx-loading'), change !== 'harness');
      await act(async () => next.resolve(snapshotOf(ownerOf(chatId, harness, nativeId), { used: 20, window: 100 })));
      assert.equal(one(r.host, '.ctx-big').textContent, '20%');
      await r.unmount();
    }
  }
});

test('a read completed after closing is available when the panel opens again', async () => {
  reset();
  const answer = deferred();
  ctx.answer = () => answer.promise;
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await r.unmount();
  await act(async () => answer.resolve(snapshotOf(ownerOf('chat', 'claude', 'native'), { used: 40, window: 100 })));
  const reopened = await render(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(one(reopened.host, '.ctx-big').textContent, '40%');
  assert.equal(reopened.host.querySelector('.ctx-loading'), null);
  await reopened.unmount();
});
