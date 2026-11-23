// The composer's prompt history (src/lib/promptHistory.ts): prompts read from a chat's transcript plus what this window sent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bangCommand, bangMessage } from '../src/lib/bangMessage.ts';
import { HISTORY_MAX, promptHistory, recordPrompt, resetPromptHistory, transcriptPrompts } from '../src/lib/promptHistory.ts';

beforeEach(() => resetPromptHistory());

const prompt = (...texts: string[]) => ({
  type: 'userMessage',
  id: texts[0],
  clientId: null,
  content: texts.map((text) => ({ type: 'text', text })),
});
const turn = (...items: any[]) => ({ id: 'turn', items }) as any;

test('a transcript gives what the person typed, oldest first, without injected context or empty prompts', () => {
  const turns = [
    turn(prompt('<sage-chat-context>hidden</sage-chat-context>first'), { type: 'agentMessage', id: 'r', text: 'reply' }),
    turn({ type: 'userMessage', id: 'img', clientId: null, content: [{ type: 'image', url: 'x' }] }, prompt('  ')),
    turn(prompt('second', 'line two')),
  ];
  assert.deepEqual(transcriptPrompts(turns), ['first', 'second\nline two']);
  assert.deepEqual(transcriptPrompts(undefined), []);
});

test("a chat's history is its transcript, then what was sent here that the transcript does not show; repeats in a row show once", () => {
  recordPrompt('c1', 'b');
  recordPrompt('c1', '!ls');
  recordPrompt('c1', '!ls');
  recordPrompt('c1', '   ');
  recordPrompt('c2', 'other chat');
  assert.deepEqual(promptHistory('c1', [turn(prompt('a')), turn(prompt('b')), turn(prompt('b'))]), ['a', 'b', '!ls']);
  assert.deepEqual(promptHistory('c3', undefined), []);
  // the new-chat composer steps through what any composer sent
  recordPrompt(null, 'from home');
  assert.deepEqual(promptHistory(null, [turn(prompt('ignored'))]), ['b', '!ls', 'other chat', 'from home']);
});

test('a history keeps its newest prompts', () => {
  for (let i = 0; i < HISTORY_MAX + 5; i++) recordPrompt('c', `p${i}`);
  const list = promptHistory('c', undefined);
  assert.equal(list.length, HISTORY_MAX);
  assert.equal(list[0], 'p5');
  assert.equal(list.at(-1), `p${HISTORY_MAX + 4}`);
});

test('a prompt sent before the last one the transcript shows is not recalled as the newest', () => {
  recordPrompt('c1', '!ls');
  recordPrompt('c1', 'a');
  recordPrompt('c1', 'b');
  assert.deepEqual(promptHistory('c1', [turn(prompt('a')), turn(prompt('b'))]), ['a', 'b']);
  // one still on its way shows after them
  recordPrompt('c1', 'queued');
  assert.deepEqual(promptHistory('c1', [turn(prompt('a')), turn(prompt('b'))]), ['a', 'b', 'queued']);
});

test("a `!` command's message reads back as the command, and matches the one sent here", () => {
  recordPrompt('c1', '!git status');
  assert.deepEqual(promptHistory('c1', [turn(prompt(bangMessage('git status')))]), ['!git status']);
  assert.equal(bangCommand(bangMessage('ls -la')), '!ls -la');
  for (const text of ['I ran ``', 'I ran `ls` somewhere', 'hello', bangMessage(''), bangMessage('x').slice(1)])
    assert.equal(bangCommand(text), null);
});
