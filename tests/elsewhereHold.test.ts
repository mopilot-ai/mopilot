// src/store/threads.ts shouldHold: a message waits while another app has the chat (running a turn, or holding Codex's
// writer lock); an idle Claude desktop that merely has the chat open does not hold it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore } from './support/store-harness.ts';

const { store } = await loadStore();
const { shouldHold } = await import('../src/store/threads.ts');

test('an idle external process does not hold new messages, but writers and locks do', () => {
  assert.equal(shouldHold('chat'), false, 'no other app has the chat');
  for (const [running, hard, expected] of [
    [false, false, false],
    [true, false, true],
    [false, true, true],
  ] as const) {
    store.useStore.setState({ elsewhere: { chat: { app: 'claude-desktop', running, hard } } } as any);
    assert.equal(shouldHold('chat'), expected, `running ${running}, hard ${hard}`);
  }
});
