// Every MGB task in the catalog (#1381) passes the anti-gaming audit on every seed; the task files test the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTask, loadFixtures } from './support/mgb-task-kit.ts';

const { CATALOG } = await import('../bench/lib/mgb/tasks/index.mjs');

for (const task of CATALOG) {
  test(`${task.id} passes the audit on every seed`, () => {
    assert.deepEqual(auditTask(task, { load: loadFixtures }), { ok: true, problems: [] });
  });
}
