// The composer's compact context summary keeps usage and recovery visible while details stay behind one link.
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
const { ContextSummary } = await import('../src/components/context/ContextSummary.tsx');
const { resetContextSnapshots, askContext } = await import('../src/session/useContextSnapshot.ts');

function reset(harness = 'claude') {
  resetContextSnapshots();
  store.set({ runtime: {}, segments: { chat: [{ harness, nativeId: 'native' }] } });
  ctx.asks.length = 0;
  ctx.windows = [];
  ctx.turn = 'idle';
}
const draw = () => render(h(StrictMode, null, h(ContextPanel, { threadId: 'chat', compact: true })));

test('the summary preserves zero, a sliver and over-capacity usage while bounding its meter', async () => {
  for (const [used, label, value, level] of [
    [0, '0% used', 0, 'ok'],
    [0.4, '<1% used', 0, 'ok'],
    [95, '95% used', 95, 'full'],
    [120, '100%+ used', 100, 'full'],
  ] as const) {
    const r = await render(h(ContextSummary, { used, window: 100, state: 'ready' }));
    assert.equal(one(r.host, '.ctx-summary-value').textContent, label);
    assert.equal(one(r.host, '[role="meter"]').getAttribute('aria-valuenow'), String(value));
    assert.equal(one(r.host, '[role="meter"]').getAttribute('data-level'), level);
    assert.equal(one(r.host, '.ctx-summary-bar > i').style.width, `${Math.min(used, 100)}%`);
    await r.unmount();
  }
});

test('missing window size shows tokens without inventing a percentage; empty and unavailable states offer only supported recovery', async () => {
  let r = await render(h(ContextSummary, { used: 34000, window: null, state: 'ready' }));
  assert.equal(one(r.host, '.ctx-summary-value').textContent, '34k tokens used');
  assert.equal(r.host.querySelector('[role="meter"]'), null);
  await r.unmount();
  for (const state of ['none', 'unavailable'] as const) {
    r = await render(h(ContextSummary, { used: null, window: null, state }));
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '—');
    assert.equal(r.host.querySelector('[role="meter"]'), null);
    assert.equal(r.host.querySelector('.ctx-retry'), null);
    assert.match(r.host.textContent!, state === 'none' ? /No context usage reported yet/ : /Context unavailable/);
    await r.unmount();
  }
});

test('the composer summary shows usage and one details link across harnesses, leaving composition and actions to details', async () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    reset(harness);
    ctx.answer = async () => snapshotOf(ownerOf('chat', harness, 'native'), { used: 34500, window: 475000 });
    const r = await draw();
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '7% used');
    const meter = one(r.host, '[role="meter"]');
    assert.equal(meter.getAttribute('aria-valuetext'), '7% used, 34.5k of 475k tokens');
    assert.equal(meter.getAttribute('aria-valuenow'), '7');
    assert.equal(r.host.querySelectorAll('button').length, 1);
    assert.equal(one(r.host, 'button').textContent, 'View context ');
    for (const selector of ['.ctx-legend', '.ctx-cost', '.ctx-compact', '.ctx-status', '.ctx-of'])
      assert.equal(r.host.querySelector(selector), null, selector);
    let opened: unknown;
    const listener = (e: Event) => {
      opened = (e as CustomEvent).detail;
    };
    window.addEventListener('open-context', listener);
    await act(() => one(r.host, 'button').click());
    window.removeEventListener('open-context', listener);
    assert.equal(opened, 'chat');
    await r.unmount();
  }
});

test('a pending summary stays small, a failure ends loading, and Retry recovers', async () => {
  for (const reject of [false, true]) {
    reset();
    const answer = deferred();
    ctx.answer = () => answer.promise;
    const r = await draw();
    assert.equal(one(r.host, '[role="status"]').getAttribute('aria-busy'), 'true');
    assert.equal(r.host.querySelector('.ctx-loading-row'), null);
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '—');
    await act(async () => (reject ? answer.reject(new Error('offline')) : answer.resolve(null)));
    assert.equal(r.host.querySelector('[aria-busy="true"]'), null);
    assert.match(r.host.textContent!, /Context unavailable/);
    const next = deferred();
    ctx.answer = () => next.promise;
    await act(() => one(r.host, '.ctx-retry').click());
    assert.equal(one(r.host, '[role="status"]').getAttribute('aria-busy'), 'true');
    await act(async () => next.resolve(snapshotOf(ownerOf('chat', 'claude', 'native'), { used: 80, window: 100 })));
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '80% used');
    await r.unmount();
  }
});

test('known summary usage survives a refresh and marks stale readings without exposing the category breakdown', async () => {
  reset();
  const owner = ownerOf('chat', 'claude', 'native');
  ctx.answer = async () => snapshotOf(owner, { used: 10, window: 100, stale: 'compacted' });
  const r = await draw();
  assert.match(r.host.textContent!, /Last reported usage/);
  const next = deferred();
  ctx.answer = () => next.promise;
  let pending!: Promise<unknown>;
  await act(() => {
    pending = askContext(owner, true);
  });
  assert.equal(one(r.host, '.ctx-summary-value').textContent, '10% used');
  await act(async () => {
    next.resolve(snapshotOf(owner, { used: 20, window: 100, at: 2000 }));
    await pending;
  });
  assert.equal(one(r.host, '.ctx-summary-value').textContent, '20% used');
  assert.doesNotMatch(r.host.textContent!, /Last reported usage/);
  await r.unmount();
});

test('switching chat, harness or native session during a summary read cannot reveal the retired usage', async () => {
  for (const change of ['chat', 'harness', 'native']) {
    for (const reject of [false, true]) {
      reset();
      const old = deferred();
      ctx.answer = () => old.promise;
      const r = await draw();
      const next = deferred();
      ctx.answer = () => next.promise;
      const chatId = change === 'chat' ? 'next' : 'chat';
      const harness = change === 'harness' ? 'acp:kimi' : 'claude';
      const nativeId = change === 'native' ? 'next' : 'native';
      await act(async () => store.set({ segments: { [chatId]: [{ harness, nativeId }] } }));
      await r.rerender(h(ContextPanel, { threadId: chatId, compact: true }));
      await act(async () =>
        reject ? old.reject(new Error('retired')) : old.resolve(snapshotOf(ownerOf('chat', 'claude', 'native'), { used: 99, window: 100 })),
      );
      assert.doesNotMatch(r.host.textContent!, /99%/);
      await act(async () => next.resolve(snapshotOf(ownerOf(chatId, harness, nativeId), { used: 20, window: 100 })));
      assert.equal(one(r.host, '.ctx-summary-value').textContent, '20% used');
      await r.unmount();
    }
  }
});
