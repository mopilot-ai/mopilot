// The context code-split boundary keeps known usage visible in a shaped fallback until its panel is ready.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { fakeStore, render, one } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { deferred } from './support/async-scenarios.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
let gate: ReturnType<typeof deferred> | null = null;
mock.module('../src/components/context/ContextPanel.tsx', {
  namedExports: {
    ContextPanel: ({ threadId, onDone, compact, planLimits }: any) => {
      if (gate) throw gate.promise;
      return h('div', null, h('button', { className: 'loaded-panel', onClick: onDone, 'data-compact': compact }, threadId), planLimits);
    },
  },
});
const { LazyContextPanel } = await import('../src/components/context/LazyContextPanel.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');

test('the composer lazy fallback stays compact before its code loads and forwards that presentation on every harness', async () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    resetContextSnapshots();
    const owner = ownerOf('chat', harness, 'native');
    store.set({ runtime: {}, segments: { chat: [{ harness, nativeId: 'native' }] } });
    ctx.answer = async () => snapshotOf(owner, { used: 35000, window: 100000 });
    gate = deferred();
    let done = 0;
    const planLimits = h('span', { className: 'test-limits' }, 'Weekly 60% left');
    const r = await render(h(LazyContextPanel, { threadId: 'chat', compact: true, planLimits, onDone: () => done++ }));
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '35% used');
    assert.equal(r.host.querySelector('.ctx-loading-row'), null);
    assert.equal(one(r.host, '.test-limits').textContent, 'Weekly 60% left');
    ctx.answer = async () => null;
    await r.rerender(h(LazyContextPanel, { threadId: 'next', compact: true }));
    assert.equal(one(r.host, '.ctx-summary-value').textContent, '—');
    assert.equal(r.host.querySelector('.test-limits'), null);
    const pending = gate;
    gate = null;
    await act(async () => pending.resolve(null));
    assert.equal(one(r.host, '.loaded-panel').dataset.compact, 'true');
    await r.rerender(h(LazyContextPanel, { threadId: 'next', compact: true, planLimits, onDone: () => done++ }));
    assert.equal(one(r.host, '.test-limits').textContent, 'Weekly 60% left');
    await act(() => one(r.host, '.loaded-panel').click());
    assert.equal(done, 1);
    await r.unmount();
  }
});
test('the lazy fallback appears immediately, retains known usage for every harness and switches owners safely', async () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    resetContextSnapshots();
    const owner = ownerOf('chat', harness, 'native');
    store.set({ runtime: {}, segments: { chat: [{ harness, nativeId: 'native' }] } });
    ctx.answer = async () => snapshotOf(owner, { used: 35000, window: 100000 });
    gate = deferred();
    let done = 0;
    const r = await render(h(LazyContextPanel, { threadId: 'chat', onDone: () => done++ }));
    assert.equal(one(r.host, '[role="status"]').getAttribute('aria-busy'), 'true');
    assert.equal(one(r.host, '.ctx-big').textContent, '35%');
    assert.equal(one(r.host, '.ctx-of').textContent, '35k / 100k');
    assert.equal(r.host.querySelectorAll('.ctx-loading-row').length, 5);
    assert.equal(r.host.querySelector('.ctx-legend-row'), null);
    // The fallback reads the current chat rather than retaining the previous percentage.
    ctx.answer = async () => null;
    await r.rerender(h(LazyContextPanel, { threadId: 'next', onDone: () => done++ }));
    assert.equal(one(r.host, '.ctx-big').textContent, '—');
    assert.equal(r.host.querySelector('.ctx-of'), null);
    assert.equal(r.host.querySelector('.ctx-unit'), null);
    const pending = gate;
    gate = null;
    await act(async () => pending.resolve(null));
    assert.equal(r.host.querySelector('.ctx-loading'), null);
    assert.equal(one(r.host, '.loaded-panel').textContent, 'next');
    await act(() => one(r.host, '.loaded-panel').click());
    assert.equal(done, 1);
    await r.unmount();
    const reopened = await render(h(LazyContextPanel, { threadId: 'chat' }));
    assert.equal(reopened.host.querySelector('.ctx-loading'), null);
    await act(() => one(reopened.host, '.loaded-panel').click());
    await reopened.unmount();
  }
});
