// The context panel (src/components/context): the headline, bar and legend, the states from what a snapshot carries (waiting, tokens without a window, over the window, updating, stale, compacting), Compact now and why it can't, the usage limits and the footer links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, one, settle } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf, snapshotOf } from './support/context-kit.ts';
import { createElement as h, act } from 'react';
import { mock } from 'node:test';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
mock.module('../src/components/ui/Modal.tsx', {
  namedExports: {
    Modal: ({ title, onClose, children }: any) =>
      h('section', { 'aria-label': title }, h('button', { onClick: onClose }, 'Close'), children),
  },
});
mock.module('../src/components/accounts/meters.tsx', {
  namedExports: { LimitMeters: ({ windows, variant }: any) => h('div', { className: 'limit-stub' }, `${windows.length} ${variant}`) },
});
const { ContextBreakdown, freshnessOf, shownSnapshot, timeOf } = await import('../src/components/context/ContextBreakdown.tsx');
const { ContextPanel, compactLines } = await import('../src/components/context/ContextPanel.tsx');
const { compactBlocked, onlyCompacts } = await import('../src/components/context/useCompact.ts');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
const { emptySnapshot, estimatedCategories, withClaudeBreakdown } = await import('../shared/contextSnapshot.mjs');

const raw = (name: string, tokens: number, kind = 'used') => ({ name, tokens, kind });
const claudeOwner = ownerOf('chat', 'claude', 'claude:k');
/** main's snapshot of a Claude Code chat: 200k window, 60k used, auto-compact at 167k */
const breakdown = (o: any = {}) => ({
  ...withClaudeBreakdown(
    emptySnapshot(claudeOwner, 1000),
    {
      totalTokens: 60_000,
      maxTokens: 200_000,
      categories: [
        raw('Messages', 40_000),
        raw('System prompt', 10_000),
        raw('System tools', 10_000),
        raw('MCP tools (deferred)', 900, 'deferred'),
        raw('Autocompact buffer', 33_000, 'buffer'),
      ],
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
    },
    1000,
  )!,
  ...o,
});
function reset(segments: any = { chat: [{ harness: 'claude', nativeId: 'claude:k' }] }, runtime: any = { chat: { turns: [] } }) {
  store.set({ segments, runtime });
  resetContextSnapshots();
  Object.assign(ctx, {
    turn: 'idle',
    queue: [],
    compaction: null,
    windows: [],
    blocked: null,
    compactCap: null,
    compactWait: Promise.resolve(),
  });
  for (const list of [ctx.asks, ctx.ignored, ctx.compacted, ctx.opened]) list.length = 0;
}
const draw = (snapshot: any, o: any = {}) => render(h(ContextBreakdown, { snapshot, running: false, onRetry: () => {}, ...o }));
const text = (host: HTMLElement, selector: string) => host.querySelector(selector)?.textContent ?? null;
const notes = (host: HTMLElement) => [...host.querySelectorAll('.ctx-note')].map((n) => n.textContent);

test('a breakdown shows its share, used of the window, the bar with the reserve and mark, and a plain legend', async () => {
  reset();
  const r = await draw(breakdown());
  assert.equal(text(r.host, '.ctx-title'), 'Context window');
  assert.equal(text(r.host, '.ctx-status'), `Updated ${timeOf(1000)}`);
  assert.equal(text(r.host, '.ctx-big'), '30%');
  assert.equal(one(r.host, '.ctx-big').dataset.level, 'ok');
  assert.equal(text(r.host, '.ctx-of'), '60k / 200k');
  const segs = [...r.host.querySelectorAll<HTMLElement>('.ctx-seg')];
  assert.deepEqual(
    segs.map((s) => [s.dataset.series, s.style.flexGrow]),
    [
      ['instructions', '10000'],
      ['tools', '10000'],
      ['conversation', '40000'],
      ['free', '107000'],
      ['buffer', '33000'],
    ],
  );
  assert.equal(one(r.host, '.ctx-bar').getAttribute('aria-valuetext'), '30% used, 60k of 200k tokens');
  assert.equal(one(r.host, '.ctx-mark').style.left, '83.5%');
  // deferred tools are left to the dialog
  assert.deepEqual(
    [...r.host.querySelectorAll('.ctx-legend-row')].map((row) => [...row.children].map((c) => c.textContent)),
    [
      ['', 'Instructions', '10k', '5.0%'],
      ['', 'Tools', '10k', '5.0%'],
      ['', 'Conversation', '40k', '20.0%'],
      ['', 'Reserved for compaction', '33k', '16.5%'],
      ['', 'Free space', '107k', '53.5%'],
    ],
  );
  assert.deepEqual(notes(r.host), []);
  await r.unmount();
});

