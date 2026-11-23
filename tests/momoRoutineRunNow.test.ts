// A routine's Run now and View history (#4975, Tasks › Scheduled): the service starts one run through the scheduler's own path at once (past quiet hours, MoMo paused and the day's limit, needing MoMo allowed, the routine approved and a harness that can run, one run at a time) and says why when nothing starts; the store reads one routine's runs newest first; the two IPC calls are gated and told to the windows; and the Tasks panel's Scheduled row of a routine with a run going says Working, since when.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, sweep, told } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { registerRoutinesIpc } = require('../electron/momo/routinesIpc.cjs');
const { deriveTaskPanel } = require('../electron/momo/tasksPanel.cjs');
const bridge = require('../electron/bridge/momoRoutines.cjs');

const H = 3_600_000;

test('Run now starts a run through the scheduler’s path, in the same isolated chat, and its result reaches MoMo’s main chat', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const chatId = await w.service.runNow(r.id);
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0][1].routineId, r.id);
  assert.equal(w.sent.length, 1);
  assert.equal(w.routines.openRuns().length, 1);
  await w.service.finished({ chatId, text: 'All quiet.', completed: true });
  assert.deepEqual(told(w), [['Inbox sweep', true, 'All quiet.']]);
});

test('Run now runs past quiet hours, MoMo paused and the day’s limit, and a paused routine too', async () => {
  const w = world({ prefs: { momo: { paused: true, routines: { proactivity: 'default', quietHours: { from: '00:00', to: '23:59' } } } } });
  const r = await w.routines.add(sweep, { approved: true });
  await w.routines.update(r.id, { status: 'PAUSED' });
  // the scheduler's own run of the same routine is skipped
  await assert.rejects(w.service.run({ id: r.id, kind: 'momo-routine', rrule: sweep.rrule }), (e: any) => e.reason === 'paused');
  await w.service.runNow(r.id);
  assert.equal(w.started.length, 1);
  // runs beyond the day's limit still start: Run now counts toward none
  const full = world({ prefs: { momo: { routines: { proactivity: 'low', quietHours: null } } } });
  const x = await full.routines.add(sweep, { approved: true });
  for (let i = 0; i < 3; i++) {
    await full.service.runNow(x.id);
    await full.service.finished({ chatId: full.started[i][2], text: 'ok', completed: true });
  }
  assert.equal(full.started.length, 3, 'three runs on a day that allows two');
});

test('Run now says why nothing started: MoMo off, a routine gone or only proposed, one already running, a harness at its limit, none able to run', async () => {
  const off = world({ allowed: false });
  await assert.rejects(
    off.service.runNow('anything'),
    (e: any) => e.code === 'not_allowed' && /not available for this account/.test(e.message),
  );

  const w = world();
  await assert.rejects(w.service.runNow('missing'), /isn’t there any more/);
  const proposed = await w.routines.add({ ...sweep, name: 'Proposed' }, { approved: false });
  await assert.rejects(w.service.runNow(proposed.id), /isn’t there any more/);

  const r = await w.routines.add(sweep, { approved: true });
  const chatId = await w.service.runNow(r.id);
  await assert.rejects(w.service.runNow(r.id), /already running/);
  assert.equal(w.started.length, 1, 'a second click starts nothing');
  await w.service.finished({ chatId, text: 'ok', completed: true });

  w.service.o.atLimit = () => ({ held: 'at its limit' });
  await assert.rejects(w.service.runNow(r.id), /at its usage limit/);
  delete w.service.o.atLimit;

  const none = world({ usable: () => false });
  const n = await none.routines.add(sweep, { approved: true });
  await assert.rejects(none.service.runNow(n.id), /No harness can run MoMo’s routines now/);
  assert.deepEqual(none.chats, [], 'no chat was started');
});

test('Run now closes quietly when MoMo is turned off or the routine removed while its chat starts', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  w.service.o.startChat = async () => (w.setAllowed(false), 'chat-1');
  await assert.rejects(w.service.runNow(r.id), /not available for this account/);
  assert.deepEqual(w.chats, [['discard', 'chat-1']]);

  const v = world();
  const x = await v.routines.add(sweep, { approved: true });
  v.service.o.startChat = async () => (await v.routines.remove(x.id), 'chat-2');
  await assert.rejects(v.service.runNow(x.id), /isn’t there any more/);
  assert.equal(v.routines.openRuns().length, 0);
});

