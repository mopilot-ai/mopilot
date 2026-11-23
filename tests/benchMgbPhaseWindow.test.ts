// Producer-consumer contract: boolean completion is never a routine task's timestamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { taskWindow, routineCalls } = await import('../bench/lib/mgb/routineRerun.mjs');
test('legacy boolean phase completion never becomes epoch 1', () => {
  assert.deepEqual(taskWindow({ startedAt: 1000, endedAt: 5000, phases: [{ ended: true }] } as any, 1), { from: 1000, to: 5000 });
});

const { phaseRecord } = await import('../bench/lib/phase.mjs');
test('real phase record cuts off save-message usage and preserves completion booleans', () => {
  const phase = phaseRecord(1000, 2000, true, true);
  assert.equal(phase.wallMs, 1000);
  assert.equal(phase.ended, true);
  assert.deepEqual(taskWindow({ startedAt: 1000, endedAt: 5000, phases: [phase] }, 1), { from: 1000, to: 2000 });
  assert.equal(phaseRecord(1000, 2000, false, false).ended, false);
  for (const endedAt of [NaN, Infinity, 999])
    assert.deepEqual(taskWindow({ startedAt: 1000, endedAt: 5000, phases: [{ endedAt }] }, 1), { from: 1000, to: 5000 });
  assert.deepEqual(taskWindow({}, 1), { from: 0, to: 0 });
});

const { ledgerUsage } = await import('../bench/lib/mgb/run.mjs');
test('task usage excludes saving while the following window still detects routine_save', () => {
  const turn = { startedAt: 1000, endedAt: 5000, phases: [phaseRecord(1000, 2000, true, true)] };
  const window = taskWindow(turn, 1);
  const usage = ledgerUsage(
    [
      { t: new Date(1500).toISOString(), in: 10 },
      { t: new Date(3000).toISOString(), in: 99 },
    ],
    window,
  );
  assert.equal(usage?.requests, 1);
  assert.equal(usage?.tokens, 10);
  assert.equal(routineCalls([{ at: 3000, tool: 'routine_save', outcome: 'ok' }], { from: window.to, to: turn.endedAt }).saved, true);
});
