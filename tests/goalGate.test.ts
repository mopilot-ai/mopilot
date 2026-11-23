// The Goal entries are greyed in a temporary chat, with the reason (D-49).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalOffReason, TEMPORARY_GOAL } from '../src/lib/goalGate.ts';

test("a temporary chat can't have a goal, a regular one can", () => {
  assert.equal(goalOffReason({ ephemeral: true }, true, false), TEMPORARY_GOAL);
  assert.equal(goalOffReason({ ephemeral: false }, true, false), null);
  assert.equal(goalOffReason(undefined, true, false), null);
  assert.equal(TEMPORARY_GOAL, "Temporary chats can't have goals");
});

test('on the new-chat screen the next chat decides', () => {
  assert.equal(goalOffReason(null, false, true), TEMPORARY_GOAL);
  assert.equal(goalOffReason(null, false, false), null);
  // an open regular chat ignores the new-chat setting
  assert.equal(goalOffReason({}, true, true), null);
});
