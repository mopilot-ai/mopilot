// The push request's chat handle is stable, pair-scoped and does not contain the chat id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatRef } from '../shared/remote/ref.mjs';

test('a chat ref is stable, 22 characters, pair-scoped and hides the chat id', () => {
  const ref = chatRef('p1', 'claude:abc');
  assert.equal(ref, chatRef('p1', 'claude:abc'));
  assert.match(ref, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(ref, chatRef('p2', 'claude:abc'));
  assert.notEqual(ref, chatRef('p1', 'claude:abd'));
  assert.ok(!ref.includes('abc'));
});
