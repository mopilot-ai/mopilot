// A paired phone's Tasks list (momo.tasks.list: electron/remote/methods/momo.cjs over remote/momoOps.cjs over momoTasks:list): the cards waiting in MoMo's main chat, the open loops and the routine runs, with ids that survive a Mac restart; read while MoMo is paused; refused for an account MoMo is not allowed for, and while MoMo is not ready; and nothing on this path completes a task (a loop is done only by momo.loops.act, a card only by momo.card.answer).
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ok, fail, askSlow, momoRig, MOMO_METHODS, UNINVITED, LOOPS_NOW } from './support/remote-momo-kit.ts';
import { fakeSafe } from './support/momo-memory.ts';
import { parseTasks, TASKS_METHOD } from '../mobile/src/momo/tasksContract';

const require = createRequire(import.meta.url);
const { PARSERS, parseParams } = require('../shared/remote/schema.mjs');
const methods = require('../electron/remote/methods/momo.cjs');
const { OpenLoopStore } = require('../electron/momo/openLoops.cjs');

const D = 86_400_000;
const line = (text: string) => ({
  kind: 'todo',
  text,
  quote: text.toLowerCase(),
  line: { text, at: LOOPS_NOW - D, turnId: 't1' },
  tz: 'UTC',
  confidence: 'sure',
});
async function rig(o: Parameters<typeof momoRig>[0] = {}) {
  const m = momoRig(o);
  await m.loops.applyPass(
    { add: [line('Renew the lease'), line('Call mum')], mention: [], done: [] },
    { chatId: 'momo-main', harness: 'claude' },
  );
  return { ...m, p: m.r.phone('p1') };
}
const ids = (res: any) => res.tasks.map((t: any) => t.id);

test('the phone reads the same list as the Mac: cards first, then loops, then runs, each with its source’s id', async () => {
  const t = await rig();
  t.runs.push({ chatId: 'c-run', taskId: 'r1', startedAt: LOOPS_NOW - 3_600_000 });
  t.controller.state.has = () => true;
  t.controller.state.get = () =>
    ({ approvals: [{ id: 'a1', params: { kind: 'momoAction', momo: { summary: 'Send the mail', source: 'Mail' } } }] }) as any;
  const res = ok(await askSlow(t.p, TASKS_METHOD));
  assert.deepEqual(ids(res), ['card:a1', 'loop:L1', 'loop:L2', 'run:c-run']);
  assert.equal(res.now, LOOPS_NOW);
  assert.equal(res.tasks[0].title, 'Send the mail');
  assert.equal(res.tasks[3].title, 'Daily brief');
  // the phone's own parser reads every row
  assert.deepEqual(
    parseTasks(res).map((x) => [x.id, x.kind, x.state, x.ref]),
    [
      ['card:a1', 'card', 'needs-you', 'a1'],
      ['loop:L1', 'loop', 'needs-you', 'L1'],
      ['loop:L2', 'loop', 'needs-you', 'L2'],
      ['run:c-run', 'run', 'running', 'c-run'],
    ],
  );
});

test('ids survive a Mac restart: a new loop store over the same folder lists the same tasks', async () => {
  const t = await rig();
  const before = ids(ok(await askSlow(t.p, TASKS_METHOD)));
  const again = new OpenLoopStore({ dir: `${t.dir}/loops`, safeStorage: fakeSafe(), now: () => LOOPS_NOW });
  // the same ids come from the saved loops, whatever process reads them
  assert.deepEqual(
    again.open().map((l: any) => `loop:${l.id}`),
    before,
  );
});

test('the loop’s own Done is the only way a task is done: reading never changes one, and a done loop leaves the list', async () => {
  const t = await rig();
  const first = ids(ok(await askSlow(t.p, TASKS_METHOD)));
  assert.deepEqual(ids(ok(await askSlow(t.p, TASKS_METHOD))), first);
  ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L1', action: 'done' }));
  assert.deepEqual(ids(ok(await askSlow(t.p, TASKS_METHOD))), ['loop:L2']);
  ok(await askSlow(t.p, 'momo.loops.act', { loopId: 'L2', action: 'snooze', snooze: 'week' }));
  assert.deepEqual(ids(ok(await askSlow(t.p, TASKS_METHOD))), []);
});

test('read while MoMo is paused, with no main chat yet, and with no params that matter', async () => {
  const t = await rig({ noMainChat: true });
  t.gate.paused = true;
  assert.deepEqual(ids(ok(await askSlow(t.p, TASKS_METHOD, { chatId: 'someone-elses' }))), ['loop:L1', 'loop:L2']);
  assert.deepEqual(parseParams(TASKS_METHOD, { chatId: 'x' }), {});
});

test('an account MoMo is not allowed for gets nothing: the service and main both refuse', async () => {
  const t = await rig({ allowed: false });
  fail(await t.p.ask(TASKS_METHOD), 'forbidden', UNINVITED);
  // main's own check, with the service's gate out of the way
  t.r.service.momoAllowed = () => true;
  fail(await t.p.ask(TASKS_METHOD), 'forbidden', UNINVITED);
});

test('MoMo not made yet: the method says so, as the other reads do', async () => {
  const t = await rig();
  t.r.service.momo = () => null;
  fail(await t.p.ask(TASKS_METHOD), 'failed', /not ready/);
});

test('the method is a thin wrapper listed with MoMo’s other methods', () => {
  assert.equal(typeof methods[TASKS_METHOD], 'function');
  assert.equal(typeof PARSERS[TASKS_METHOD], 'function');
  assert.ok(MOMO_METHODS.includes(TASKS_METHOD));
});

test('the phone’s parser keeps well-formed rows, leaves out the rest and throws on a reply that is not a list', () => {
  const row = { id: 'loop:L1', kind: 'loop', state: 'needs-you', title: 'Call mum', detail: 'call mum', dueDay: '2026-11-04', ref: 'L1' };
  const parsed = parseTasks({
    tasks: [
      row,
      { ...row, id: 'run:x', kind: 'run', state: 'running', detail: null, dueDay: null },
      { ...row, id: '' },
      { ...row, title: '' },
      { ...row, ref: '' },
      { ...row, kind: 'other' },
      { ...row, state: 'done' },
      'junk',
      null,
    ],
  });
  assert.deepEqual(
    parsed.map((x) => [x.id, x.detail, x.dueDay]),
    [
      ['loop:L1', 'call mum', '2026-11-04'],
      ['run:x', null, null],
    ],
  );
  for (const bad of [null, [], 'x', {}, { tasks: 'x' }]) assert.throws(() => parseTasks(bad), /Could not read the tasks/);
});
