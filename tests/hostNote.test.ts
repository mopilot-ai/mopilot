// A machine's reason in the user's words (src/lib/hostNote.ts): each registry sentence has a short phrase, anything else passes through, and the tooltip carries the original only where the phrase differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineReason, machineReasonTitle } from '../src/lib/hostNote.ts';

// an agent reads by the label the machine's row gives it, and by its id when the row has none
const AGENTS = [{ id: 'alpha', label: 'Alpha Agent' }];
const CASES: [string, string][] = [
  ['Unreachable: This machine has no Host socket on record.', 'Not set up yet'],
  ['Unreachable: connect ECONNREFUSED', "Can't reach this machine"],
  ['No answer for 90 seconds.', "Can't reach this machine"],
  ['Not reached yet.', 'Not reached yet'],
  ['The machine restarted and is waiting for someone to sign in.', 'Restarted · waiting for sign-in'],
  ['The machine is waiting for someone to sign in.', 'Waiting for sign-in'],
  ['No agent is installed on this machine.', 'No agent installed'],
  ['alpha is not signed in on this machine.', 'Alpha Agent needs sign-in'],
  ['beta is not signed in on this machine.', 'beta needs sign-in'],
  ['alpha is not installed on this machine.', "Alpha Agent isn't installed"],
  ['kimi is not installed on this machine.', "kimi isn't installed"],
  ['SSH · claude, codex', 'SSH · claude, codex'],
  ['Offline', 'Offline'],
  ['', ''],
];

test('the registry sentences read as short phrases; other notes pass through', () => {
  for (const [note, phrase] of CASES) assert.equal(machineReason(note, AGENTS), phrase, note);
});

test('the original is the tooltip only when the row shows a different phrase', () => {
  assert.equal(machineReasonTitle('No answer for 90 seconds.'), 'No answer for 90 seconds.');
  assert.equal(machineReasonTitle('alpha is not signed in on this machine.', AGENTS), 'alpha is not signed in on this machine.');
  assert.equal(machineReasonTitle('Offline'), undefined);
  assert.equal(machineReasonTitle('SSH · claude'), undefined);
});
