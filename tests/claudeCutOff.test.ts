// A tool Stop cut off in a Claude Code turn (core/crates/translate/src/claude): the CLI answers it declined, as it
// answers a refusal; after MoPilot's interrupt (live) or before the transcript's interrupt marker (replay) it is cut
// off and reads "Interrupted", while a real refusal stays declined.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ClaudeTranslator, buildTurns } = await import('./support/claude-translate.ts');
const DECLINED = "The user doesn't want to proceed with this tool use. The tool use was rejected.";

test('live: a tool answered declined after our interrupt is cut off; one declined before it stays declined', () => {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('t1', '/repo', (m: string, p: any) => events.push([m, p]));
  tr.beginTurn('a', { id: 'u', content: [{ type: 'text', text: 'go' }] } as any);
  const call = (id: string) =>
    tr.onMessage({
      type: 'assistant',
      message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }] },
    } as any);
  const answer = (id: string) =>
    tr.onMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: DECLINED, is_error: true }] },
    } as any);
  call('refused');
  answer('refused');
  call('cut');
  tr.markInterrupted();
  answer('cut');
  const done = events
    .filter(([m, p]) => m === 'item/completed' && p.item.type === 'commandExecution')
    .map(([, p]) => [p.item.id, p.item.status, p.item.cutOff ?? null]);
  assert.deepEqual(done, [
    ['refused', 'declined', null],
    ['cut', 'failed', true],
  ]);
});

test('replay: the declined tool right before "[Request interrupted by user for tool use]" reads as cut off', () => {
  let n = 0;
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  const user = (content: any) => ({
    type: 'user',
    uuid: `u${++n}`,
    timestamp: ts,
    message: { role: 'user', content },
    parent_tool_use_id: null,
  });
  const tool = (id: string) => ({
    type: 'assistant',
    uuid: `a${++n}`,
    timestamp: ts,
    message: { id: `m${n}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 100' } }] },
    parent_tool_use_id: null,
  });
  const declined = (id: string) => user([{ type: 'tool_result', tool_use_id: id, content: DECLINED, is_error: true }]);
  const turns = buildTurns(
    [
      user('Long job'),
      tool('t1'),
      declined('t1'),
      user('[Request interrupted by user for tool use]'),
      user('Again'),
      tool('t2'),
      declined('t2'),
    ],
    'claude:x',
    '/repo',
  );
  const cmd = (t: any) => t.items.find((i: any) => i.type === 'commandExecution');
  assert.deepEqual([turns[0].status, cmd(turns[0]).status, cmd(turns[0]).cutOff], ['interrupted', 'failed', true]);
  // a refusal with no stop after it stays declined
  assert.equal(cmd(turns[1]).status, 'declined');
});
