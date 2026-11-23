// The gate that holds a new chat's title helper until the chat's own turn shows output (#1651).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const { FirstOutputGate, MAX_HOLD_MS } = createRequire(import.meta.url)('../electron/harness/firstOutputGate.cjs');

const settled = (p: Promise<void>) => {
  let done = false;
  p.then(() => (done = true));
  return () => done;
};

test('an armed key holds until its first output, and arming it again shares the same hold', async () => {
  const gate = new FirstOutputGate();
  const first = gate.arm('t1');
  assert.equal(gate.arm('t1'), first);
  const other = settled(gate.arm('t2'));
  const done = settled(first);
  await tick();
  assert.equal(done(), false);
  gate.open('t1');
  gate.open('t1');
  gate.open('never-armed');
  await tick();
  assert.equal(done(), true);
  assert.equal(other(), false);
  assert.notEqual(gate.arm('t1'), first);
  gate.openAll();
  await tick();
  assert.equal(other(), true);
  assert.equal(gate.held.size, 0);
});

test('a hold that never sees output ends after its limit', async () => {
  assert.equal(MAX_HOLD_MS, 20_000);
  const gate = new FirstOutputGate(5);
  const done = settled(gate.arm('quiet'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done(), true);
  assert.equal(gate.held.size, 0);
});