test('nothing reported waits with a ghost meter; tokens without a window say there is no meter', async () => {
  for (const s of [null, emptySnapshot('o', 1)]) {
    const r = await draw(s);
    assert.equal(text(r.host, '.ctx-status'), 'Waiting for a report');
    assert.equal(text(r.host, '.ctx-big'), '—');
    assert.ok(r.host.querySelector('.ctx-bar-ghost'));
    assert.deepEqual(notes(r.host), ["Usage shows here when this chat's next turn ends."]);
    await r.unmount();
  }
  const r = await draw(snapshotOf('o', { used: 38_200, cost: { amount: 0.38, currency: 'USD' } }));
  assert.equal(text(r.host, '.ctx-figure'), '38.2ktokens used');
  assert.equal(r.host.querySelector('.ctx-bar'), null);
  assert.equal(text(r.host, '.ctx-cost'), 'Session cost$0.38');
  assert.deepEqual(notes(r.host), ["This agent doesn't report its window size, so there's no meter."]);
  await r.unmount();
});

test('an estimated split is marked; a reading made here says nothing of when', async () => {
  const s = snapshotOf('o', { used: 60, window: 100, baseline: 20, categories: estimatedCategories(60, 100, 20) });
  let r = await draw(s);
  assert.equal(r.host.querySelectorAll('.ctx-est').length, 2);
  assert.deepEqual(notes(r.host), ['The split is estimated from token totals.']);
  await r.unmount();
  r = await draw(shownSnapshot(null, { used: 1, window: 10 }));
  assert.equal(r.host.querySelector('.ctx-status'), null);
  await r.unmount();
});

test('past the window: 100%+ in red, a red pill of how far over, a full red bar and no mark', async () => {
  const r = await draw(breakdown({ used: 212_400 }));
  assert.equal(text(r.host, '.ctx-big'), '100%+');
  assert.equal(one(r.host, '.ctx-big').dataset.level, 'full');
  assert.equal(text(r.host, '.ctx-over'), '12.4k over');
  assert.deepEqual(
    [...r.host.querySelectorAll<HTMLElement>('.ctx-seg')].map((s) => s.dataset.series),
    ['over'],
  );
  assert.equal(r.host.querySelector('.ctx-mark'), null);
  assert.deepEqual(notes(r.host), ['Compact to get back under the window.']);
  await r.unmount();
});

test('newer tokens shimmer as Updating…; a stale breakdown shows its time with Retry; compacting spins', async () => {
  assert.equal(freshnessOf(breakdown(), false), 'settled');
  let r = await draw(breakdown({ used: 166_000 }), { running: true });
  assert.equal(text(r.host, '.ctx-status'), 'Updating…');
  assert.equal(one(r.host, '.ctx-bar-wrap').dataset.fresh, 'updating');
  assert.equal(one(r.host, '.ctx-big').dataset.level, 'warn');
  assert.deepEqual(notes(r.host), ['Refreshing after this turn']);
  await r.unmount();
  // after the turn it just says it is updating
  r = await draw(breakdown({ used: 70_000 }));
  assert.deepEqual(notes(r.host), []);
  await r.unmount();
  let retried = 0;
  r = await draw(breakdown({ stale: 'refresh-failed', breakdownAt: null }), { onRetry: () => retried++ });
  assert.ok(r.host.querySelector('.ctx-dot'));
  assert.equal(text(r.host, '.ctx-status'), timeOf(1000));
  assert.equal(one(r.host, '.ctx-big').dataset.fresh, 'stale');
  assert.equal(notes(r.host)[0], 'Showing the last breakdown. Retry');
  await act(() => one(r.host, '.ctx-retry').click());
  assert.equal(retried, 1);
  await r.unmount();
  r = await draw(breakdown({ stale: 'compacted' }));
  assert.match(notes(r.host)[0]!, /^Showing the breakdown from before compacting\./);
  await r.unmount();
  // a harness without a breakdown has none to read again: it updates with its next report
  r = await draw(snapshotOf('o', { used: 60, window: 100, stale: 'compacted', at: 1000 }), { onRetry: null });
  assert.deepEqual(notes(r.host), ['Compacted since this reading; it updates when the next turn ends.']);
  assert.equal(r.host.querySelector('.ctx-retry'), null);
  await r.unmount();
  r = await draw(breakdown({ used: 70_000 }), { compacting: true });
  assert.ok(r.host.querySelector('.ctx-spin'));
  assert.equal(text(r.host, '.ctx-status'), 'Compacting');
  assert.deepEqual(notes(r.host), ['Summarizing the conversation']);
  await r.unmount();
});

