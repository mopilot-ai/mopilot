// Chat references (src/session/chatReference.ts): the app wiring handed to readChatReferences.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: unknown[][] = [];
let deps: any;
const state = { threads: { t1: { id: 't1', name: 'Named' } } };
const fn =
  (name: string, ret?: unknown) =>
  (...args: unknown[]) => (calls.push([name, ...args]), ret);
mock.module('../src/lib/readChatReferences.ts', {
  namedExports: { readChatReferences: (text: string, d: any) => ((deps = d), Promise.resolve([{ text }])) },
});
stubStore({ getState: () => state, threadTitle: (t: any) => `title:${t.name}` });
installNativeStub({
  chats: { snapshot: fn('snapshot', 'snap') },
  // main reads a referenced chat's turns from its own store, whichever harness it ran on
  peer: { referenceHistory: async (ids: string[]) => (calls.push(['referenceHistory', ids]), { t1: [{ id: 'a' }] }) },
});
mock.module('../src/harness/ownership.ts', { namedExports: { noteChat: fn('noteChat') } });
mock.module('../src/session/transcript.ts', {
  namedExports: {
    transcriptMarkdown: (title: string, turns: unknown[], label: (i: number) => string) => `${title}|${turns.length}|${label(0)}`,
  },
});
const { chatReferences } = await import('../src/session/chatReference.ts');

test('references read through the app without resuming the chat', async () => {
  assert.deepEqual(await chatReferences('see @chat'), [{ text: 'see @chat' }]);
  assert.equal(deps.snapshot(), 'snap');
  assert.equal(deps.state(), state);
  deps.noteChat('x');
  assert.deepEqual(await deps.sharedTurns('t1'), [{ id: 'a' }]);
  assert.equal(await deps.sharedTurns('t2'), undefined);
  assert.deepEqual(calls, [['snapshot'], ['noteChat', 'x'], ['referenceHistory', ['t1']], ['referenceHistory', ['t2']]]);
  assert.equal(deps.title('t1'), 'title:Named');
  assert.equal(deps.title('missing'), undefined);
  assert.equal(deps.transcript('T', [{}, {}]), 'T|2|Assistant');
});
