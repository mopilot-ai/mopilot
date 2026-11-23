// The dev host's stand-in for the four-tab Tasks (scripts/mobile-dev-host/fakeMomoTasks.mjs, `momo-tasks [on|off|failed]`): the fake Mac derives every tab from fake data with the real derivation and the real marks, so a run is marked, archived, reopened and undone as on the Mac; `failed` fails the read; `off` is an older Mac; a loop closed on the page is Resolved and reopens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createFakeMomo } from '../scripts/mobile-dev-host/fakeMomo.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { momoTasksScenario } from '../scripts/mobile-dev-host/scenariosMomo.mjs';

const NOW = new Date(2026, 10, 15, 12, 0).getTime();

function rig(o: { panel?: boolean; failing?: boolean; empty?: boolean } = {}) {
  const app = createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => ' M a\n' });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const told: string[] = [];
  const gate = { failing: o.failing ?? false, empty: o.empty ?? false };
  const momo = createFakeMomo({
    app,
    brainChangeAllowed: () => true,
    changed: (a: string) => void told.push(a),
    now: () => NOW,
    tasksPanel: () => o.panel ?? true,
    tasksFailing: () => gate.failing,
    tasksEmpty: () => gate.empty,
  });
  return { momo, told, gate };
}
const where = (res: any) => res.tasks.map((t: any) => `${t.tab}:${t.id}:${t.state}`);

test('every tab has rows: Active (a loop due soon, a run going, one that did not finish, one for review), Up next, Scheduled and Resolved', async () => {
  const { momo } = rig();
  const res: any = await momo.tasks.list();
  assert.deepEqual([res.v, res.paused, res.now], [2, false, NOW]);
  const rows = where(res);
  for (const row of [
    'active:loop:tl-soon:needs-you',
    'active:run:dev-run-1:running',
    'active:run:dev-run-3:failed',
    'active:run:dev-run-2:review',
    'next:loop:tl1:queued',
    'next:loop:tl-open:queued',
    'scheduled:routine:r1:scheduled',
    'scheduled:routine:r2:scheduled',
    'resolved:run:dev-run-4:done',
    'resolved:loop:tl-closed:done',
  ])
    assert.ok(rows.includes(row), row);
  assert.equal(res.tasks.find((t: any) => t.id === 'routine:r2').paused, true);
  assert.equal(typeof res.tasks.find((t: any) => t.id === 'routine:r1').nextAt, 'number');
});

test('the user’s mark moves a run, Undo takes it back once, and a run that is not there is gone', async () => {
  const { momo, told } = rig();
  const done: any = await momo.tasks.mark('run:dev-run-2', 'done');
  assert.deepEqual([done.mark, typeof done.undoToken, told], ['done', 'string', ['memory']]);
  assert.ok(where(await momo.tasks.list()).includes('resolved:run:dev-run-2:done'));
  await momo.tasks.mark('run:dev-run-2', 'reopen', done.undoToken);
  assert.ok(where(await momo.tasks.list()).includes('active:run:dev-run-2:review'));
  await assert.rejects(momo.tasks.mark('run:dev-run-2', 'reopen', done.undoToken), /can’t be undone/);
  await assert.rejects(momo.tasks.mark('run:nope', 'done'), /That task is gone\./);
  await assert.rejects(momo.tasks.mark('loop:tl1', 'done'), /That task is gone\./);
});

test('a loop closed on the page is Resolved and reopens through the loop’s own act', async () => {
  const { momo } = rig();
  await momo.loops.act('tl1', { action: 'dismiss' });
  assert.ok(where(await momo.tasks.list()).includes('resolved:loop:tl1:dismissed'));
  await momo.loops.act('tl1', { action: 'reopen' });
  assert.ok(where(await momo.tasks.list()).includes('next:loop:tl1:queued'));
});

test('Pause all shows in the list, and a failing read fails with the Mac’s words', async () => {
  const { momo, gate } = rig();
  momo.prefs.set({ paused: true });
  assert.equal(((await momo.tasks.list()) as any).paused, true);
  gate.failing = true;
  await assert.rejects(momo.tasks.list(), /MoMo could not read its tasks\./);
});

