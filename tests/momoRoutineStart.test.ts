// Starting a MoMo routine's run (electron/momo/routines.cjs, #2139): a first message that throws or is refused closes the run (the scheduler's failure path tells MoMo's main chat); a run with no past time of its rule is due now; coding chats finishing never touch MoMo's files, and the scheduler's checks only read.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, told, sweep } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { withMomoTasks } = require('../electron/momo/schedulerTasks.cjs');

const runOf = async (w: any, id: string) => w.service.run((await w.service.list()).find((t: any) => t.id === id));

test('a first message that throws or is refused closes the run; a held one is no failure', async () => {
  const w = world({
    send: async () => {
      throw new Error('ChatController gone');
    },
  });
  const r = await w.routines.add(sweep, { approved: true });
  await assert.rejects(runOf(w, r.id), /ChatController gone/);
  assert.deepEqual(w.routines.openRuns(), []);
  assert.deepEqual(told(w), [], 'the scheduler’s failure path tells the main chat (failed)');
  const refused = world({ send: async () => ({ started: false, error: 'the harness is busy' }) });
  const r2 = await refused.routines.add(sweep, { approved: true });
  await assert.rejects(runOf(refused, r2.id), /didn’t start: the harness is busy/);
  const bare = world({ send: async () => ({ started: false }) });
  const r3 = await bare.routines.add(sweep, { approved: true });
  await assert.rejects(runOf(bare, r3.id), /the harness refused it/);
  const held = world({ send: async () => ({ started: false, held: true }) });
  const r4 = await held.routines.add(sweep, { approved: true });
  assert.ok(await runOf(held, r4.id));
});

test('through the scheduler’s tasks a failed start tells the main chat what went wrong, and the ledger only a code', async () => {
  const w = world({ send: async () => ({ started: false, error: 'the harness is busy' }) });
  const r = await w.routines.add(sweep, { approved: true });
  const tasks = withMomoTasks({ list: async () => [], validate: async (x: any) => x, run: async () => 'x' }, () => w.service);
  const [task] = await tasks.list();
  await assert.rejects(tasks.run(task), /^Error: run-failed$/);
  assert.deepEqual(told(w), [['Inbox sweep', false, 'The run’s message didn’t start: the harness is busy']]);
  assert.deepEqual(w.routines.openRuns(), []);
  assert.equal(r.id, task.id);
});

test('coding chats finishing or crashing never touch MoMo’s folder; validate reads only', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-none-')), 'momo');
  const never = world({ allowed: false, dir });
  await never.service.finished({ chatId: 'coding-1', text: 'x', completed: true });
  await never.service.crashed('coding-1');
  assert.equal(fs.existsSync(dir), false);
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const chatId = await runOf(w, r.id);
  w.sessions.patch(chatId, { approvals: [{ id: 'a' }] });
  assert.equal((await w.service.validate({ id: r.id })).id, r.id);
  assert.deepEqual(told(w), [], 'the scheduler’s checks before a claim change nothing');
  assert.equal(await w.service.validate({ id: 'momo.gone' }), null);
  // a run asked for with no past time of its rule (Run now): that time is now
  const later = await w.routines.add({ ...sweep, rrule: 'FREQ=DAILY;DTSTART=20990101T000000Z;COUNT=1' }, { approved: true });
  const id = await w.service.run({ ...(await w.service.validate({ id: later.id })), status: 'ACTIVE' });
  assert.equal(w.routines.openRun(id).due, w.c.t);
});
