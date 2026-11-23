// Fault injection on the switch and the wipe of a move of MoMo's home: kill, cut off, duplicate and lose the commit on the new home and the finish on the old one, at every state change inside them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casesFor, failures } from './momoEvals/home/matrix.ts';

test('the switch: the new home killed, cut off or answering late at each state change of its commit leaves exactly one home that acts, or a recoverable old one', async () => {
  const cases = await casesFor(['commit']);
  assert.ok(cases.length >= 15, `${cases.length} cases`);
  assert.deepEqual(await failures(cases), []);
});

test('the wipe: the old home killed, offline or hearing the finish twice never deletes its copy before the new home runs, and finishes once it is back', async () => {
  const cases = await casesFor(['finish']);
  assert.ok(cases.length >= 10, `${cases.length} cases`);
  assert.deepEqual(await failures(cases), []);
});
