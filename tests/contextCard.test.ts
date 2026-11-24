// The context dialog (ContextCard.tsx): a grid of the window in the bar's palette, every group in plain names opening into what it was reported as and holds, the tokens measured and Compact now, for every harness as far as it reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, one, settle } from './support/shell-panels-kit.ts';
import { mockContextModules, ownerOf } from './support/context-kit.ts';
import { createElement as h, act } from 'react';
import { contextUsageKey } from '../src/store/contextUsage.ts';

const store = fakeStore({ runtime: {}, segments: {} });
const ctx = mockContextModules(store);
const { ContextCard, OPEN_CONTEXT } = await import('../src/components/context/ContextCard.tsx');
const { CategoryRows } = await import('../src/components/context/ContextLists.tsx');
const { contextMeter } = await import('../src/components/context/contextMeter.ts');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
const { emptySnapshot, withClaudeBreakdown, withTokens } = await import('../shared/contextSnapshot.mjs');
function reset(segments: any, runtime: any = { k: { turns: [] } }) {
  store.set({ segments, runtime });
  resetContextSnapshots();
  ctx.asks.length = 0;
  ctx.ignored.length = 0;
  ctx.compacted.length = 0;
  ctx.opened.length = 0;
  ctx.turn = 'idle';
  ctx.answer = async () => null;
}
const claudeOwner = ownerOf('k', 'claude', 'k-native');
/** main's snapshot of a Claude Code chat after its breakdown was read */
const claudeSnapshot = (reply: any) => withClaudeBreakdown(emptySnapshot(claudeOwner, 1000), reply, 1000)!;

/** Claude Code's contextUsage reply for a 1M window, as getContextUsage({ detail: 'summary' }) returns it */
const claudeReply = {
  totalTokens: 97_336,
  maxTokens: 1_000_000,
  categories: [
    { name: 'System prompt', tokens: 3_200, kind: 'used', color: 'promptBorder' },
    { name: 'System tools', tokens: 14_000, kind: 'used', color: 'inactive' },
    { name: 'MCP tools (deferred)', tokens: 21_000, kind: 'deferred', color: 'inactive', isDeferred: true },
    { name: 'Custom agents', tokens: 0, kind: 'used', color: 'permission' },
    { name: 'Messages', tokens: 80_136, kind: 'used', color: 'purple' },
    { name: 'Free space', tokens: 857_664, kind: 'free', color: 'promptBorder' },
    { name: 'Autocompact buffer', tokens: 45_000, kind: 'buffer', color: 'inactive' },
  ],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 955_000,
};
const texts = (host: HTMLElement, selector: string) => [...host.querySelectorAll(selector)].map((e) => e.textContent);
const cells = (host: HTMLElement) => [...host.querySelectorAll('.ctx-card-grid .ctx-cell')].map((e) => (e as HTMLElement).dataset.series);
const count = (list: (string | undefined)[], series: string) => list.filter((t) => t === series).length;
/** each group's label, tokens and share */
const groups = (host: HTMLElement) =>
  [...host.querySelectorAll('.ctx-cat')].map((c) => [
    c.querySelector('.ctx-legend-label')!.textContent,
    c.querySelector('.ctx-num')!.textContent,
    c.querySelector('.ctx-share')!.textContent,
  ]);