test('the compact row says where auto-compact starts, how far off it is, or what compacting does', () => {
  assert.deepEqual(compactLines({ enabled: true, threshold: 167_000 }, 83_400), [
    'Auto-compacts at 167k',
    '83.6k to go, or free space now',
  ]);
  assert.deepEqual(compactLines({ enabled: true, threshold: 167_000 }, 170_000), ['Auto-compacts at 167k', 'Compact now to keep going']);
  assert.deepEqual(compactLines({ enabled: true, threshold: null }, 1), ['Auto-compacts near the limit', 'Or free up space now.']);
  assert.deepEqual(compactLines({ enabled: false, threshold: null }, 1), [
    'Auto-compact is off',
    'Summarize the conversation to free up space.',
  ]);
  assert.deepEqual(compactLines(null, 1), ['Summarize the conversation to free up space.', null]);
  assert.equal(compactBlocked('blocked', 'absent'), 'blocked');
  assert.equal(compactBlocked(null, 'absent'), "This agent can't compact chats.");
  assert.equal(compactBlocked(null, 'disabled'), "Compacting isn't available in this chat right now.");
  assert.equal(compactBlocked(null, 'native'), null);
  assert.equal(compactBlocked(null, null), null);
});

const turn = (id: string, status: string, ...texts: string[]) => ({
  id,
  status,
  items: texts.map((text, i) => ({ type: 'userMessage', id: `${id}-${i}`, content: [{ type: 'text', text }] })),
});

test('a turn only compacts when it carries no message but /compact', () => {
  assert.equal(onlyCompacts(turn('t', 'inProgress') as any), true);
  assert.equal(onlyCompacts(turn('t', 'inProgress', '/compact') as any), true);
  assert.equal(onlyCompacts(turn('t', 'inProgress', '/compress') as any), true);
  assert.equal(onlyCompacts(turn('t', 'inProgress', 'fix the bug') as any), false);
  assert.equal(onlyCompacts({ items: [{ type: 'userMessage', content: [{ type: 'image', url: 'x' }] }] } as any), false);
  assert.equal(onlyCompacts({ items: [{ type: 'contextCompaction', id: 'c' }] } as any), true);
});