test('the store reads one routine’s runs newest first, and no other routine’s', async () => {
  const w = world();
  const a = await w.routines.add(sweep, { approved: true });
  const b = await w.routines.add({ ...sweep, name: 'Other' }, { approved: true });
  assert.deepEqual(w.routines.runsOf(a.id), []);
  await w.routines.beginRun({ chatId: 'c1', taskId: a.id, kind: 'momo-routine', due: 1 });
  w.c.t += H;
  await w.routines.beginRun({ chatId: 'c2', taskId: a.id, kind: 'momo-routine', due: 2 });
  await w.routines.beginRun({ chatId: 'c3', taskId: b.id, kind: 'momo-routine', due: 3 });
  assert.deepEqual(
    w.routines.runsOf(a.id).map((r: any) => r.chatId),
    ['c2', 'c1'],
  );
});

function rig() {
  const w = world();
  const handlers = new Map<string, Function>();
  const told: string[] = [];
  let allowed = true;
  registerRoutinesIpc({ handle: (ch: string, fn: Function) => handlers.set(ch, fn) } as any, {
    routines: w.routines,
    service: w.service,
    allowed: () => allowed,
    broadcast: (ch: string) => told.push(ch),
  });
  return { w, told, ask: (ch: string, ...a: any[]) => handlers.get(ch)!({}, ...a), setAllowed: (v: boolean) => (allowed = v) };
}

test('runNow and history over IPC: gated, the run’s chat returned, the windows told, the history as when and how each run went', async () => {
  const r = rig();
  const routine = await r.w.routines.add(sweep, { approved: true });
  assert.deepEqual(await r.ask('momoRoutines:history', routine.id), [], 'none yet is an empty list');
  const { chatId } = await r.ask('momoRoutines:runNow', routine.id);
  assert.equal(chatId, r.w.started[0][2]);
  assert.deepEqual(r.told, ['momoRoutines:changed']);
  const going = await r.ask('momoRoutines:history', routine.id);
  assert.deepEqual(going, [{ startedAt: going[0].startedAt, endedAt: null, outcome: 'running' }]);
  await r.w.service.finished({ chatId, text: 'ok', completed: true });
  const done = await r.ask('momoRoutines:history', routine.id);
  assert.equal(done[0].outcome, 'completed');
  assert.equal(typeof done[0].endedAt, 'number');
  // a run closed with no outcome on record still reads as one that did not finish
  await r.w.routines.json.change((s: any) => void (s.runs[0].outcome = undefined));
  assert.equal((await r.ask('momoRoutines:history', routine.id))[0].outcome, 'failed');
  r.setAllowed(false);
  for (const ch of ['momoRoutines:runNow', 'momoRoutines:history'])
    assert.throws(
      () => r.ask(ch, routine.id),
      (e: any) => e.code === 'not_allowed',
      ch,
    );
  assert.equal(Object.hasOwn(bridge, 'runNow') && Object.hasOwn(bridge, 'history'), true);
});

test('the Scheduled row of a routine with a run going says Working since when; a run past its shown time or another routine’s does not', () => {
  const NOW = Date.UTC(2026, 10, 15, 20);
  const routines = [
    { id: 'a', name: 'Alpha', status: 'ACTIVE', rrule: 'R' },
    { id: 'b', name: 'Beta', status: 'ACTIVE', rrule: 'R' },
  ];
  const derive = (runs: any[]) =>
    deriveTaskPanel({
      runs,
      routineName: () => 'Alpha',
      routines,
      nextRun: (_r: string, t: number) => new Date(t + H),
      loops: [],
      cards: [],
      marks: {},
      now: NOW,
    }).filter((t: any) => t.tab === 'scheduled');
  const going = derive([{ chatId: 'c1', taskId: 'a', startedAt: NOW - 5_000 }]);
  assert.deepEqual(
    going.map((t: any) => [t.title, t.state, t.at]),
    [
      ['Alpha', 'scheduled', NOW - 5_000],
      ['Beta', 'scheduled', null],
    ],
  );
  const ended = derive([{ chatId: 'c1', taskId: 'a', startedAt: NOW - 5_000, endedAt: NOW - 1_000, outcome: 'completed' }]);
  assert.deepEqual(
    ended.map((t: any) => t.state),
    ['scheduled', 'scheduled'],
  );
});
