// The summary panel's Context card: its reading (main's snapshot, else this window's report), the panel it opens into, and ownership across chat, harness and native-session switches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, one, settle } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { createElement as h, act, StrictMode } from 'react';
import { contextUsageKey } from '../src/store/contextUsage.ts';
import { deferred } from './support/async-scenarios.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
const { SummaryContext } = await import('../src/components/panels/SummaryContext.tsx');
const { contextReading } = await import('../src/store/contextUsage.ts');
const { resetContextSnapshots, askContext } = await import('../src/session/useContextSnapshot.ts');
const segment = (harness: string, nativeId: string) => [{ harness, nativeId }];
const usage = (used: number, window: number) => ({ last: { totalTokens: used }, modelContextWindow: window });
function reset(runtime: any = {}, segments: any = {}) {
  for (const [id, rt] of Object.entries(runtime) as [string, any][])
    if (rt.tokenUsage && !rt.tokenUsageOwner) rt.tokenUsageOwner = contextUsageKey(segments[id], id);
  // each case starts from the default layout, Context collapsed
  store.set({ runtime, segments, prefs: {} });
  resetContextSnapshots();
  ctx.asks.length = 0;
  ctx.ignored.length = 0;
  ctx.answer = async () => null;
}

test('readings reject missing, malformed, infinite and negative values without inventing zero', () => {
  for (const [used, window] of [
    [undefined, undefined],
    [null, 100],
    ['20', 100],
    [Infinity, 100],
    [-1, 100],
    [1, null],
    [1, '100'],
    [1, Infinity],
    [1, 0],
    [1, -1],
    [NaN, 100],
  ]) {
    assert.equal(contextReading(used, window), null);
  }
  assert.deepEqual(contextReading(0, 100), { used: 0, window: 100 });
});

test("every harness shows this window's report until main's snapshot arrives, and keeps the card open meanwhile", async () => {
  for (const [family, id] of [
    ['codex', 'code-session'],
    ['claude', 'claude-session'],
    ['acp:opencode', 'acp:opencode:session'],
    ['acp:kimi', 'acp:kimi:session'],
  ]) {
    reset({ chat: { tokenUsage: usage(35000, 100000), turns: [] } }, { chat: segment(family, id) });
    const r = await render(h(SummaryContext, { threadId: 'chat' }));
    const details = one(r.host, 'details') as HTMLDetailsElement;
    assert.equal(details.open, false);
    assert.match(one(r.host, 'summary').textContent!, /Context.*35%/);
    assert.equal(one(r.host, '.summary-context-value').getAttribute('title'), '35k / 100k tokens');
    assert.equal(details.dataset.level, 'ok', 'room left reads quietly');
    assert.equal(one(r.host, 'meter').getAttribute('value'), '35');
    // the panel loads and reads only once the card is open
    assert.equal(r.host.querySelector('.ctx-panel'), null);
    await act(() => {
      // the fold follows the saved layout: open it as a click on its header does
      if (!details.open) (details.querySelector('summary') as HTMLElement).click();
    });
    await settle(act, 20);
    assert.equal(one(r.host, '.ctx-of').textContent, '35k / 100k');
    await act(async () =>
      ctx.push!({ chatId: 'chat', snapshot: snapshotOf(ownerOf('chat', family, id), { used: 40000, window: 100000 }) }),
    );
    assert.equal(details.open, true);
    assert.match(one(r.host, 'summary').textContent!, /40%/);
    await r.unmount();
  }
});

test('missing readings stay explicitly unavailable; over-capacity ones keep their value with a bounded meter', async () => {
  reset();
  const r = await render(h(SummaryContext, { threadId: 'new-chat' }));
  await act(() => {
    const details = one(r.host, 'details') as HTMLDetailsElement;
    // the fold follows the saved layout: open it as a click on its header does
    if (!details.open) (details.querySelector('summary') as HTMLElement).click();
  });
  await settle(act, 20);
  assert.equal(one(r.host, '.summary-context-value').textContent, '—');
  assert.equal(one(r.host, '.summary-context-value').getAttribute('title'), null, 'no token counts without a reading');
  assert.equal((one(r.host, 'details') as HTMLElement).dataset.level, undefined, 'no reading, no level');
  assert.match(r.host.textContent!, /No context usage reported yet\./);
  assert.equal(r.host.querySelector('meter'), null);
  // a chat that worked and has nothing reported says so, never 0%
  await act(async () => store.set({ runtime: { 'new-chat': { turns: [{ status: 'completed' }, { status: 'inProgress' }] } } }));
  assert.equal(one(r.host, '.summary-context-value').textContent, '—');
  await act(async () =>
    store.set({
      runtime: { 'new-chat': { tokenUsage: usage(120, 100), tokenUsageOwner: contextUsageKey(undefined, 'new-chat'), turns: [] } },
    }),
  );
  assert.match(one(r.host, 'summary').textContent!, /100%\+/);
  assert.equal(one(r.host, 'meter').getAttribute('value'), '100');
  assert.equal((one(r.host, 'details') as HTMLElement).dataset.level, 'full', 'a full window reads as full');
  await r.unmount();
});