test("a Claude chat's card draws the window in the bar's palette and lists its groups in plain names", async () => {
  reset({ k: [{ harness: 'claude', nativeId: 'k-native' }] });
  ctx.answer = async () => claudeSnapshot(claudeReply);
  const r = await render(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  await settle(act);
  assert.equal(one(r.host, '.ctx-card-big').textContent, '10%');
  assert.match(one(r.host, '.ctx-card-meta').textContent!, /^auto-compacts at 955k · updated /);
  assert.equal(one(r.host, '.ctx-card-of').textContent, '97.3k / 1M tokens');
  assert.deepEqual(groups(r.host), [
    ['Instructions', '3.2k', '0.3%'],
    ['Tools', '14k', '1.4%'],
    ['Conversation', '80.1k', '8.0%'],
    ['Reserved for compaction', '45k', '4.5%'],
    ['Free space', '857.7k', '85.8%'],
    ['Deferred tools (not counted)', '21k', '—'],
  ]);
  // each group opens into the names it was reported as; free space has nothing under it
  assert.deepEqual(
    [...r.host.querySelectorAll('.ctx-group')].map((g) => texts(g as HTMLElement, '.ctx-items > .ctx-item .ctx-item-name, .ctx-aside')),
    [
      ['System prompt'],
      ['System tools'],
      ['Messages'],
      ['Autocompact buffer', 'Held back so a summary always fits'],
      ['MCP tools (deferred)', 'Loaded only when used, not counted above'],
    ],
  );
  assert.equal(r.host.querySelector('div.ctx-cat')!.textContent!.includes('Free space'), true);
  const grid = cells(r.host);
  assert.equal(grid.length, 100);
  assert.equal(one(r.host, '.ctx-card-grid').getAttribute('aria-label'), 'Context window: 10% of 1M tokens used');
  assert.match(r.host.textContent!, /Each cell is 10k tokens\./);
  assert.deepEqual(grid.slice(0, 3), ['tools', 'tools', 'conversation']);
  assert.equal(count(grid, 'free'), 85);
  assert.deepEqual(grid.slice(-5), ['buffer', 'buffer', 'buffer', 'buffer', 'buffer']);
  await r.unmount();
});

test('every harness that reports used/window gets the same card; an estimated split marks its rows', async () => {
  for (const harness of ['codex', 'acp:kimi']) {
    const segments = { c: [{ harness, nativeId: 'c-native' }] };
    // this window's report, before main's snapshot comes
    reset(segments, {
      c: {
        turns: [],
        tokenUsage: { last: { totalTokens: 50_000 }, modelContextWindow: 200_000 },
        tokenUsageOwner: contextUsageKey(segments.c as any, 'c'),
      },
    });
    const r = await render(h(ContextCard, { threadId: 'c', onClose: () => {} }));
    assert.deepEqual(
      ctx.asks.map((a) => a[0]),
      ['get'],
    );
    assert.equal(one(r.host, '.ctx-card-big').textContent, '25%');
    assert.deepEqual(groups(r.host), [
      ['Used', '50k', '25.0%'],
      ['Free space', '150k', '75.0%'],
    ]);
    assert.equal(count(cells(r.host), 'other'), 25);
    // main's snapshot with a baseline splits what is in use, each row marked as an estimate
    const owner = ownerOf('c', harness, 'c-native');
    const s = withTokens({ ...emptySnapshot(owner, 1), baseline: 20_000 }, { at: 2000, used: 50_000, window: 200_000 });
    await act(async () => ctx.push!({ chatId: 'c', snapshot: s }));
    assert.deepEqual(texts(r.host, '.ctx-cat .ctx-legend-label'), ['Instructions & toolsest.', 'Conversationest.', 'Free space']);
    assert.equal(count(cells(r.host), 'instructions'), 10);
    await r.unmount();
  }
});

test('a snapshot without a window shows its tokens and no grid', async () => {
  reset({ c: [{ harness: 'acp:kimi', nativeId: 'c-native' }] });
  ctx.answer = async () => withTokens(emptySnapshot(ownerOf('c', 'acp:kimi', 'c-native'), 1), { at: 2, used: 38_200 });
  const r = await render(h(ContextCard, { threadId: 'c', onClose: () => {} }));
  await settle(act);
  assert.match(one(r.host, '.ctx-card-figure').textContent!, /^38\.2ktokens usedupdated /);
  assert.equal(r.host.querySelector('.ctx-card-grid'), null);
  assert.equal(r.host.querySelector('.ctx-cats'), null);
  await r.unmount();
});

test('before any reading the card says none was reported; Chat details hands over to the chat details', async () => {
  reset({ c: [{ harness: 'codex', nativeId: 'c-native' }] });
  let closed = 0;
  const r = await render(h(ContextCard, { threadId: 'c', onClose: () => closed++ }));
  assert.equal(one(r.host, '.context-card-empty').textContent, 'No context usage reported yet.');
  assert.equal(r.host.querySelector('.ctx-card-grid'), null);
  // nothing to compact yet
  assert.equal(r.host.querySelector('.btn-white'), null);
  let opened: unknown;
  const listener = (e: Event) => {
    opened = (e as CustomEvent).detail;
  };
  window.addEventListener('open-status', listener);
  await act(() => one(r.host, '.btn-pill', 'Chat details').click());
  window.removeEventListener('open-status', listener);
  assert.equal(opened, 'c');
  assert.equal(closed, 1);
  assert.equal(OPEN_CONTEXT, 'open-context');
  await r.unmount();
});

test("the card's Compact now compacts the chat and offers to queue it while a turn runs", async () => {
  reset({ k: [{ harness: 'claude', nativeId: 'k-native' }] });
  ctx.answer = async () => claudeSnapshot(claudeReply);
  const r = await render(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  await settle(act);
  assert.match(one(r.host, '.ctx-card-foot .ctx-note').textContent!, /^Compacting summarizes the chat/);
  await act(() => one(r.host, '.btn-white').click());
  assert.deepEqual(ctx.compacted, ['k']);
  await settle(act);
  ctx.turn = 'running';
  await r.rerender(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  assert.equal(one(r.host, '.btn-white').textContent, 'Compact after turn');
  assert.equal((one(r.host, '.btn-white') as HTMLButtonElement).disabled, false);
  ctx.queue = [{ id: 'q', opts: { compact: { args: '' } } }];
  await r.rerender(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  assert.equal(one(r.host, '.btn-white').textContent, 'Compaction queued');
  assert.equal((one(r.host, '.btn-white') as HTMLButtonElement).disabled, true);
  assert.equal(one(r.host, '.ctx-card-foot .ctx-note').textContent, 'Will compact after the current turn.');
  ctx.queue = [];
  await r.unmount();
});

test('while a read runs the card says so; a read that answers with nothing or fails says context is unavailable', async () => {
  reset({ k: [{ harness: 'claude', nativeId: 'k-native' }] });
  const answers: ((v: unknown) => void)[] = [];
  ctx.answer = () =>
    new Promise((yes) => {
      answers.push(yes as (v: unknown) => void);
    }) as Promise<any>;
  const r = await render(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  assert.equal(one(r.host, '.context-card-empty').textContent, 'Reading context use…');
  // a session that is not running answers with nothing: said as such
  await act(async () => answers.forEach((a) => a(null)));
  assert.equal(one(r.host, '.context-card-empty').textContent, "Context use isn't available right now.");
  // a later breakdown pushed by main replaces the message
  await act(async () => ctx.push!({ chatId: 'k', snapshot: { ...claudeSnapshot(claudeReply), at: 3000 } }));
  assert.equal(r.host.querySelector('.context-card-empty'), null);
  assert.equal(cells(r.host).length, 100);
  await r.unmount();
  reset({ k: [{ harness: 'claude', nativeId: 'k-native' }] });
  ctx.answer = async () => {
    throw Error('session gone');
  };
  const failed = await render(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  await settle(act);
  assert.equal(one(failed.host, '.context-card-empty').textContent, "Context use isn't available right now.");
  assert.match(failed.host.textContent!, /Couldn't count every category/);
  await failed.unmount();
});

test('a full read opens each reported name into what it holds, and the tokens measured', async () => {
  reset({ k: [{ harness: 'claude', nativeId: 'k-native' }] });
  let full: (v: unknown) => void = () => {};
  ctx.answer = (_kind, _owner, detail) =>
    (detail === 'full'
      ? new Promise((res) => {
          full = res;
        })
      : Promise.resolve(claudeSnapshot(claudeReply))) as Promise<any>;
  const r = await render(h(ContextCard, { threadId: 'k', onClose: () => {} }));
  assert.deepEqual(ctx.asks.at(-1), ['refresh', claudeOwner, 'full']);
  ctx.answer = async () => claudeSnapshot(claudeReply);
  await act(async () => ctx.push!({ chatId: 'k', snapshot: claudeSnapshot(claudeReply) }));
  assert.match(r.host.textContent!, /Counting every category/);
  const detailed = withClaudeBreakdown(
    claudeSnapshot(claudeReply),
    {
      ...claudeReply,
      categories: [
        ...claudeReply.categories,
        { name: 'MCP tools', tokens: 50, kind: 'used' },
        { name: 'Memory files', tokens: 400, kind: 'used' },
        { name: 'Skills', tokens: 30, kind: 'used' },
        { name: 'Custom agents', tokens: 12, kind: 'used' },
      ],
      memoryFiles: [{ path: '/repo/CLAUDE.md', tokens: 400 }],
      mcpTools: [
        { name: 'mcp__srv__look', serverName: 'srv', tokens: 50 },
        { name: 'bare', tokens: 21_000, isLoaded: false },
      ],
      agents: [{ agentType: 'Explore', tokens: 12 }],
      skills: { skillFrontmatter: [{ name: 'fix-bug', tokens: 30 }] },
      systemPromptSections: [{ name: 'Core', tokens: 3_200 }],
      systemTools: [{ name: 'Read', tokens: 14_000 }],
      messageBreakdown: { toolResultTokens: 50, toolCallsByType: [{ name: 'Read', callTokens: 10, resultTokens: 40 }] },
    },
    2000,
  )!;
  const tokens = {
    inputTokens: 9,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 10,
  };
  await act(async () => full({ ...detailed, lastRequest: tokens, session: tokens }));
  assert.doesNotMatch(r.host.textContent!, /Counting every category/);
  const parts = Object.fromEntries(
    [...r.host.querySelectorAll('.ctx-part')].map((p) => [
      p.querySelector('summary .ctx-item-name')!.textContent,
      texts(p as HTMLElement, '.ctx-items .ctx-item-name, .ctx-items .ctx-link'),
    ]),
  );
  assert.deepEqual(parts, {
    'System prompt 1': ['Core'],
    'System tools 1': ['Read'],
    'MCP tools 1': ['srv · look'],
    'Memory files 1': ['CLAUDE.md'],
    'Skills 1': ['fix-bug'],
    'Custom agents 1': ['Explore'],
    'Messages 2': ['Tool results', 'Read calls'],
    'MCP tools (deferred) 1': ['bare'],
  });
  assert.equal(one(r.host, '.ctx-item', 'Read calls').getAttribute('title'), '10 in calls, 40 in results');
  await act(() => one(r.host, '.ctx-link').click());
  assert.deepEqual(ctx.opened, ['/repo/CLAUDE.md']);
  assert.deepEqual(texts(r.host, '.ctx-tokens th'), ['Tokens', 'Last request', 'This session']);
  assert.deepEqual(texts(r.host, '.ctx-tokens tr[data-total] td'), ['Total', '10', '10']);
  await r.unmount();
  // a harness without a breakdown is not read again
  reset({ c: [{ harness: 'codex', nativeId: 'c' }] });
  const codex = await render(h(ContextCard, { threadId: 'c', onClose: () => {} }));
  assert.equal(
    ctx.asks.some((a) => a[0] === 'refresh'),
    false,
  );
  await codex.unmount();
});

test('a breakdown read back without its lists names its parts with nothing under them', async () => {
  const s = withClaudeBreakdown(
    emptySnapshot('o', 1),
    {
      totalTokens: 60,
      maxTokens: 100,
      categories: ['MCP tools', 'Memory files', 'Skills', 'Custom agents', 'MCP tools (deferred)'].map((name) => ({
        name,
        tokens: 10,
        kind: name.endsWith('(deferred)') ? 'deferred' : 'used',
      })),
    },
    1,
  )!;
  const r = await render(h(CategoryRows, { model: contextMeter(s)!, lists: null, details: null }));
  assert.equal(r.host.querySelector('.ctx-part'), null);
  assert.deepEqual(texts(r.host, '.ctx-items > .ctx-item .ctx-item-name'), [
    'MCP tools',
    'Memory files',
    'Skills',
    'Custom agents',
    'MCP tools (deferred)',
  ]);
  await r.unmount();
});
