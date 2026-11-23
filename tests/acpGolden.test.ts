// Golden ACP transcripts (tests/golden/acp-*.jsonl, threads/<id>.items.jsonl as two harnesses write
// them) replayed into thread turns, and their session-level updates into the chat's acp state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AcpRecord } from '../shared/acpItems/records.d.mts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';

const require = createRequire(import.meta.url);
const { acpStateUpdate } = require('../electron/session/controller.cjs');
const golden = (name: string): AcpRecord[] =>
  fs
    .readFileSync(path.join(import.meta.dirname, 'golden', `acp-${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const shape = (items: any[]) => items.map((i) => `${i.type}${i.status ? `:${i.status}` : ''}`);

test('golden dsh: thought, command, edit, reply; a stopped turn; stray work after it', () => {
  const turns = buildAcpTurns(golden('dsh'), 'acp:dsh:g', '/repo');
  assert.deepEqual(
    turns.map((t) => [t.id, t.status]),
    [
      ['at-1', 'completed'],
      ['at-2', 'interrupted'],
      [turns[2].id, 'interrupted'],
    ],
  );
  assert.deepEqual(shape(turns[0].items), [
    'userMessage',
    'reasoning',
    'commandExecution:completed',
    'fileChange:completed',
    'agentMessage',
  ]);
  const [, thought, cmd, edit, reply] = turns[0].items as any[];
  assert.deepEqual(thought.summary, ["I'll run the test suite first to see what fails."]);
  assert.equal(cmd.command, 'npm test');
  assert.equal(cmd.aggregatedOutput, '1 failing: adds numbers');
  assert.equal(edit.changes[0].path, '/repo/src/add.ts');
  assert.match(edit.changes[0].diff, /-return a - b;\n\+return a \+ b;/);
  assert.equal(reply.text, 'Fixed `add`: it subtracted. Tests pass now.');
  // the stopped turn's command was cut off; the unattended one has a turn of its own
  assert.deepEqual(shape(turns[1].items), ['userMessage', 'commandExecution:failed']);
  assert.deepEqual(shape(turns[2].items), ['commandExecution:failed']);
  assert.equal(turns[0].startedAt, 1760090001);
  assert.equal(turns[0].durationMs, 10_000);
  // usage drives the context ring
  let acp = null;
  for (const r of golden('dsh')) if (r.t === 'update') acp = acpStateUpdate(acp, r.update) ?? acp;
  assert.deepEqual((acp as any).usage, { used: 18234, size: 1000000 });
  assert.equal((acp as any).commands, null);
});

test('golden kimi: plan, explored files, a sage tool, a new file, a linked reply; catalog and config', () => {
  const turns = buildAcpTurns(golden('kimi'), 'acp:kimi:g', '/repo');
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.deepEqual(
    t.plan?.steps.map((s) => s.status),
    ['completed', 'inProgress', 'pending'],
  );
  assert.deepEqual(shape(t.items), [
    'userMessage',
    'commandExecution:completed',
    'commandExecution:completed',
    'mcpToolCall:completed',
    'fileChange:completed',
    'agentMessage',
  ]);
  const [user, read, grep, mcp, add, reply] = t.items as any[];
  assert.equal(user.content[0].text, '/goal make the README accurate');
  assert.equal(read.commandActions[0].type, 'read');
  assert.equal(grep.commandActions[0].query, 'npm run');
  assert.equal(mcp.server, 'sage_0123456789ab');
  assert.equal(mcp.tool, 'browser_open');
  assert.deepEqual(add.changes[0].kind, { type: 'add' });
  assert.equal(reply.text, 'README fixed; setup moved to [docs/setup.md](file:///repo/docs/setup.md)');
  let acp = null;
  for (const r of golden('kimi')) if (r.t === 'update') acp = acpStateUpdate(acp, r.update) ?? acp;
  assert.deepEqual(
    (acp as any).commands.map((c: any) => c.name),
    ['goal', 'swarm', 'init'],
  );
  assert.equal((acp as any).configOptions[0].currentValue, 'kimi-k3');
});

test('golden opencode (1.18.35, #1942): edit, overwrite and new-file writes are file changes with real line numbers', () => {
  const [turn] = buildAcpTurns(golden('opencode'), 'acp:opencode:g', '/repo');
  const edits = turn.items.filter((i: any) => i.type === 'fileChange') as any[];
  assert.deepEqual(shape(turn.items), [
    'userMessage',
    'fileChange:completed',
    'fileChange:completed',
    'fileChange:completed',
    'agentMessage',
  ]);
  assert.deepEqual(
    edits.map((i) => i.changes.map((c: any) => [c.path, c.kind.type, c.diff.split('\n')[0]])),
    [[['/repo/greet.py', 'update', '@@ -1,5 +1,5 @@']], [['/repo/notes.txt', 'update', '']], [['/repo/hello.txt', 'add', 'hello']]],
  );
});
