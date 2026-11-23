// shared/claudeEndTurn.mjs: the transcript line of a tool result that ended Claude Code's turn (its MCP end-turn flag),
// and the readers that take it as the end of the turn: history replay (buildTurns) and the external-writer check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CLAUDE_END_TURN, endsClaudeTurn } from '../shared/claudeEndTurn.mjs';
import { buildTurns } from './support/claude-translate.ts';

const require = createRequire(import.meta.url);
const { claudeTailRunning } = require('../electron/session/contract/reconcile.cjs');

const flag = { mcpMeta: { _meta: { 'claude/endTurn': true } } };

test('only a user line whose kept MCP meta has the end-turn flag ended the turn', () => {
  assert.equal(CLAUDE_END_TURN, 'claude/endTurn');
  assert.equal(endsClaudeTurn({ type: 'user', ...flag }), true);
  assert.equal(endsClaudeTurn({ type: 'assistant', ...flag }), false);
  assert.equal(endsClaudeTurn({ type: 'user', mcpMeta: { _meta: { 'claude/endTurn': 'yes' } } }), false);
  assert.equal(endsClaudeTurn({ type: 'user' }), false);
  assert.equal(endsClaudeTurn(null), false);
});

const at = new Date(Date.now() - 3_600_000).toISOString();
let n = 0;
const line = (type: string, content: unknown, extra: object = {}) => ({
  type,
  uuid: `l${++n}`,
  timestamp: at,
  message: { role: type, id: `m${n}`, content },
  parent_tool_use_id: null,
  ...extra,
});
const wrap = (ended: boolean) => [
  line('user', 'Write the file'),
  line('assistant', [{ type: 'tool_use', id: 'w1', name: 'mcp__sage_x__wrap_up', input: { recap: 'Done.', ask: 'Commit?' } }]),
  line('user', [{ type: 'tool_result', tool_use_id: 'w1', content: '{"shown":true}' }], ended ? flag : {}),
  line('user', 'Read it back'),
  line('assistant', [{ type: 'text', text: 'It says hi.' }]),
];
const kinds = (t: any) => t.items.map((i: any) => i.type);

test('replay: a turn that ended on the flagged tool result is over, and the next prompt starts a turn', () => {
  assert.deepEqual(
    buildTurns(wrap(true), 'claude:x', '/repo').map((t: any) => [t.status, kinds(t)]),
    [
      ['completed', ['userMessage', 'mcpToolCall']],
      ['completed', ['userMessage', 'agentMessage']],
    ],
  );
  // without the flag, a prompt right after a tool result was sent while Claude worked: it joins the running turn
  assert.equal(buildTurns(wrap(false), 'claude:x', '/repo').length, 1);
  // a session another app still writes that ended on the flag is not working any more
  assert.equal(buildTurns(wrap(true).slice(0, 3), 'claude:x', '/repo', { liveTail: true }).at(-1)?.status, 'completed');
});

test('the external-writer check reads a transcript that ended on the flagged tool result as done', () => {
  const tail = (ended: boolean) =>
    wrap(ended)
      .slice(0, 3)
      .map((l) => JSON.stringify(l));
  assert.equal(claudeTailRunning(tail(true)), false);
  assert.equal(claudeTailRunning(tail(false)), true);
});
