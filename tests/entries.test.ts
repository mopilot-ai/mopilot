// Entry points that depend on the chat's current segment (src/harness/entries.ts, WP7-12, A17).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../src/harness/entries.ts');

test('the Codex-only entries follow the segment', () => {
  assert.equal(E.listsCodexPlugins('claude'), false);
  assert.equal(E.listsCodexPlugins('codex'), true);
  // "Try now" on a Codex plugin or skill only attaches in a Codex composer
  assert.equal(E.codexAttachBlocked('codex'), null);
  assert.match(E.codexAttachBlocked('claude')!, /Codex chat/);
  assert.equal(E.usesCodexCloud('claude'), false);
});

test('Status is one template: the same rows whichever harness the chat is on', () => {
  const rows = E.statusRows({
    chatId: 'c1',
    harnessLabel: 'Claude Code',
    model: 'Sonnet',
    effort: 'high',
    account: 'me@example.com',
    context: { used: 50_000, window: 200_000 },
    totalTokens: null,
    limits: [
      { label: '5h limit', usedPercent: 30 },
      { label: 'Weekly', usedPercent: null },
      { label: 'Weekly Opus', usedPercent: 12, reset: 'Resets Mon 9:00 AM' },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r[0]),
    ['Chat ID', 'Harness', 'Model', 'Account', 'Context', 'Total tokens', '5h limit', 'Weekly', 'Weekly Opus'],
  );
  // each window says when it starts over, when that is known
  assert.equal(rows[8][1], '88% left · Resets Mon 9:00 AM');
  assert.equal(rows[2][1], 'Sonnet · high');
  assert.equal(rows[4][1], '25% used · 50k / 200k tokens');
  assert.equal(rows[5][1], '—');
  assert.equal(rows[6][1], '70% left');
  // a window whose reset passed since it was read: not known, never shown as full (#1582)
  assert.equal(rows[7][1], 'Reset since last read');
  assert.deepEqual(
    E.statusRows({
      chatId: null,
      harnessLabel: 'Codex',
      model: null,
      effort: null,
      account: null,
      context: null,
      totalTokens: 1_204_331,
      limits: [],
    }).map((r) => r[1]),
    ['New chat', 'Codex', 'default', '—', '1.2M'],
  );
});

test('MCP rows per harness', () => {
  assert.deepEqual(
    E.codexMcpRows([
      { name: 'a', authStatus: 'notLoggedIn' },
      { name: 'b', tools: { x: 1, y: 2 } },
    ]),
    [
      { name: 'a', desc: 'Not signed in' },
      { name: 'b', desc: '2 tools' },
    ],
  );
  assert.deepEqual(
    E.claudeMcpRows([
      { name: 'a', status: 'needs-auth' },
      { name: 'b', status: 'connected', tools: [1] },
      { name: 'c', status: 'failed' },
    ]),
    [
      { name: 'a', desc: 'Not signed in' },
      { name: 'b', desc: '1 tools' },
      { name: 'c', desc: 'failed' },
    ],
  );
});

test('routing chips name their own account', () => {
  assert.equal(
    E.cloudChip('ChatGPT · me@example.com'.replace('ChatGPT · ', '')),
    'This new chat uses Codex Cloud (ChatGPT · me@example.com)',
  );
  assert.equal(E.temporaryChip('a@b.c', 'opencode'), "This temporary chat uses Claude Code (a@b.c) · opencode can't keep chats off disk");
});
