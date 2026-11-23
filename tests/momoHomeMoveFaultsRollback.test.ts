// Fault injection on the ways back of a move of MoMo's home: a Cancel at each step with the Cancel or the discard itself lost or killed, and a target killed or cut off while it receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { casesFor, failures, stepFaults, type Case } from './momoEvals/home/matrix.ts';

test('Cancel before the switch at each step, with the Cancel or the discard itself lost, killed or answered late', async () => {
  const cases: Case[] = [];
  for (const cancelAt of [1, 3]) {
    cases.push({ cancelAt, faults: [] });
    for (const c of stepFaults('A', 'cancel', 2)) cases.push({ cancelAt, faults: c.faults });
    for (const kind of ['drop-req', 'drop-resp', 'kill-before'] as const)
      cases.push({ cancelAt, faults: [{ machine: 'B', op: 'discard', kind }] });
  }
  assert.deepEqual(await failures(cases), []);
});

test('the target is killed or unreachable while it receives: the old home is never left without a way back', async () => {
  const cases = await casesFor(['receive']);
  assert.ok(cases.length >= 10, `${cases.length} cases`);
  assert.deepEqual(await failures(cases), []);
});
