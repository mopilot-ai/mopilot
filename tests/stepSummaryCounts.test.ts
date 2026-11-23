// A folded group of steps counts what it did, as Claude Desktop does ("Read 3 files", "Ran 2 commands") (#1523).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { summarizeSteps } from '../src/components/thread/items/stepModel.ts';

const s = (kind: string, extra: any = {}) => ({ kind, item: {}, ...extra }) as any;

test('a group counts its reads, commands and tool calls; one of each reads in the singular', () => {
  assert.equal(summarizeSteps([s('read'), s('read'), s('read'), s('command'), s('command')]).text, 'Read 3 files, ran 2 commands');
  assert.equal(summarizeSteps([s('read'), s('command'), s('tool')]).text, 'Read a file, ran a command, called a tool');
  assert.equal(summarizeSteps([s('tool'), s('tool'), s('tool')]).text, 'Called 3 tools');
});
