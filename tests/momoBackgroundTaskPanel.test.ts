// MoMo's four-tab Tasks panel in main (electron/app/momoBackground.cjs, M0a): behind prefs.momo.tasksPanel it lists the routines with their next run, the pause and the user's marks over the routine store, and momoTasks:mark keeps a mark in a sealed file in MoMo's folder that Reset MoMo erases with the routines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

const require = createRequire(import.meta.url);
const { resetMomoStores } = require('../electron/momo/stores.cjs');
const done = async (w: any) => {
  await w.m.close();
  require('../electron/momo/contract/context.cjs').setMomoContextProvider(null);
};

test('the four-tab panel (M0a) is behind prefs.momo.tasksPanel: the routines with their next run, the pause and the user’s marks in main, a mark kept in a sealed file that Reset erases', async () => {
  const w = world({ allowed: true });
  const routine = await w.m.routineStore.add(
    { name: 'Daily brief', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    { approved: true },
  );
  await w.m.routineStore.add({ name: 'Not yet approved', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, { approved: false });
  const run = { chatId: 'run1', taskId: routine.id, kind: 'momo-routine', due: Date.now(), by: { pid: process.pid, started: 1 } };
  await w.m.routineStore.beginRun(run);
  await w.m.routineStore.endRun('run1', 'completed');
  // off: the classic list, and nothing can be marked
  assert.equal((await w.call('momoTasks:list')).v, undefined);
  assert.equal((await w.call('momoTasks:mark', 'run:run1', 'done')).reason, 'unavailable');
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, tasksPanel: true, paused: true } };
  const four = await w.call('momoTasks:list');
  assert.deepEqual([four.v, four.paused], [2, true]);
  assert.deepEqual(
    four.tasks.map((t: any) => [t.tab, t.id, t.state]),
    [
      ['active', 'run:run1', 'review'],
      ['scheduled', `routine:${routine.id}`, 'scheduled'],
    ],
  );
  assert.equal(typeof four.tasks[1].nextAt, 'number');
  const marked = await w.call('momoTasks:mark', 'run:run1', 'done');
  assert.deepEqual([marked.ok, marked.mark], [true, 'done']);
  assert.deepEqual(
    (await w.call('momoTasks:list')).tasks.map((t: any) => [t.tab, t.state]),
    [
      ['scheduled', 'scheduled'],
      ['resolved', 'done'],
    ],
  );
  // the mark is in a sealed file in MoMo's folder, and Reset MoMo erases it with the routines
  const file = path.join(w.m.dir, 'task-marks.json');
  assert.equal(fs.existsSync(file), true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /run1/);
  await resetMomoStores();
  assert.equal(fs.existsSync(file), false);
  await done(w);
});
