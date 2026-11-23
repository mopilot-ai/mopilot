// The context bar's model (src/components/context/contextMeter.ts) and the one number format (src/lib/contextFormat.ts): plain groups in the palette's order, free space, the reserve at the end with auto-compact's mark, the dialog's grid, and how every count and share is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellsOf, contextMeter, shareOf } from '../src/components/context/contextMeter.ts';
import { contextLevel, contextShare, contextTokens } from '../src/lib/contextFormat.ts';
import { emptySnapshot, estimatedCategories, withClaudeBreakdown } from '../shared/contextSnapshot.mjs';
import type { ContextSnapshot } from '../shared/contextSnapshot.mjs';

const snap = (o: Partial<ContextSnapshot> = {}): ContextSnapshot => ({ ...emptySnapshot('o', 1000), ...o });
const raw = (name: string, tokens: number, kind = 'used') => ({ name, tokens, kind });
/** main's snapshot of a Claude Code chat after its breakdown was read: 200k window, 60k used */
const claude = (o: Record<string, unknown> = {}) =>
  withClaudeBreakdown(
    emptySnapshot('o', 1000),
    {
      totalTokens: 60_000,
      maxTokens: 200_000,
      categories: [
        raw('Messages', 30_000),
        raw('System prompt', 10_000),
        raw('System tools', 8_000),
        raw('MCP tools', 5_000),
        raw('Memory files', 4_000),
        raw('Skills', 2_000),
        raw('Custom agents', 1_000),
        raw('MCP tools (deferred)', 900, 'deferred'),
        raw('Autocompact buffer', 33_000, 'buffer'),
        raw('Free space', 107_000, 'free'),
      ],
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167_000,
      ...o,
    },
    1000,
  )!;
const ids = (rows: { id: string; tokens: number }[]) => rows.map((r) => [r.id, r.tokens]);

test('token counts read the same everywhere: units, one decimal of thousands and millions, never 1000k', () => {
  assert.deepEqual([0, 840, 999, 9_512, 83_412, 200_000, 999_950, 1_204_331, 3_000_000, 840.4, -5].map(contextTokens), [
    '0',
    '840',
    '999',
    '9.5k',
    '83.4k',
    '200k',
    '1M',
    '1.2M',
    '3M',
    '840',
    '0',
  ]);
});

test('a share is rounded, a sliver reads <1% and past the window 100%+', () => {
  assert.equal(contextShare(83_412, 200_000), '42%');
  assert.equal(contextShare(600, 200_000), '<1%');
  assert.equal(contextShare(0, 200_000), '0%');
  assert.equal(contextShare(200_000, 200_000), '100%');
  assert.equal(contextShare(224_000, 200_000), '100%+');
  assert.deepEqual([0, 79, 80, 94, 95, 140].map(contextLevel), ['ok', 'ok', 'warn', 'warn', 'full', 'full']);
});

test('a breakdown draws its plain groups in the palette order, free space, then the reserve at the end', () => {
  assert.equal(contextMeter(null), null);
  assert.equal(contextMeter(snap({ used: 5 })), null);
  const m = contextMeter(claude())!;
  assert.deepEqual(ids(m.segments), [
    ['instructions', 10_000],
    ['tools', 13_000],
    ['memory', 4_000],
    ['skills', 3_000],
    ['conversation', 30_000],
    ['free', 107_000],
    ['buffer', 33_000],
  ]);
  // the legend puts the reserve before free space and lists deferred tools last, outside the window
  assert.deepEqual(
    m.legend.slice(-3).map((r) => [r.label, r.series, r.outside]),
    [
      ['Reserved for compaction', 'buffer', false],
      ['Free space', 'free', false],
      ['Deferred tools (not counted)', 'deferred', true],
    ],
  );
  assert.deepEqual(
    m.legend[1].parts.map((p) => p.name),
    ['System tools', 'MCP tools'],
  );
  assert.equal(m.percent, 30);
  assert.equal(m.over, 0);
  assert.equal(m.mark, 83.5);
  assert.equal(shareOf(m.legend[0], m.window), '5.0%');
  assert.equal(shareOf(m.legend.at(-1)!, m.window), '—');
});

test('tokens since the breakdown count as Conversation until it is read again', () => {
  const m = contextMeter({ ...claude(), used: 62_000 })!;
  assert.deepEqual(m.segments.find((x) => x.id === 'conversation')!.tokens, 32_000);
  assert.equal(m.segments.find((x) => x.id === 'free')!.tokens, 105_000);
  // a breakdown without a Conversation group gets one for them, in its place in the palette
  const s = withClaudeBreakdown(emptySnapshot('o', 1), { totalTokens: 10, maxTokens: 100, categories: [raw('Odd', 10)] }, 1)!;
  assert.deepEqual(ids(contextMeter({ ...s, used: 15 })!.segments), [
    ['conversation', 5],
    ['c0', 10],
    ['free', 85],
  ]);
});

test('without a split the window holds one Used row; auto-compact off or unplaced draws no mark', () => {
  assert.deepEqual(ids(contextMeter(snap({ used: 40, window: 100 }))!.segments), [
    ['used', 40],
    ['free', 60],
  ]);
  // a snapshot read back without its rows still has its reading
  assert.deepEqual(ids(contextMeter(snap({ used: 40, window: 100, categories: undefined as any }))!.legend), [
    ['used', 40],
    ['free', 60],
  ]);
  const est = contextMeter(snap({ used: 60, window: 100, categories: estimatedCategories(60, 100, 20) }))!;
  assert.deepEqual(
    est.legend.map((r) => [r.label, r.series, r.estimated]),
    [
      ['Instructions & tools', 'instructions', true],
      ['Conversation', 'conversation', true],
      ['Free space', 'free', false],
    ],
  );
  assert.equal(contextMeter(claude({ isAutoCompactEnabled: false }))!.mark, null);
  assert.equal(contextMeter(claude({ autoCompactThreshold: null }))!.mark, null);
  assert.equal(contextMeter(snap({ used: 1, window: 10, autoCompact: { enabled: true, threshold: 50 } }))!.mark, 100);
  // a reserve that takes the bar past the window moves the mark with the bar
  const past = contextMeter({
    ...claude(),
    used: 180_000,
    breakdownUsed: 180_000,
    categories: claude().categories.map((c) => (c.id === 'conversation' ? { ...c, tokens: 150_000 } : c)),
  })!;
  assert.equal(past.mark, (167_000 / 213_000) * 100);
});

test('past the window there is no free space and the over count says by how much', () => {
  const m = contextMeter(snap({ used: 120, window: 100 }))!;
  assert.equal(m.over, 20);
  assert.deepEqual(ids(m.segments), [['used', 120]]);
});

test("the dialog's grid follows the bar: content, free space, the reserve last; a full window is all content", () => {
  const m = contextMeter(claude())!;
  const cells = cellsOf(m);
  assert.equal(cells.length, 100);
  assert.deepEqual(cells.slice(0, 6), ['instructions', 'instructions', 'instructions', 'instructions', 'instructions', 'tools']);
  assert.equal(cells.filter((c) => c === 'free').length, 53);
  assert.deepEqual(cells.slice(-3), ['buffer', 'buffer', 'buffer']);
  assert.deepEqual(cellsOf(contextMeter(snap({ used: 300, window: 100 }))!, 4), ['other', 'other', 'other', 'other']);
});
