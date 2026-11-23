// The machine page ships on (host.machinePage): Settings › Machines opens a page per machine for its status, devices, rules, spending, activity and managed policy, without anyone switching a flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_DEFS } from '../shared/flagDefs.mjs';

test('host.machinePage ships on and stays a toggle the owner can switch off', () => {
  const def = FLAG_DEFS.find((d: { key: string }) => d.key === 'host.machinePage');
  assert.equal(def?.default, true);
  assert.equal(def?.mode, 'toggle');
});