test('a chat, harness or native-session switch never shows the previous owner, and a late answer for it is kept for it', async () => {
  reset({}, { a: segment('claude', 'one'), b: segment('claude', 'two') });
  const answers = new Map<string, ReturnType<typeof deferred>>();
  ctx.answer = (_kind, owner) => {
    const d = deferred();
    answers.set(owner, d);
    return d.promise;
  };
  const a = ownerOf('a', 'claude', 'one');
  const r = await render(h(SummaryContext, { threadId: 'a' }));
  await act(async () => answers.get(a)!.resolve(snapshotOf(a, { used: 80, window: 100 })));
  assert.match(one(r.host, 'summary').textContent!, /80%/);
  assert.equal((one(r.host, 'details') as HTMLElement).dataset.level, 'warn', 'from 80% the share reads as a warning');
  await r.rerender(h(SummaryContext, { threadId: 'b' }));
  assert.match(one(r.host, 'summary').textContent!, /—/);
  const two = ownerOf('b', 'claude', 'two');
  await act(async () => store.set({ segments: { b: segment('claude', 'three') } }));
  const three = ownerOf('b', 'claude', 'three');
  await act(async () => answers.get(two)!.resolve(snapshotOf(two, { used: 99, window: 100 })));
  assert.match(one(r.host, 'summary').textContent!, /—/);
  await act(async () => answers.get(three)!.resolve(snapshotOf(three, { used: 30, window: 100 })));
  assert.match(one(r.host, 'summary').textContent!, /30%/);
  await act(async () => store.set({ segments: { b: segment('codex', 'four') } }));
  assert.match(one(r.host, 'summary').textContent!, /—/);
  assert.deepEqual(ctx.asks.at(-1), ['get', ownerOf('b', 'codex', 'four')]);
  // switching back shows the earlier session's snapshot at once, without asking again
  const asked = ctx.asks.length;
  await act(async () => store.set({ segments: { b: segment('claude', 'two') } }));
  assert.match(one(r.host, 'summary').textContent!, /99%/);
  assert.equal(ctx.asks.length, asked);
  await r.unmount();
});

test('a reported reading from a prior native session never stands for the new one', async () => {
  reset(
    { chat: { tokenUsage: usage(80, 100), tokenUsageOwner: JSON.stringify(['chat', 'codex', 'old']), turns: [] } },
    { chat: segment('codex', 'old') },
  );
  const r = await render(h(SummaryContext, { threadId: 'chat' }));
  assert.match(one(r.host, 'summary').textContent!, /80%/);
  await act(async () => store.set({ segments: { chat: segment('codex', 'new') } }));
  assert.match(one(r.host, 'summary').textContent!, /—/);
  await r.unmount();
});

test('StrictMode asks once per owner; asking again for a breakdown reads afresh only when there is none or it is stale', async () => {
  reset({}, { chat: segment('claude', 'native') });
  const owner = ownerOf('chat', 'claude', 'native');
  ctx.answer = async () => snapshotOf(owner, { used: 10, window: 100, quality: 'breakdown' });
  const r = await render(h(StrictMode, null, h(SummaryContext, { threadId: 'chat' })));
  assert.equal(ctx.asks.length, 1);
  assert.match(one(r.host, 'summary').textContent!, /10%/);
  // a current breakdown is only fetched; a stale one, or a full read, is read again
  await askContext(owner, true);
  assert.deepEqual(ctx.asks.at(-1), ['get', owner]);
  ctx.answer = async () => snapshotOf(owner, { used: 10, window: 100, quality: 'breakdown', stale: 'compacted', at: 2000 });
  await askContext(owner, true, 'full');
  assert.deepEqual(ctx.asks.at(-1), ['refresh', owner, 'full']);
  await askContext(owner, true);
  assert.deepEqual(ctx.asks.at(-1), ['refresh', owner, 'summary']);
  // a harness without a breakdown is never read afresh; an answer of nothing keeps what was there
  ctx.answer = async () => null;
  assert.equal((await askContext(owner, false))?.used, 10);
  assert.deepEqual(ctx.asks.at(-1), ['get', owner]);
  assert.equal(await askContext(ownerOf('x', 'codex', 'y'), false), null);
  await r.unmount();
});

test('a harness with a breakdown that has none yet is asked again as its turn changes state; one with a breakdown is not', async () => {
  reset({ chat: { turns: [] } }, { chat: segment('claude', 'native') });
  const owner = ownerOf('chat', 'claude', 'native');
  const r = await render(h(SummaryContext, { threadId: 'chat' }));
  assert.equal(ctx.asks.length, 1);
  ctx.answer = async () => snapshotOf(owner, { used: 30, window: 100, quality: 'breakdown' });
  await act(async () => store.set({ runtime: { chat: { turns: [{ status: 'inProgress' }] } } }));
  assert.deepEqual(ctx.asks.at(-1), ['refresh', owner, 'summary']);
  assert.match(one(r.host, 'summary').textContent!, /30%/);
  const asked = ctx.asks.length;
  await act(async () => store.set({ runtime: { chat: { turns: [{ status: 'completed' }] } } }));
  assert.equal(ctx.asks.length, asked);
  await act(async () => store.set({ runtime: { chat: { turns: [{ status: 'inProgress' }] } } }));
  assert.equal(ctx.asks.length, asked);
  await r.unmount();
});

test('a snapshot a reset emptied stands over the report from before the reset', async () => {
  reset({ chat: { tokenUsage: usage(70, 100), turns: [] } }, { chat: segment('claude', 'native') });
  const owner = ownerOf('chat', 'claude', 'native');
  const r = await render(h(SummaryContext, { threadId: 'chat' }));
  assert.match(one(r.host, 'summary').textContent!, /70%/);
  await act(async () => ctx.push!({ chatId: 'chat', snapshot: snapshotOf(owner, { at: 5000 }) }));
  assert.match(one(r.host, 'summary').textContent!, /—/);
  await r.unmount();
});
