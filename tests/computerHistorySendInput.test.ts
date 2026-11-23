// The window's copy of a message (src/store/send.ts buildInput, #1363): shared Computer History memories are main's to send through the chat's harness, so the optimistic message shows what was typed, never the block or a mention of it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store } = await loadStore();

test('a shared Computer History attachment adds nothing to the message the window shows', () => {
  const block = '<sage-computer-history>\nx\n</sage-computer-history>';
  const input = store.buildInput('What did I plan?', [
    { kind: 'computerHistory', path: 'computer-history:today', name: 'Computer History', text: block },
  ]);
  assert.deepEqual(input, [{ type: 'text', text: 'What did I plan?', text_elements: [] }]);
});
