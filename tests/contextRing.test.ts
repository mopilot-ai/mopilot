// The composer's usage ring before and after a reading, its tooltip and tones, and the chat's context panel on click.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, one, settle } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { createElement as h, act } from 'react';
import { contextPercent, contextTip, contextUsageKey } from '../src/store/contextUsage.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
mock.module('../src/session/harness/planUsage.ts', { namedExports: { refreshPlanUsage: async () => undefined } });
const { ContextRing } = await import('../src/components/composer/ContextRing.tsx');
const { SummaryContext } = await import('../src/components/panels/SummaryContext.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
const ringLabel = (host: HTMLElement) => host.querySelector('.context-ring')?.getAttribute('aria-label') ?? null;
const contextRing = (threadId: string | null) => h(ContextRing, { threadId, selection: null });

const usage = (used: number, window: number) => ({ last: { totalTokens: used }, modelContextWindow: window });
function reported(id: string, harness: string, used: number, window: number) {
  const segments = { [id]: [{ harness, nativeId: `${id}-native` }] };
  store.set({
    segments,
    runtime: { [id]: { turns: [], tokenUsage: usage(used, window), tokenUsageOwner: contextUsageKey(segments[id] as any, id) } },
  });
}
function reset() {
  resetContextSnapshots();
  ctx.asks.length = 0;
  ctx.ignored.length = 0;
  ctx.answer = async () => null;
}

test('the tooltip says the share and tokens, then what to do: the breakdown, how far auto-compact is, or compact now', () => {
  assert.deepEqual(contextTip({ used: 83_412, window: 200_000 }), {
    used: '42% used',
    tokens: '83.4k / 200k',
    hint: 'Click for usage',
  });
  assert.equal(contextTip({ used: 162_000, window: 200_000 }, 167_000).hint, 'Auto-compacts in 5k tokens');
  // past where auto-compact starts, or with no such place, there is no countdown
  assert.equal(contextTip({ used: 162_000, window: 200_000 }, 160_000).hint, 'Click for usage');
  assert.equal(contextTip({ used: 162_000, window: 200_000 }).hint, 'Click for usage');
  assert.equal(contextTip({ used: 70_000, window: 200_000 }, 167_000).hint, 'Click for usage');
  assert.deepEqual(contextTip({ used: 194_000, window: 200_000 }, 167_000), {
    used: '97% used',
    tokens: '194k / 200k',
    hint: 'Compact now to keep going',
  });
  // an over-full reading keeps its real value
  assert.equal(contextPercent({ used: 300, window: 200 }), 150);
  assert.equal(contextTip({ used: 300, window: 200 }).used, '100%+ used');
});

test('a draft shows the ring once it has an agent and can explain the missing reading', async () => {
  reset();
  store.set({ runtime: {}, segments: {} });
  const r = await render(contextRing(null));
  assert.equal(r.host.querySelector('.context-ring'), null);
  for (const selection of ['codex', 'claude', 'acp:kimi'] as const) {
    await r.rerender(h(ContextRing, { threadId: null, selection }));
    const ring = one(r.host, '.context-ring');
    assert.equal(ring.getAttribute('aria-label'), 'Usage details');
    assert.equal(ring.hasAttribute('data-empty'), true);
    assert.equal(r.host.querySelector('.context-ring-fill'), null);
    await act(() => ring.click());
    assert.match(one(document.body, '.ctx-popover').textContent!, /No context usage reported yet/);
    assert.equal(document.querySelector('.ctx-popover [role="meter"]'), null);
  }
  await r.rerender(h(ContextRing, { threadId: null, selection: 'claude', momo: true }));
  assert.equal(r.host.querySelector('.context-ring'), null);
  assert.deepEqual(ctx.asks, []);
  await r.unmount();
});

test('the ring stays open through a remote Claude turn’s first and later context reports', async () => {
  reset();
  const chat = 'acp:host-claude:chat';
  const owner = ownerOf(chat, 'acp:host-claude', chat);
  store.set({ runtime: { [chat]: { turns: [{ status: 'inProgress' }] } }, segments: {} });
  const r = await render(contextRing(chat));
  const ring = one(r.host, '.context-ring');
  assert.equal(ring.getAttribute('aria-label'), 'Usage details');
  assert.equal(ring.hasAttribute('data-empty'), true);
  assert.equal(r.host.querySelector('.context-ring-fill'), null);
  assert.deepEqual(ctx.asks, [['get', owner]]);
  await act(() => ring.click());
  await settle(act);
  const panel = one(document.body, '.ctx-popover');
  assert.match(panel.textContent!, /No context usage reported yet/);
  assert.equal(panel.querySelector('[role="meter"]'), null);

  const publish = (used: number | null, window: number | null, at: number) =>
    act(async () => ctx.push!({ chatId: chat, snapshot: snapshotOf(owner, { used, window, at }) }));
  await publish(39_340, null, 2000);
  assert.equal(ring.getAttribute('aria-label'), 'Usage details');
  assert.equal(one(panel, '.ctx-summary-value').textContent, '39.3k tokens used');
  assert.equal(panel.querySelector('[role="meter"]'), null);
  await publish(39_340, 1_000_000, 3000);
  assert.equal(ring.getAttribute('aria-label'), 'Context: 4% used, 39.3k of 1M tokens');
  assert.equal(ring.hasAttribute('data-empty'), false);
  assert.equal(one(panel, '.ctx-summary-value').textContent, '4% used');
  await publish(70_000, 1_000_000, 4000);
  assert.equal(one(panel, '.ctx-summary-value').textContent, '7% used');
  await publish(null, null, 5000);
  assert.equal(one(r.host, '.context-ring'), ring);
  assert.equal(ring.getAttribute('aria-expanded'), 'true');
  assert.equal(ring.getAttribute('aria-label'), 'Usage details');
  assert.equal(ring.hasAttribute('data-empty'), true);
  assert.equal(panel.querySelector('[role="meter"]'), null);
  assert.match(panel.textContent!, /No context usage reported yet/);
  await r.unmount();
});

test('every harness shows its reading with an accessible label, a bounded arc and its tone', async () => {
  for (const harness of ['codex', 'claude', 'acp:kimi']) {
    reset();
    reported('chat', harness, 170_000, 200_000);
    const r = await render(contextRing('chat'));
    const ring = one(r.host, '.context-ring');
    assert.equal(ring.getAttribute('aria-label'), 'Context: 85% used, 170k of 200k tokens');
    assert.equal(ring.dataset.level, 'warn');
    await r.unmount();
  }
  // over capacity: the label keeps the value, the arc stops at a full circle
  reset();
  reported('chat', 'codex', 250, 200);
  const r = await render(contextRing('chat'));
  const ring = one(r.host, '.context-ring');
  assert.match(ring.getAttribute('aria-label')!, /^Context: 100%\+ used, 250 of 200 tokens/);
  assert.equal(ring.dataset.level, 'full');
  assert.equal(Number(one(r.host, '.context-ring-fill').getAttribute('stroke-dashoffset')), 0);
  await r.unmount();
});

test("a Claude chat's ring comes from main's snapshot (read afresh once) and follows main's pushes", async () => {
  reset();
  store.set({ runtime: { k: { turns: [] } }, segments: { k: [{ harness: 'claude', nativeId: 'k-native' }] } });
  const owner = ownerOf('k', 'claude', 'k-native');
  ctx.answer = async () => snapshotOf(owner, { used: 10_000, window: 1_000_000, quality: 'breakdown' });
  const r = await render(contextRing('k'));
  assert.deepEqual(ctx.asks, [['refresh', owner, 'summary']]);
  assert.equal(ringLabel(r.host), 'Context: 1% used, 10k of 1M tokens');
  // main's snapshot stands over this window's report
  await act(async () => store.set({ runtime: { k: { turns: [], tokenUsage: usage(1, 2), tokenUsageOwner: owner } } }));
  assert.equal(ringLabel(r.host), 'Context: 1% used, 10k of 1M tokens');
  await act(async () => ctx.push!({ chatId: 'k', snapshot: snapshotOf(owner, { used: 600_000, window: 1_000_000, at: 2000 }) }));
  assert.equal(ringLabel(r.host), 'Context: 60% used, 600k of 1M tokens');
  // an older answer never replaces a newer push; a push without a snapshot is ignored
  await act(async () => ctx.push!({ chatId: 'k', snapshot: snapshotOf(owner, { used: 1, window: 1_000_000, at: 10 }) }));
  await act(async () => ctx.push!({ chatId: 'k', snapshot: null as any }));
  assert.equal(ringLabel(r.host), 'Context: 60% used, 600k of 1M tokens');
  // nothing more is asked: main pushes every change
  await r.rerender(contextRing('k'));
  assert.equal(ctx.asks.length, 1);
  await r.unmount();
});

test('a click opens the context panel of the chat the ring belongs to, and a second click closes it', async () => {
  reset();
  reported('mine', 'codex', 20_000, 200_000);
  const r = await render(contextRing('mine'));
  const ring = one(r.host, '.context-ring') as HTMLElement;
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
  await act(() => ring.click());
  assert.equal(ring.getAttribute('aria-expanded'), 'true');
  // the panel loads when first opened
  await settle(act, 20);
  assert.ok(document.querySelector('.ctx-panel'));
  // hovering the ring while its panel is open shows no tooltip over the panel
  const hover = () =>
    ring.parentElement!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  await act(hover);
  await settle(act, 500);
  assert.equal(document.querySelector('.tooltip'), null);
  assert.equal(document.querySelector('.ctx-summary-value')!.textContent, '10% used');
  assert.equal(document.querySelector('.ctx-legend'), null);
  // "View context" closes the popover and opens the detailed context dialog.
  let opened: unknown;
  const listener = (e: Event) => {
    opened = (e as CustomEvent).detail;
  };
  window.addEventListener('open-context', listener);
  await act(() => one(document.body, '.ctx-foot-link', 'View context').click());
  window.removeEventListener('open-context', listener);
  assert.equal(opened, 'mine');
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
  await act(() => ring.click());
  await act(() => ring.click());
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
  // closed, the tooltip shows again
  await act(() => ring.parentElement!.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  await act(hover);
  await settle(act, 500);
  assert.equal(document.querySelector('.tooltip')!.textContent, '10% used · 20k / 200kClick for usage');
  // Escape closes it too
  await act(() => ring.click());
  await act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(ring.getAttribute('aria-expanded'), 'false');
  await r.unmount();
});

test("near auto-compact the tooltip counts down to it, from the chat's snapshot", async () => {
  reset();
  store.set({ runtime: { k: { turns: [] } }, segments: { k: [{ harness: 'claude', nativeId: 'k-native' }] } });
  const owner = ownerOf('k', 'claude', 'k-native');
  ctx.answer = async () =>
    snapshotOf(owner, { used: 162_000, window: 200_000, quality: 'breakdown', autoCompact: { enabled: true, threshold: 167_000 } });
  const r = await render(contextRing('k'));
  await settle(act);
  const ring = one(r.host, '.context-ring');
  assert.equal(ring.dataset.level, 'warn');
  await act(() => ring.parentElement!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
  await settle(act, 500);
  assert.equal(document.querySelector('.tooltip')!.textContent, '81% used · 162k / 200kAuto-compacts in 5k tokens');
  assert.equal((document.querySelector('.context-tip') as HTMLElement).dataset.level, 'warn');
  await r.unmount();
});

test('the ring and the summary card share one ask per owner; a failed ask is noted and the next display asks again', async () => {
  reset();
  store.set({ runtime: { k: { turns: [] } }, segments: { k: [{ harness: 'claude', nativeId: 'k-native' }] } });
  const owner = ownerOf('k', 'claude', 'k-native');
  ctx.answer = async () => {
    throw Error('main busy');
  };
  let r = await render(h('div', null, contextRing('k'), h(SummaryContext, { threadId: 'k' })));
  assert.equal(ctx.asks.length, 1);
  assert.equal(ringLabel(r.host), 'Usage details');
  assert.equal(ctx.ignored.length, 1);
  await r.unmount();
  ctx.answer = async () => snapshotOf(owner, { used: 20_000, window: 200_000 });
  r = await render(h('div', null, contextRing('k'), h(SummaryContext, { threadId: 'k' })));
  assert.equal(ctx.asks.length, 2);
  assert.equal(ringLabel(r.host), 'Context: 10% used, 20k of 200k tokens');
  assert.match(one(r.host, 'summary').textContent!, /10%/);
  await r.unmount();
});
