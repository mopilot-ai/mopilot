// The shared context snapshot (shared/contextSnapshot.mjs): every harness's figures normalized without inventing a zero, Claude Code's breakdown classified by kind, and the estimated split for token counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBreakdowns,
  baselineOf,
  costOf,
  count,
  emptySnapshot,
  estimatedCategories,
  fromAcpUsage,
  fromTokenUsage,
  plainCategories,
  sinceBreakdown,
  TONES,
  tokenBreakdown,
  withClaudeBreakdown,
  withTokens,
} from '../shared/contextSnapshot.mjs';

const b = (o: Record<string, number> = {}) => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  ...o,
});

test('counts and breakdowns accept only real non-negative numbers', () => {
  assert.equal(count(3), 3);
  for (const v of [-1, Number.NaN, Infinity, '3', null, undefined]) assert.equal(count(v), null);
  assert.equal(tokenBreakdown(null), null);
  assert.equal(tokenBreakdown('x'), null);
  assert.equal(tokenBreakdown({ other: 1 }), null);
  assert.deepEqual(tokenBreakdown({ totalTokens: 9, inputTokens: -1 }), b({ totalTokens: 9 }));
});

test('the baseline is the first input less the first message, never below zero or from nothing', () => {
  assert.equal(baselineOf(1000, 400), 900);
  assert.equal(baselineOf(1000, null), 1000);
  assert.equal(baselineOf(10, 4000), 0);
  assert.equal(baselineOf(undefined, 40), null);
});

test('token counts split into estimated instructions and conversation, with free space; no baseline is one Used row', () => {
  assert.deepEqual(estimatedCategories(null, 100, 10), []);
  assert.deepEqual(estimatedCategories(60, 100, null), [
    { id: 'used', label: 'Used', tokens: 60, kind: 'used', tone: 'other' },
    { id: 'free', label: 'Free space', tokens: 40, kind: 'free' },
  ]);
  assert.deepEqual(estimatedCategories(60, 100, 20), [
    { id: 'instructions', label: 'Instructions & tools', tokens: 20, kind: 'used', estimated: true, tone: 'instructions' },
    { id: 'conversation', label: 'Conversation', tokens: 40, kind: 'used', estimated: true, tone: 'conversation' },
    { id: 'free', label: 'Free space', tokens: 40, kind: 'free' },
  ]);
  // a baseline above what is used (after a compaction) is cut to it; an over-full window has no free row
  assert.deepEqual(
    estimatedCategories(50, 40, 80).map((c) => [c.id, c.tokens]),
    [['instructions', 50]],
  );
  assert.deepEqual(estimatedCategories(50, null, null), [{ id: 'used', label: 'Used', tokens: 50, kind: 'used', tone: 'other' }]);
});

test('a token report replaces what it names, keeps the rest, and clears a compaction mark on a tokens-only snapshot', () => {
  const s0 = { ...emptySnapshot('o', 1), baseline: 10, stale: 'compacted' as const };
  const s1 = withTokens(s0, {
    at: 2,
    used: 30,
    window: 100,
    lastRequest: b({ totalTokens: 30 }),
    session: b({ totalTokens: 50 }),
    model: 'm',
  });
  assert.equal(s1.used, 30);
  assert.equal(s1.window, 100);
  assert.equal(s1.model, 'm');
  assert.equal(s1.stale, null);
  assert.deepEqual(
    s1.categories.map((c) => c.id),
    ['instructions', 'conversation', 'free'],
  );
  // a report naming only its turn's tokens keeps the context reading, and a zero window is unknown
  const s2 = withTokens(s1, { at: 3, lastRequest: b({ totalTokens: 1 }) });
  assert.equal(s2.used, 30);
  assert.equal(s2.stale, null);
  assert.equal(withTokens(s1, { at: 4, window: 0 }).window, null);
  // a breakdown's categories stand; only what is used moves
  const bd = {
    ...s1,
    quality: 'breakdown' as const,
    categories: [{ id: 'c0', label: 'X', tokens: 1, kind: 'used' as const }],
    stale: 'compacted' as const,
  };
  const s3 = withTokens(bd, { at: 5, used: 40 });
  assert.deepEqual(s3.categories, bd.categories);
  assert.equal(s3.stale, 'compacted');
});

test('Codex-shaped usage and ACP prompt usage normalize to the same breakdown', () => {
  assert.deepEqual(fromTokenUsage(undefined), { used: null, window: null, lastRequest: null, session: null });
  const r = fromTokenUsage({ last: { totalTokens: 7, inputTokens: 5 }, total: { totalTokens: 20 }, modelContextWindow: 100 });
  assert.equal(r.used, 7);
  assert.equal(r.window, 100);
  assert.equal(r.session!.totalTokens, 20);
  assert.equal(fromAcpUsage(null), null);
  assert.equal(fromAcpUsage({ thoughtTokens: 3 }), null);
  assert.deepEqual(fromAcpUsage({ inputTokens: 10, outputTokens: 4, cachedReadTokens: 6, cachedWriteTokens: 2, thoughtTokens: 1 }), {
    inputTokens: 16,
    cachedInputTokens: 6,
    cacheWriteInputTokens: 2,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    totalTokens: 20,
  });
  assert.deepEqual(fromAcpUsage({ totalTokens: 9 }), b({ totalTokens: 9 }));
  assert.deepEqual(fromAcpUsage({ outputTokens: 2 }), b({ outputTokens: 2, totalTokens: 2 }));
});

