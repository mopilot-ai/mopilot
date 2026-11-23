// A paired phone's four-tab Tasks and the user's mark on a run (momo.tasks.list with `v: 2`, momo.tasks.mark: electron/remote/methods/momo.cjs over remote/momoOps.cjs over momoTasks:list and momoTasks:mark): the phone marks a run done, archives, deletes or reopens it, takes it back with the token the Mac gave, and reopens a closed loop; the mark is refused for an account MoMo is not allowed for, for anything but a run, with the panel off, and for a stale token; the phone's parsers keep the rows they understand; and nothing but these calls sets a mark.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, fail, askSlow, momoRig, MOMO_METHODS, UNINVITED, LOOPS_NOW } from './support/remote-momo-kit.ts';
import { settle } from './support/remote-kit.ts';
import { MARK_METHOD, parseMarked, parseTaskPanel } from '../mobile/src/momo/taskPanelContract';

const require = createRequire(import.meta.url);
const { PARSERS, parseParams } = require('../shared/remote/schema.mjs');
const methods = require('../electron/remote/methods/momo.cjs');

const H = 3_600_000;
function rig(o: Parameters<typeof momoRig>[0] = {}) {
  const m = momoRig(o);
  m.tasksPanel.on = true;
  m.runs.push({ chatId: 'c-run', taskId: 'r1', startedAt: LOOPS_NOW - 3 * H, endedAt: LOOPS_NOW - 2 * H, outcome: 'completed' });
  return { ...m, p: m.r.phone('p1') };
}
const placed = (res: any) => res.tasks.map((t: any) => `${t.tab}:${t.id}:${t.state}`);

test('the list is the four tabs with `v: 2` once the Mac has the panel on, and the phone’s parser reads every row', async () => {
  const t = rig();
  const res = ok(await askSlow(t.p, 'momo.tasks.list'));
  assert.deepEqual(placed(res), ['active:run:c-run:review', 'scheduled:routine:r1:scheduled']);
  assert.equal(res.v, 2);
  const view = parseTaskPanel(res)!;
  assert.deepEqual(
    view.tasks.map((x) => [x.id, x.kind, x.tab, x.state, x.title, x.paused]),
    [
      ['run:c-run', 'run', 'active', 'review', 'Daily brief', false],
      ['routine:r1', 'routine', 'scheduled', 'scheduled', 'Daily brief', false],
    ],
  );
  assert.equal(view.tasks[1].nextAt, LOOPS_NOW + H);
  assert.deepEqual([view.paused, view.now], [false, LOOPS_NOW]);
});

test('with the panel off the list is the classic one, which the phone reads as no panel, and a mark is refused', async () => {
  const t = rig();
  t.tasksPanel.on = false;
  const res = ok(await askSlow(t.p, 'momo.tasks.list'));
  assert.equal(res.v, undefined);
  assert.equal(parseTaskPanel(res), null);
  fail(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: 'done' }), 'failed', /panel is off/);
});

test('the phone marks a run done, archives, deletes and reopens it; each moves it between the tabs', async () => {
  const t = rig();
  const mark = async (what: string) => ok(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: what }));
  assert.equal((await mark('done')).mark, 'done');
  assert.deepEqual(placed(ok(await askSlow(t.p, 'momo.tasks.list'))), ['scheduled:routine:r1:scheduled', 'resolved:run:c-run:done']);
  assert.equal((await mark('archive')).mark, 'archived');
  assert.equal(ok(await askSlow(t.p, 'momo.tasks.list')).tasks[1].state, 'archived');
  assert.equal((await mark('delete')).mark, 'deleted');
  assert.deepEqual(placed(ok(await askSlow(t.p, 'momo.tasks.list'))), ['scheduled:routine:r1:scheduled']);
  assert.equal((await mark('reopen')).mark, null);
  assert.deepEqual(placed(ok(await askSlow(t.p, 'momo.tasks.list'))), ['active:run:c-run:review', 'scheduled:routine:r1:scheduled']);
});

test('the token the Mac gives takes a mark back once; a wrong or spent one is refused', async () => {
  const t = rig();
  const done = ok(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: 'archive' }));
  assert.equal(parseMarked(done).undoToken, done.undoToken);
  const back = ok(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: 'reopen', undoToken: done.undoToken }));
  assert.deepEqual([back.mark, back.undoToken], [null, undefined]);
  assert.equal(parseMarked(back).undoToken, null);
  assert.deepEqual(placed(ok(await askSlow(t.p, 'momo.tasks.list'))), ['active:run:c-run:review', 'scheduled:routine:r1:scheduled']);
  fail(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: 'reopen', undoToken: done.undoToken }), 'failed', /can’t be undone/);
  fail(await askSlow(t.p, MARK_METHOD, { taskId: 'run:other', mark: 'reopen', undoToken: 'made-up' }), 'failed', /can’t be undone/);
});