test('a running chat offers to compact after its turn and shows the queued request on reopen', async () => {
  reset();
  ctx.turn = 'running';
  ctx.compactCap = 'native';
  ctx.answer = async () => breakdown();
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  const button = one(r.host, '.ctx-compact-btn') as HTMLButtonElement;
  assert.equal(button.textContent, 'Compact after turn');
  assert.equal(button.disabled, false);
  await act(() => button.click());
  assert.deepEqual(ctx.compacted, ['chat']);
  ctx.queue = [{ id: 'q', opts: { compact: { args: '' } } }];
  await r.rerender(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compaction queued');
  assert.equal((one(r.host, '.ctx-compact-btn') as HTMLButtonElement).disabled, true);
  assert.equal(r.host.querySelector('.ctx-spin'), null);
  await r.unmount();
  const reopened = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  assert.equal(text(reopened.host, '.ctx-compact-btn'), 'Compaction queued');
  ctx.queue = [];
  await reopened.rerender(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(text(reopened.host, '.ctx-compact-btn'), 'Compact after turn');
  await reopened.unmount();
});

test('Compact now compacts the chat and holds Compacting while its request and then its turn run', async () => {
  reset({ chat: [{ harness: 'claude', nativeId: 'claude:k' }] }, { chat: { turns: [turn('t1', 'completed', 'hi')] } });
  ctx.answer = async () => breakdown();
  let finish!: () => void;
  ctx.compactWait = new Promise<void>((f) => (finish = f));
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  assert.equal(text(r.host, '.ctx-compact-text'), 'Auto-compacts at 167k107k to go, or free space now');
  await act(() => one(r.host, '.ctx-compact-btn').click());
  assert.deepEqual(ctx.compacted, ['chat']);
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compacting…');
  assert.equal((one(r.host, '.ctx-compact-btn') as HTMLButtonElement).disabled, true);
  assert.equal(text(r.host, '.ctx-status'), 'Compacting');
  // the compaction runs as the next turn, sent as /compact
  ctx.turn = 'running';
  store.set({ runtime: { chat: { turns: [turn('t1', 'completed', 'hi'), turn('t2', 'inProgress', '/compact')] } } });
  await act(async () => finish());
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compacting…');
  // it ends; a later turn is not the compaction
  ctx.turn = 'idle';
  store.set({ runtime: { chat: { turns: [turn('t1', 'completed', 'hi'), turn('t2', 'completed', '/compact')] } } });
  await settle(act);
  ctx.turn = 'running';
  store.set({ runtime: { chat: { turns: [turn('t2', 'completed'), turn('t3', 'inProgress')] } } });
  await settle(act);
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compact after turn');
  await r.unmount();
});

test("a refused compaction starts no turn: the user's next turn is not read as compacting", async () => {
  reset({ chat: [{ harness: 'acp:kimi', nativeId: 'acp:kimi:s' }] }, { chat: { turns: [] } });
  ctx.answer = async () => snapshotOf(ownerOf('chat', 'acp:kimi', 'acp:kimi:s'), { used: 10, window: 100 });
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  await act(() => one(r.host, '.ctx-compact-btn').click());
  await settle(act);
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compact now');
  // the user's turn starts before its message lands, then carries it
  ctx.turn = 'running';
  store.set({ runtime: { chat: { turns: [turn('u1', 'inProgress')] } } });
  await settle(act);
  store.set({ runtime: { chat: { turns: [turn('u1', 'inProgress', 'next question')] } } });
  await settle(act);
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compact after turn');
  // and stays so for a turn after it that carries no message yet
  store.set({ runtime: { chat: { turns: [turn('u1', 'completed', 'next question'), turn('u2', 'inProgress')] } } });
  await settle(act);
  assert.equal(r.host.querySelector('.ctx-spin'), null);
  await r.unmount();
});

test("Compact now can't run while a turn runs, when the harness blocks it or the agent lacks it; a failed request is noted", async () => {
  reset();
  ctx.answer = async () => breakdown();
  ctx.compactCap = 'absent';
  const r = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  assert.equal(text(r.host, '.ctx-compact-text'), "This agent can't compact chats.");
  assert.equal((one(r.host, '.ctx-compact-btn') as HTMLButtonElement).disabled, true);
  assert.equal(one(r.host, '.ctx-compact').dataset.blocked, '');
  ctx.compactCap = 'native';
  ctx.compactWait = Promise.reject(new Error('nope'));
  ctx.compactWait.catch(() => {});
  await r.rerender(h(ContextPanel, { threadId: 'chat' }));
  await act(() => one(r.host, '.ctx-compact-btn').click());
  await settle(act);
  assert.equal(ctx.ignored.at(-1)![0], "compact a chat's context from its context panel");
  assert.equal(text(r.host, '.ctx-compact-btn'), 'Compact now');
  await r.unmount();
});

test("the panel shows the plan's usage limits as flush rows on a first-tier harness only", async () => {
  reset();
  ctx.windows = [{ label: '5h' }];
  let r = await render(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(text(r.host, '.ctx-limits'), 'Usage limits1 rows');
  await r.unmount();
  ctx.windows = [];
  r = await render(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('.ctx-limits'), null);
  await r.unmount();
  reset({ chat: [{ harness: 'acp:kimi', nativeId: 'acp:kimi:s' }] });
  ctx.windows = [{ label: '5h' }];
  r = await render(h(ContextPanel, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('.ctx-limits'), null);
  // with nothing known: no Compact row and no full breakdown, only the chat's details
  assert.equal(r.host.querySelector('.ctx-compact'), null);
  assert.deepEqual(
    [...r.host.querySelectorAll('.ctx-foot-link')].map((b) => b.textContent),
    ['Chat details '],
  );
  await r.unmount();
});

test('the footer opens the full breakdown or the chat details and closes the panel; Retry reads the breakdown again', async () => {
  reset();
  ctx.answer = async () => breakdown({ stale: 'refresh-failed' });
  let done = 0;
  const r = await render(h(ContextPanel, { threadId: 'chat', onDone: () => done++ }));
  await settle(act);
  const seen: [string, unknown][] = [];
  const on = (e: Event) => seen.push([e.type, (e as CustomEvent).detail]);
  window.addEventListener('open-context', on);
  window.addEventListener('open-status', on);
  await act(() => one(r.host, '.ctx-foot-link', 'Full breakdown').click());
  await act(() => one(r.host, '.ctx-foot-link', 'Chat details').click());
  assert.deepEqual(seen, [
    ['open-context', 'chat'],
    ['open-status', 'chat'],
  ]);
  assert.equal(done, 2);
  // with no opener (the summary card) the links work all the same
  await r.rerender(h(ContextPanel, { threadId: 'chat' }));
  await act(() => one(r.host, '.ctx-foot-link', 'Chat details').click());
  window.removeEventListener('open-context', on);
  window.removeEventListener('open-status', on);
  ctx.asks.length = 0;
  ctx.answer = async () => {
    throw new Error('offline');
  };
  await act(() => one(r.host, '.ctx-retry').click());
  await settle(act);
  assert.deepEqual(ctx.asks, [['refresh', claudeOwner, 'summary']]);
  assert.equal(ctx.ignored.at(-1)![0], "read a chat's context breakdown again");
  await r.unmount();
  // a compacted chat on a harness without a breakdown offers no Retry
  reset({ chat: [{ harness: 'codex', nativeId: 'c' }] });
  ctx.answer = async () => snapshotOf(ownerOf('chat', 'codex', 'c'), { used: 10, window: 100, stale: 'compacted' });
  const codex = await render(h(ContextPanel, { threadId: 'chat' }));
  await settle(act);
  assert.match(codex.host.textContent!, /Compacted since this reading/);
  assert.equal(codex.host.querySelector('.ctx-retry'), null);
  await codex.unmount();
});

test('the time a snapshot was read names its day when it is not today', () => {
  const now = new Date(2026, 9, 22, 18, 0).getTime();
  assert.doesNotMatch(timeOf(new Date(2026, 9, 22, 15, 42).getTime(), now), /Oct/);
  assert.match(timeOf(new Date(2026, 9, 20, 15, 42).getTime(), now), /Oct 20/);
});

test('a reading made here stands in for a missing snapshot, with its split unknown', () => {
  const s = snapshotOf('o', { used: 5, window: 10 });
  assert.equal(shownSnapshot(s, null), s);
  assert.equal(shownSnapshot(null, null), null);
  assert.equal(shownSnapshot(emptySnapshot('o', 1), null), null);
  // a snapshot emptied by a reset stands over a reading from before it
  assert.equal(shownSnapshot(emptySnapshot('o', 1), { used: 4, window: 10 }), null);
  const made = shownSnapshot(null, { used: 4, window: 10 })!;
  assert.equal(made.used, 4);
  assert.deepEqual(
    made.categories.map((c: any) => c.id),
    ['used', 'free'],
  );
});