test('breakdowns add field by field; an absent side is the other', () => {
  const x = b({ totalTokens: 2, inputTokens: 1 });
  assert.equal(addBreakdowns(null, x), x);
  assert.equal(addBreakdowns(x, undefined), x);
  assert.deepEqual(addBreakdowns(x, x), b({ totalTokens: 4, inputTokens: 2 }));
});

test('a cost needs a finite amount and a currency', () => {
  assert.deepEqual(costOf({ amount: 0.5, currency: 'USD' }), { amount: 0.5, currency: 'USD' });
  assert.equal(costOf({ amount: Infinity, currency: 'USD' }), null);
  assert.equal(costOf({ amount: 1 }), null);
  assert.equal(costOf(null), null);
});

const reply = (o: Record<string, unknown> = {}) => ({
  totalTokens: 50000,
  maxTokens: 190000,
  rawMaxTokens: 200000,
  model: 'claude-x',
  categories: [
    { name: 'System prompt', tokens: 3000, kind: 'used' },
    { name: 'Messages', tokens: 47000, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 900, kind: 'deferred' },
    { name: 'Odd', tokens: 5, isDeferred: true },
    { name: 'Plain', tokens: 6 },
    { tokens: 7, kind: 'used' },
    { name: 'No count', kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 117000, kind: 'free' },
    { name: 'Empty', tokens: 0, kind: 'used' },
    null,
  ],
  memoryFiles: [{ path: '/a/CLAUDE.md', tokens: 200 }, { tokens: 3 }, { path: '/b.md' }],
  mcpTools: [
    { name: 'mcp__srv__look', serverName: 'srv', tokens: 40, isLoaded: true },
    { name: 'other', serverName: 'srv', tokens: 10, isLoaded: false },
    { tokens: 1 },
    { name: 'mcp__srv__nocount', serverName: 'srv' },
  ],
  agents: [{ agentType: 'Explore', tokens: 12 }, { tokens: 1 }, { agentType: 'Plan' }],
  skills: { skillFrontmatter: [{ name: 'fix-bug', tokens: 30 }] },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167000,
  ...o,
});

test("Claude Code's answer becomes the breakdown, classified by kind and named plainly, with its lists and auto-compact setting", () => {
  const prev = { ...emptySnapshot('o', 1), stale: 'compacted' as const };
  const s = withClaudeBreakdown(prev, reply(), 9)!;
  assert.equal(s.quality, 'breakdown');
  assert.equal(s.used, 50000);
  assert.equal(s.window, 200000);
  assert.equal(s.breakdownUsed, 50000);
  assert.equal(s.breakdownAt, 9);
  assert.equal(s.model, 'claude-x');
  assert.equal(s.stale, null);
  assert.deepEqual(
    s.categories.map((c) => [c.label, c.kind, c.tone]),
    [
      ['Instructions', 'used', 'instructions'],
      ['Conversation', 'used', 'conversation'],
      ['Deferred tools (not counted)', 'deferred', undefined],
      ['Plain', 'used', 'other'],
      ['Other', 'used', 'other'],
      ['Reserved for compaction', 'buffer', undefined],
      ['Free space', 'free', undefined],
    ],
  );
  // the names it was reported as stay with each group
  assert.deepEqual(s.categories[2].parts, [
    { name: 'MCP tools (deferred)', tokens: 900 },
    { name: 'Odd', tokens: 5 },
  ]);
  assert.deepEqual(s.lists, {
    memoryFiles: [
      { path: '/a/CLAUDE.md', tokens: 200 },
      { path: '/b.md', tokens: 0 },
    ],
    mcpTools: [
      { server: 'srv', name: 'look', tokens: 40 },
      { server: 'srv', name: 'other', tokens: 10, deferred: true },
      { server: '', name: '', tokens: 1 },
      { server: 'srv', name: 'nocount', tokens: 0 },
    ],
    agents: [
      { name: 'Explore', tokens: 12 },
      { name: 'Plan', tokens: 0 },
    ],
    skills: [{ name: 'fix-bug', tokens: 30 }],
  });
  assert.equal(s.details, null);
  assert.deepEqual(s.autoCompact, { enabled: true, threshold: 167000 });
});

