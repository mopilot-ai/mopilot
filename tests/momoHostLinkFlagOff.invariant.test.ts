// MoMo's tasks on the user's other machines stay off until the real two-Host check has passed: the `momo.hostLink` flag defaults to false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

test('the `momo.hostLink` flag defaults to false until a real two-Host check on two machines has passed', () => {
  const flag = (FLAG_DEFS as readonly { key: string; default: boolean }[]).find((f) => f.key === 'momo.hostLink');
  assert.ok(flag, 'the `momo.hostLink` flag is defined');
  assert.equal(
    flag.default,
    false,
    'turn it on only after: Allow from the Mac, a read-only and an asked task on the other machine with the Mac closed, the other Host killed mid-task, a move, and removing the machine',
  );
});