test('only a run can be marked: a loop, a card or a routine is refused by the Mac, and a bad request by the schema', async () => {
  const t = rig();
  for (const taskId of ['loop:L1', 'card:a1', 'routine:r1'])
    fail(await askSlow(t.p, MARK_METHOD, { taskId, mark: 'done' }), 'failed', /Only a routine run/);
  for (const bad of [
    { mark: 'done' },
    { taskId: 'run:c-run' },
    { taskId: 'run:c-run', mark: 'finish' },
    { taskId: 'bad id', mark: 'done' },
    { taskId: 'run:c-run', mark: 'done', undoToken: 'bad token' },
  ])
    fail(await askSlow(t.p, MARK_METHOD, bad), 'invalid');
  assert.deepEqual(t.taskMarks.list(), {});
  assert.deepEqual(parseParams(MARK_METHOD, { taskId: 'run:c', mark: 'done', extra: 1 }), { taskId: 'run:c', mark: 'done' });
  assert.deepEqual(parseParams(MARK_METHOD, { taskId: 'run:c', mark: 'reopen', undoToken: 'tok-1' }), {
    taskId: 'run:c',
    mark: 'reopen',
    undoToken: 'tok-1',
  });
});

test('a loop the user closed shows under Resolved and Reopen brings it back, through the loop’s own act', async () => {
  const t = rig();
  await t.loops.applyPass(
    {
      add: [
        {
          kind: 'todo',
          text: 'Call mum',
          quote: 'call mum',
          line: { text: 'Call mum', at: LOOPS_NOW - H, turnId: 't1' },
          tz: 'UTC',
          confidence: 'sure',
        },
      ],
      mention: [],
      done: [],
    },
    { chatId: 'momo-main', harness: 'claude' },
  );
  const loopId = t.loops.open()[0].id;
  ok(await askSlow(t.p, 'momo.loops.act', { loopId, action: 'done' }));
  assert.ok(placed(ok(await askSlow(t.p, 'momo.tasks.list'))).includes(`resolved:loop:${loopId}:done`));
  ok(await askSlow(t.p, 'momo.loops.act', { loopId, action: 'reopen' }));
  assert.ok(placed(ok(await askSlow(t.p, 'momo.tasks.list'))).includes(`next:loop:${loopId}:queued`));
  fail(await askSlow(t.p, 'momo.loops.act', { loopId, action: 'erase' }), 'invalid');
});

test('an account MoMo is not allowed for cannot mark: the service and main both refuse (remoteMomo.test.ts holds that no momo.* method is listed for it)', async () => {
  const t = rig({ allowed: false });
  fail(await t.p.ask(MARK_METHOD, { taskId: 'run:c-run', mark: 'done' }), 'forbidden', UNINVITED);
  t.r.service.momoAllowed = () => true;
  fail(await t.p.ask(MARK_METHOD, { taskId: 'run:c-run', mark: 'done' }), 'forbidden', UNINVITED);
  assert.deepEqual(t.taskMarks.list(), {});
});

test('the Mac lists the method for an invited phone, and says so when MoMo is not made yet', async () => {
  const t = rig();
  assert.equal(ok(await t.p.ask('machine.hello')).capabilities.methods.includes(MARK_METHOD), true);
  t.r.service.momo = () => null;
  fail(await t.p.ask(MARK_METHOD, { taskId: 'run:c-run', mark: 'done' }), 'failed', /not ready/);
  assert.equal(typeof methods[MARK_METHOD], 'function');
  assert.equal(typeof PARSERS[MARK_METHOD], 'function');
  assert.ok(MOMO_METHODS.includes(MARK_METHOD));
});

test('the phone’s parser keeps the rows it understands, treats a missing number as none and throws on a reply that is not a list', () => {
  const row = {
    id: 'run:x',
    kind: 'run',
    tab: 'active',
    state: 'review',
    title: 'Brief',
    detail: null,
    dueDay: null,
    ref: 'x',
    at: 5,
    outcome: 'completed',
    nextAt: null,
    paused: false,
  };
  const view = parseTaskPanel({
    v: 2,
    tasks: [
      row,
      { ...row, id: 'run:y', at: 'x', paused: true, outcome: '' },
      { ...row, id: '' },
      { ...row, title: '' },
      { ...row, ref: '' },
      { ...row, kind: 'x' },
      { ...row, tab: 'x' },
      { ...row, state: 'x' },
      'junk',
      null,
    ],
  })!;
  assert.deepEqual(
    view.tasks.map((x) => [x.id, x.at, x.paused, x.outcome]),
    [
      ['run:x', 5, false, 'completed'],
      ['run:y', null, true, null],
    ],
  );
  assert.deepEqual([view.paused, view.now], [false, 0]);
  assert.equal(parseTaskPanel({ tasks: [] }), null);
  for (const bad of [null, [], 'x', {}, { tasks: 'x' }]) assert.throws(() => parseTaskPanel(bad), /Could not read the tasks/);
  assert.equal(parseMarked(null).undoToken, null);
  assert.equal(parseMarked({ undoToken: 't' }).undoToken, 't');
});

test('a mark tells paired phones which part changed, and a loop’s change or a refused mark does not add to it', async () => {
  const t = rig();
  const told = () => t.p.events('momo.changed').map((e: any) => e.area);
  ok(await askSlow(t.p, MARK_METHOD, { taskId: 'run:c-run', mark: 'done' }));
  await settle();
  assert.deepEqual(told(), ['memory']);
  fail(await askSlow(t.p, MARK_METHOD, { taskId: 'loop:L1', mark: 'done' }), 'failed');
  await settle();
  assert.deepEqual(told(), ['memory']);
});