test('a full read adds the system prompt, tools and message breakdown; a summary keeps the last full one', () => {
  const full = withClaudeBreakdown(
    emptySnapshot('o', 1),
    reply({
      systemPromptSections: [{ name: 'Core', tokens: 100 }],
      systemTools: [{ name: 'Bash', tokens: 50 }],
      messageBreakdown: {
        toolCallTokens: 10,
        toolResultTokens: 20,
        userMessageTokens: 0,
        toolCallsByType: [{ name: 'Read', callTokens: 1, resultTokens: 2 }, { callTokens: 1 }, { name: 'Bash' }],
      },
      isAutoCompactEnabled: false,
      autoCompactThreshold: undefined,
      maxTokens: 150000,
      rawMaxTokens: undefined,
      model: undefined,
      skills: null,
      categories: 'nope',
    }),
    2,
  )!;
  assert.equal(full.window, 150000);
  assert.equal(full.model, null);
  assert.deepEqual(full.categories, []);
  assert.deepEqual(full.lists!.skills, []);
  assert.deepEqual(full.details, {
    systemPrompt: [{ name: 'Core', tokens: 100 }],
    systemTools: [{ name: 'Bash', tokens: 50 }],
    messages: [
      { name: 'Tool calls', tokens: 10 },
      { name: 'Tool results', tokens: 20 },
    ],
    toolCalls: [
      { name: 'Read', callTokens: 1, resultTokens: 2 },
      { name: 'Bash', callTokens: 0, resultTokens: 0 },
    ],
  });
  assert.deepEqual(full.autoCompact, { enabled: false, threshold: null });
  const summary = withClaudeBreakdown(
    { ...full, autoCompact: { enabled: true, threshold: 5 } },
    reply({ isAutoCompactEnabled: 'x', systemTools: undefined }),
    3,
  )!;
  assert.equal(summary.details, full.details);
  assert.deepEqual(summary.autoCompact, { enabled: true, threshold: 5 });
  // a message breakdown alone is a full read too
  assert.deepEqual(withClaudeBreakdown(emptySnapshot('o', 1), reply({ messageBreakdown: {} }), 4)!.details!.messages, []);
  assert.deepEqual(withClaudeBreakdown(emptySnapshot('o', 1), reply({ messageBreakdown: 'x', systemTools: [] }), 4)!.details!.messages, []);
});

test('an answer without a total or a window is not a breakdown', () => {
  const s = emptySnapshot('o', 1);
  assert.equal(withClaudeBreakdown(s, null, 2), null);
  assert.equal(withClaudeBreakdown(s, 'x', 2), null);
  assert.equal(withClaudeBreakdown(s, { totalTokens: 1 }, 2), null);
  assert.equal(withClaudeBreakdown(s, { maxTokens: 1 }, 2), null);
});

test('since-breakdown is only for what is known', () => {
  const bd = { ...emptySnapshot('o', 1), quality: 'breakdown' as const, used: 120, breakdownUsed: 100 };
  assert.equal(sinceBreakdown(bd), 20);
  assert.equal(sinceBreakdown({ ...bd, used: 80 }), 0);
  assert.equal(sinceBreakdown({ ...bd, quality: 'tokens' }), 0);
  assert.equal(sinceBreakdown(null), 0);
  assert.equal(sinceBreakdown({ ...bd, breakdownUsed: null }), 0);
});

test("Claude Code's categories group under plain names, keep what they were reported as, and group only once", () => {
  const raw = (label: string, tokens: number, kind: any = 'used') => ({ id: label, label, tokens, kind });
  const plain = plainCategories([
    raw('System prompt', 3),
    raw('System tools', 10),
    raw('MCP tools', 4),
    raw('Memory files', 2),
    raw('Skills', 1),
    raw('Custom agents', 1),
    raw('Messages', 40),
    raw('Something new', 5),
    raw('MCP tools (deferred)', 9, 'deferred'),
    raw('Autocompact buffer', 33, 'buffer'),
    raw('Free space', 96, 'free'),
  ]);
  assert.deepEqual(
    plain.map((c) => [c.id, c.label, c.tokens, c.tone]),
    [
      ['instructions', 'Instructions', 3, 'instructions'],
      ['tools', 'Tools', 14, 'tools'],
      ['memory', 'Memory', 2, 'memory'],
      ['skills', 'Skills & agents', 2, 'skills'],
      ['conversation', 'Conversation', 40, 'conversation'],
      ['Something new', 'Something new', 5, 'other'],
      ['deferred', 'Deferred tools (not counted)', 9, undefined],
      ['buffer', 'Reserved for compaction', 33, undefined],
      ['Free space', 'Free space', 96, undefined],
    ],
  );
  assert.deepEqual(plain[1].parts, [
    { name: 'System tools', tokens: 10 },
    { name: 'MCP tools', tokens: 4 },
  ]);
  // a snapshot already named (or estimated) passes through unchanged
  assert.deepEqual(plainCategories(plain), plain);
  assert.deepEqual(plainCategories(estimatedCategories(60, 100, 20)), estimatedCategories(60, 100, 20));
  assert.deepEqual(TONES, ['instructions', 'tools', 'memory', 'skills', 'conversation', 'other']);
});