test('without the panel the fake answers the classic list, as it did', async () => {
  const { momo } = rig({ panel: false });
  const res: any = await momo.tasks.list();
  assert.equal(res.v, undefined);
  assert.deepEqual(res.tasks.map((t: any) => t.kind).sort(), ['loop', 'run']);
});

test('momo-tasks failed lists the method and fails the read; on and off clear it', async () => {
  const log: string[] = [];
  const bench: any = { momo: true, brain: false, tasks: true };
  const controls = createControls({
    bench,
    relayClient: () => null,
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    momoTaskCard: async () => false,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: (l: string) => void log.push(l),
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  } as any);
  assert.match(
    await controls.momoTasks('failed'),
    /^momo\.tasks\.list is on \(reading fails: the phone says it could not read its tasks\): the phone learns it/,
  );
  assert.deepEqual([bench.tasks, bench.tasksFailed], [true, true]);
  assert.match(log.at(-1)!, /lists momo\.tasks\.list, and its read fails/);
  await controls.momoTasks(true);
  assert.equal(bench.tasksFailed, false);
  await controls.momoTasks('failed');
  await controls.momoTasks(false);
  assert.deepEqual([bench.tasks, bench.tasksFailed], [false, false]);
});

test('the scenario reads on, off and failed, and refuses anything else with the console’s own words', async () => {
  const seen: unknown[] = [];
  const onOff = (arg: string, usage: string) => {
    if (arg !== 'on' && arg !== 'off') throw new Error(`Say on or off: run ${usage}`);
    return arg === 'on';
  };
  const s = momoTasksScenario(() => ({ momoTasks: (m: boolean | 'failed' | 'empty') => (seen.push(m), 'done') }), onOff);
  assert.equal(s.usage, 'momo-tasks [on|off|failed|empty]');
  assert.match(s.about, /four tabs/);
  assert.equal(await s.run([]), 'done');
  await s.run(['off']);
  await s.run(['failed']);
  await s.run(['empty']);
  assert.deepEqual(seen, [true, false, 'failed', 'empty']);
  assert.throws(() => s.run(['maybe']), /Say on or off: run momo-tasks \[on\|off\]/);
});

test('a fake that is only told the panel is on reads without failing', async () => {
  const app = createFakeApp({ repo: '/repo', now: () => NOW, sleep: async () => undefined, status: async () => ' M a\n' });
  app.bind({ attached: true, onFeedEvent: () => undefined, onSessionPatch: () => undefined });
  const momo = createFakeMomo({ app, brainChangeAllowed: () => true, changed: () => undefined, now: () => NOW, tasksPanel: () => true });
  assert.equal(((await momo.tasks.list()) as any).v, 2);
});

test('momo-tasks empty lists the method with no task in any tab, raises no card, and on brings the rows back', async () => {
  const { momo, gate } = rig({ empty: true });
  assert.deepEqual(await momo.tasks.list(), { v: 2, tasks: [], paused: false, now: NOW });
  gate.empty = false;
  assert.ok(((await momo.tasks.list()) as any).tasks.length > 5);
  let raised = 0;
  const bench: any = { momo: true, brain: false, tasks: true };
  const controls = createControls({
    bench,
    relayClient: () => null,
    cutMac: () => undefined,
    momoSwitched: () => undefined,
    momoTaskCard: async () => (raised++, true),
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: () => undefined,
    pushRequest: async () => 'sent',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  } as any);
  assert.match(
    await controls.momoTasks('empty'),
    /^momo\.tasks\.list is on \(no tasks at all: every tab shows its empty line\): the phone learns it/,
  );
  assert.deepEqual([bench.tasks, bench.tasksFailed, bench.tasksEmpty, raised], [true, false, true, 0]);
  await controls.momoTasks(true);
  assert.deepEqual([bench.tasksEmpty, raised], [false, 1]);
});
