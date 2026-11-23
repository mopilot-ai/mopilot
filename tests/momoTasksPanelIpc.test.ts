// The Tasks panel's IPC in main (electron/momo/tasksIpc.cjs, M0a): with the `momo.tasksPanel` flag on, momoTasks:list answers the four tabs' rows (v: 2) with the routines, the pause and the user's marks, and momoTasks:mark takes the user's mark or its Undo; with the flag off the list is the classic one and nothing can be marked; both are refused while MoMo is not allowed; a mark is told to the windows; and a failed mark says why.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { registerTasksIpc, NOT_ALLOWED } = require('../electron/momo/tasksIpc.cjs');
const { createTaskMarks, memoryStorage } = require('../electron/momo/taskMarks.cjs');
const { RESOLVED_SHOWN_MS } = require('../electron/momo/tasksPanel.cjs');
const { RUN_SHOWN_MS } = require('../electron/momo/tasks.cjs');

const NOW = Date.UTC(2026, 10, 15, 20);
const H = 3_600_000;

function rig(o: { allowed?: boolean; panel?: boolean; withMarks?: boolean; broadcast?: boolean } = {}) {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const loops: any = Object.assign(new EventEmitter(), { list: () => [] });
  const gate = { allowed: o.allowed ?? true, panel: o.panel ?? true, paused: true };
  const told: string[] = [];
  const asked: number[] = [];
  const marks = createTaskMarks({ storage: memoryStorage({ now: () => NOW }), now: () => NOW });
  registerTasksIpc(ipcMain, {
    loops,
    runsSince: (at: number) => (
      asked.push(at), [{ chatId: 'c1', taskId: 'r1', startedAt: NOW - 3 * H, endedAt: NOW - 2 * H, outcome: 'completed' }]
    ),
    routineName: () => 'Daily brief',
    cards: () => [],
    allowed: () => gate.allowed,
    ...(o.broadcast === false ? {} : { broadcast: (ch: string) => told.push(ch) }),
    now: () => NOW,
    panel: () => gate.panel,
    ...(o.withMarks === false ? {} : { marks }),
    routines: () => [{ id: 'r1', name: 'Daily brief', status: 'ACTIVE', rrule: 'R' }],
    nextRun: (_rule: string, after: number) => new Date(after + H),
    paused: () => gate.paused,
  });
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a);
  return { gate, told, asked, call, marks };
}

test('with the flag on the list is the four tabs, with the routines, the pause and the marks, and runs are asked for 30 days back', async () => {
  const r = rig();
  const res: any = await r.call('momoTasks:list');
  assert.deepEqual([res.ok, res.v, res.paused, res.now], [true, 2, true, NOW]);
  assert.deepEqual(
    res.tasks.map((t: any) => [t.id, t.tab, t.state]),
    [
      ['run:c1', 'active', 'review'],
      ['routine:r1', 'scheduled', 'scheduled'],
    ],
  );
  assert.equal(res.tasks[1].nextAt, NOW + H);
  assert.deepEqual(r.asked, [NOW - RESOLVED_SHOWN_MS]);
  // a mark moves the run to Resolved on the next read
  await r.call('momoTasks:mark', 'run:c1', 'done');
  const after: any = await r.call('momoTasks:list');
  assert.deepEqual(
    after.tasks.map((t: any) => [t.id, t.tab, t.state]),
    [
      ['routine:r1', 'scheduled', 'scheduled'],
      ['run:c1', 'resolved', 'done'],
    ],
  );
});

test('with the flag off the list is the classic one, asked for as before, and nothing can be marked', async () => {
  const r = rig({ panel: false });
  const res: any = await r.call('momoTasks:list');
  assert.equal(res.v, undefined);
  assert.deepEqual(r.asked, [NOW - RUN_SHOWN_MS]);
  assert.deepEqual(await r.call('momoTasks:mark', 'run:c1', 'done'), { ok: false, reason: 'unavailable', error: 'The Tasks panel is off' });
  assert.deepEqual(r.marks.list(), {});
  // and with no marks store (an older wiring) the list stays classic even with the flag on
  const bare = rig({ withMarks: false });
  assert.equal(((await bare.call('momoTasks:list')) as any).v, undefined);
  assert.equal(((await bare.call('momoTasks:mark', 'run:c1', 'done')) as any).reason, 'unavailable');
});

test('the user’s mark answers its Undo token, tells the windows, and Undo takes it back', async () => {
  const r = rig();
  const done: any = await r.call('momoTasks:mark', 'run:c1', 'archive');
  assert.deepEqual([done.ok, done.taskId, done.mark, typeof done.undoToken], [true, 'run:c1', 'archived', 'string']);
  assert.deepEqual(r.told, ['momoTasks:changed', 'momoTasks:marked']);
  const undone: any = await r.call('momoTasks:mark', 'run:c1', 'reopen', done.undoToken);
  assert.deepEqual([undone.ok, undone.mark], [true, null]);
  assert.deepEqual(r.marks.list(), {});
  const again: any = await r.call('momoTasks:mark', 'run:c1', 'reopen', done.undoToken);
  assert.deepEqual([again.ok, again.reason, again.error], [false, 'expired', 'That can’t be undone any more.']);
  // a mark in a rig with no broadcast breaks nothing
  const quiet = rig({ broadcast: false });
  assert.equal(((await quiet.call('momoTasks:mark', 'run:c1', 'done')) as any).ok, true);
});

test('a mark that is not one says why without a reason code, and nothing is kept', async () => {
  const r = rig();
  for (const [id, what] of [
    ['loop:L1', 'done'],
    ['run:c1', 'finish'],
  ] as const) {
    const res: any = await r.call('momoTasks:mark', id, what);
    assert.deepEqual([res.ok, res.reason], [false, undefined]);
    assert.ok(res.error);
  }
  assert.deepEqual(r.told, []);
  assert.deepEqual(r.marks.list(), {});
});

test('while MoMo is not allowed neither the list nor a mark is answered, and nothing is read or kept', async () => {
  const r = rig({ allowed: false });
  assert.deepEqual(await r.call('momoTasks:list'), NOT_ALLOWED);
  assert.deepEqual(await r.call('momoTasks:mark', 'run:c1', 'done'), NOT_ALLOWED);
  assert.deepEqual([r.asked, r.told, r.marks.list()], [[], [], {}]);
});

test('a wiring that gives only the flag and the marks lists no routines, no next run and no pause', async () => {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: () => undefined };
  const loops: any = Object.assign(new EventEmitter(), { list: () => [] });
  const marks = createTaskMarks({ storage: memoryStorage({ now: () => NOW }), now: () => NOW });
  const wire = (extra: object) =>
    registerTasksIpc(ipcMain, {
      loops,
      runsSince: () => [],
      routineName: () => null,
      cards: () => [],
      allowed: () => true,
      now: () => NOW,
      panel: () => true,
      marks,
      ...extra,
    });
  wire({});
  assert.deepEqual(await handlers.get('momoTasks:list')!({}), { ok: true, v: 2, tasks: [], paused: false, now: NOW });
  // a routine with no way to say when it runs next has no next time
  wire({ routines: () => [{ id: 'r', name: 'R', status: 'ACTIVE', rrule: 'X' }] });
  const res: any = await handlers.get('momoTasks:list')!({});
  assert.deepEqual(
    res.tasks.map((t: any) => [t.id, t.nextAt]),
    [['routine:r', null]],
  );
});
