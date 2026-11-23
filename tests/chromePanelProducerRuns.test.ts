// Panel step identities come from the real Claude, ACP and Codex turn builders, scoped by the native segment that owns their history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildTurns } from './support/claude-translate.ts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { turnFromServer } from '../shared/codexTurns.mjs';
import { turnIdentity, withChatNotes } from '../shared/chatNotes.mjs';
const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { readPeerTurns } = require('../electron/session/peerTranscript.cjs');
const user = {
  type: 'user',
  uuid: 'prompt',
  timestamp: '2026-10-24T00:00:00Z',
  message: { role: 'user', content: 'Do it' },
  parent_tool_use_id: null,
};
const tool = {
  type: 'assistant',
  uuid: 'reply',
  message: { id: 'message', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pwd' } }] },
  parent_tool_use_id: null,
};
test('native builders retain step identity through a JSON history roundtrip on every supported harness family', async () => {
  const claude = buildTurns([user, tool], 'claude:c', '/');
  const acp = buildAcpTurns(
    [
      { t: 'user', turnId: 't', user: { id: 'u', clientId: null, content: [{ type: 'text', text: 'Do it' }] }, at: 1000 },
      {
        t: 'update',
        turnId: 't',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'pwd',
          kind: 'execute',
          status: 'completed',
          rawInput: { command: ['pwd'] },
        },
        at: 2000,
      },
    ],
    'acp:kimi:a',
    '/',
  );
  const codex = [
    turnFromServer({
      id: 't',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      items: [
        {
          id: 'tool',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/',
          pluginId: null,
          scriptPath: null,
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: '/',
          exitCode: 0,
          durationMs: 1000,
        },
      ],
    }),
  ];
  for (const [kind, nativeId, turns] of [
    ['claude', 'c', claude],
    ['acp:kimi', 'a', acp],
    ['codex', 'x', codex],
  ] as const) {
    const history = await readPeerTurns({ segments: [{ kind, nativeId }] }, async () => ({ turns }));
    const rows = rowsOf(history.turns).rows.filter((r: any) => r.role === 'step');
    assert.ok(rows.length > 0, kind);
    assert.ok(
      rows.every((r: any) => typeof r.runId === 'string'),
      kind,
    );
    assert.deepEqual(rowsOf(JSON.parse(JSON.stringify(history.turns))).rows, rowsOf(history.turns).rows);
    const target = history.turns[0];
    assert.equal(typeof target.startedAt, 'number', kind);
    for (const turnId of ['ct-' + turnIdentity(target.id), 'ct-compacted-away']) {
      const note = { id: 'note', kind: 'account', text: 'Account changed', turn: 999, turnId, at: target.startedAt * 1000 + 1 };
      const tagged = withChatNotes(history.turns, [note]);
      assert.equal(tagged[0].items.at(-1)?.id, 'note', kind);
      const earlier = Array.from({ length: 250 }, (_, i) => ({ id: 'old-' + i, items: [{ type: 'agentMessage', text: 'Earlier reply' }] }));
      const clipped = rowsOf([...earlier, ...tagged]);
      assert.equal(clipped.clipped, true);
      assert.ok(
        clipped.rows.some((r: any) => r.role === 'note' && r.text === 'Account changed'),
        kind,
      );
    }
  }
});

test('two native sessions reusing the same turn and item ids cannot share an expanded run', async () => {
  const record = {
    segments: [
      { kind: 'codex', nativeId: 'one', count: 1 },
      { kind: 'codex', nativeId: 'two' },
    ],
  };
  const history = await readPeerTurns(record, async () => ({
    turns: [
      {
        id: 't',
        items: [
          { id: 'tool', type: 'commandExecution', command: 'pwd' },
          { type: 'agentMessage', text: 'Done' },
        ],
      },
    ],
  }));
  const runs = rowsOf(history.turns)
    .rows.filter((r: any) => r.role === 'step')
    .map((r: any) => r.runId);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0], runs[1]);
});
