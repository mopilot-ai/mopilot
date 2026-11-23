// A command's own description reaches its thread item from Claude Code and from ACP agents, for the activity line's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolItem as claudeToolItem } from './support/claude-translate.ts';
import { toolItem as acpToolItem } from '../src/harness/acpTranslate.ts';

test("Claude's Bash item carries the model's description of the command, trimmed, and none when it gave none", () => {
  const bash = (input: Record<string, unknown>): any => claudeToolItem({ id: 'b', name: 'Bash', input });
  const described = bash({ command: 'npm test', description: '  Run the unit tests ' });
  assert.equal(described.type, 'commandExecution');
  assert.equal(described.command, 'npm test');
  assert.equal(described.description, 'Run the unit tests');
  assert.equal(bash({ description: 'List files' }).command, '', 'a description without a command');
  for (const input of [{ command: 'ls' }, { command: 'ls', description: '   ' }, { command: 'ls', description: 7 }, {}]) {
    const item = bash(input);
    assert.equal('description' in item, false, JSON.stringify(input));
    assert.equal(item.command, String((input as { command?: string }).command ?? ''));
  }
});

test("an ACP agent's execute call carries its raw input's description", () => {
  const execute = (rawInput: unknown): any => acpToolItem({ toolCallId: 'c', kind: 'execute', status: 'in_progress', rawInput }, '/repo');
  const described = execute({ command: 'npm test', description: ' Run the tests ' });
  assert.equal(described.command, 'npm test');
  assert.equal(described.description, 'Run the tests');
  assert.equal('description' in execute({ command: 'ls' }), false);
  assert.equal('description' in execute({ command: 'ls', description: '' }), false);
  assert.equal('description' in execute(undefined), false);
});
