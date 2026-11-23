// MoMo's routines in the app's one scheduler (electron/momo/schedulerTasks.cjs, electron/platform/scheduler.cjs, #2139): MoMo's tasks run beside the user's and apart from them, each time once; a run that declines its time is recorded as skipped (silently), like a missed one; a missed time within a week is caught up once.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Scheduler, RunSkipped } = require('../electron/platform/scheduler.cjs');
const { RunLedger } = require('../electron/platform/runLedger.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { withMomoTasks, isMomoTask, MOMO_FAILED } = require('../electron/momo/schedulerTasks.cjs');

const DAY = 86_400_000;
/** 2030-03-10 08:00:30 local, the morning daylight saving began */
const START = new Date(2030, 2, 10, 8, 0, 30).getTime();
const coding = { id: 't1', name: 'Check', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', created_at: 1 };
const routine = { id: 'momo.r1', kind: 'momo-routine', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', created_at: 1 };

function world(
  t: any,
  o: { momo?: any[] | null; tasks?: any[]; run?: (task: any) => Promise<string>; sessions?: any; enabled?: () => boolean } = {},
) {
  let clock = START;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.baseline'), '1');
  const ledger = new RunLedger({ dir, now: () => clock });
  const log: any[] = [];
  const momoTasks = o.momo === undefined ? [routine] : o.momo;
  const source = {
    tasks: momoTasks,
    list: async () => source.tasks ?? [],
    validate: async (task: any) => (source.tasks ?? []).find((x: any) => x.id === task.id) ?? null,
    run: o.run ?? (async (task: any) => (log.push(['momo.run', task.id]), `momo-chat-${task.id}`)),
    notify: () => assert.fail('MoMo makes no app notification'),
    failed: (task: any, error: any) => log.push(['momo.failed', task.id, error.message]),
  };
  let up: any = o.momo === null ? null : source;
  const tasks = withMomoTasks(
    {
      list: async () => o.tasks ?? [coding],
      validate: async (task: any) => task,
      run: async (task: any) => (log.push(['run', task.id]), `chat-${task.id}`),
      notify: (chatId: string, task: any) => log.push(['notify', chatId, task.id]),
    },
    () => up,
  );
  const s = new Scheduler({
    enabled: o.enabled ?? (() => true),
    ...tasks,
    sessions: o.sessions ?? new SessionStore(),
    ledger,
    now: () => clock,
    tickMs: 0,
    log: (m: string) => log.push(['log', m]),
  });
  return { s, ledger, log, source, setUp: (v: any) => (up = v), advance: (ms: number) => (clock += ms), at: () => clock };
}

test('MoMo’s tasks run on MoMo’s service and the user’s on theirs, each time once; only the user’s make notices', async (t) => {
  const w = world(t);
  await w.s.tick();
  await w.s.tick();
  assert.deepEqual(
    w.log.filter((l) => l[0] !== 'log'),
    [
      ['run', 't1'],
      ['notify', 'chat-t1', 't1'],
      ['momo.run', 'momo.r1'],
    ],
  );
  assert.equal((await w.ledger.list('momo.r1'))[0].chatId, 'momo-chat-momo.r1');
  // the next morning, once more each
  w.advance(DAY);
  await w.s.tick();
  assert.equal(w.log.filter((l) => l[0] === 'momo.run').length, 2);
});

test('a run that declines its time is kept as skipped with its reason, and nobody is told or notified', async (t) => {
  const w = world(t, {
    momo: [routine],
    run: async () => {
      throw new RunSkipped('quiet-hours');
    },
  });
  await w.s.tick();
  const [record] = await w.ledger.list('momo.r1');
  assert.deepEqual([record.status, record.reason], ['skipped', 'quiet-hours']);
  const momo = w.log.filter((l) => l[0].startsWith('momo.'));
  assert.deepEqual(momo, [], 'a skipped time says nothing to MoMo');
  await w.s.tick();
  assert.equal((await w.ledger.list('momo.r1')).length, 1, 'the time was handled');
});

test('a missed time within a week is caught up once; one older than a week is skipped as missed', async (t) => {
  const w = world(t, { momo: [routine], tasks: [] });
  // MoPilot was closed since 8:00 two days ago: the latest time catches up, late
  w.advance(2 * DAY + 3 * 3600_000);
  await w.s.tick();
  assert.deepEqual(
    w.log.filter((l) => l[0].startsWith('momo.')),
    [['momo.run', 'momo.r1']],
  );
  assert.equal((await w.ledger.list('momo.r1'))[0].catchUp, true, 'late: a catch-up');
  // its one time (8:00 this morning) found eight days later
  const once = { ...routine, rrule: 'FREQ=DAILY;DTSTART=20300310T150000Z;COUNT=1' };
  const late = world(t, { momo: [once], tasks: [] });
  late.advance(8 * DAY);
  await late.s.tick();
  assert.deepEqual(
    (await late.ledger.list('momo.r1')).map((x: any) => [x.status, x.reason]),
    [['skipped', 'missed']],
  );
  assert.deepEqual(
    late.log.filter((l) => l[0].startsWith('momo.')),
    [],
    'and nothing is told',
  );
});

test('a time while the previous run still goes is skipped, silently', async (t) => {
  const sessions = new SessionStore();
  const w = world(t, { momo: [routine], tasks: [], sessions });
  await w.s.tick();
  sessions.patch('momo-chat-momo.r1', { turn: 'running' });
  w.advance(DAY);
  await w.s.tick();
  assert.deepEqual(
    (await w.ledger.list('momo.r1')).map((x: any) => x.reason ?? x.status),
    ['previous-running', 'started'],
  );
  assert.equal(w.log.filter((l) => l[0] === 'momo.run').length, 1, 'the second time did not run');
});

test('without MoMo’s service there are no MoMo tasks; a listing that fails leaves the user’s tasks running', async (t) => {
  const none = world(t, { momo: null });
  await none.s.tick();
  assert.deepEqual(
    none.log.filter((l) => l[0] !== 'log').map((l) => l[0]),
    ['run', 'notify'],
  );
  const broken = world(t);
  broken.source.list = async () => {
    throw new Error('Routines unreadable');
  };
  await broken.s.tick();
  assert.deepEqual(
    broken.log.filter((l) => l[0] !== 'log').map((l) => l[1]),
    ['t1', 'chat-t1'],
  );
});

test('MoMo’s service went away between the check and the run: the time is kept as skipped, not allowed', async (t) => {
  const w = world(t, { momo: [routine], tasks: [] });
  let checks = 0;
  // the check before the claim is its last look: the service goes right after it
  w.source.validate = async (task: any) => {
    if (++checks === 2) w.setUp(null);
    return task;
  };
  await w.s.tick();
  const [record] = await w.ledger.list('momo.r1');
  assert.deepEqual([record.status, record.reason], ['skipped', 'not-allowed']);
  assert.equal(w.log.filter((l) => l[0].startsWith('momo.')).length, 0, 'nobody to tell');
});

test('a routine removed before its time is claimed doesn’t run; a user task with a MoMo-like id or kind never reaches MoMo', async (t) => {
  const gone = world(t, { momo: [routine], tasks: [] });
  gone.source.validate = async () => null;
  await gone.s.tick();
  assert.equal(gone.log.filter((l) => l[0] === 'momo.run').length, 0);
  assert.match(gone.log.find((l) => l[0] === 'log')[1], /MoMo's routine "momo.r1" no longer exists/);
  // a scheduled task the user made with kind momo-routine (and no MoMo id) runs as a scheduled task
  const lookalike = { ...coding, id: 'momo-lookalike', kind: 'momo-routine' };
  const w = world(t, { momo: [], tasks: [lookalike] });
  await w.s.tick();
  assert.deepEqual(w.log.filter((l) => l[0] !== 'log')[0], ['run', 'momo-lookalike']);
  // the same id from both sides: ambiguous, neither runs
  const twice = world(t, { momo: [routine], tasks: [{ ...routine, kind: undefined }] });
  await twice.s.tick();
  assert.equal(twice.log.filter((l) => l[0] === 'run' || l[0] === 'momo.run').length, 0);
  assert.equal(isMomoTask({ id: 'momo.x', kind: 'other' }), false);
  assert.equal(isMomoTask(null), false);
});

test('the user’s tasks keep their own skipped times and notices (and none when the scheduler has no notifier)', async () => {
  const told: any[] = [];
  const tasks = withMomoTasks(
    { list: async () => [coding], validate: async (x: any) => x, run: async () => 'c', skipped: (...a: any[]) => told.push(a) },
    () => null,
  );
  await tasks.list();
  tasks.skipped(coding, 5, 'missed');
  assert.deepEqual(told, [[coding, 5, 'missed']]);
  assert.equal(tasks.notify('c', coding, {}), undefined);
});

test('“run schedules” off stops the user’s tasks, not MoMo’s; the time it was off is no gap for MoMo’s', async (t) => {
  let on = false;
  const w = world(t, { enabled: () => on });
  await w.s.tick();
  assert.deepEqual(
    w.log.filter((l) => l[0] !== 'log'),
    [['momo.run', 'momo.r1']],
  );
  // a day later, schedules turned on and off again: MoMo's next time still runs, the user's doesn't
  w.advance(DAY);
  on = true;
  w.s.settingsChanged(true);
  on = false;
  w.s.settingsChanged(false);
  await w.s.tick();
  assert.equal(w.log.filter((l) => l[0] === 'momo.run').length, 2);
  assert.equal(w.log.filter((l) => l[0] === 'run').length, 0);
  // with no MoMo tasks, schedules off is a check that looks at nothing
  const plain = new Scheduler({
    enabled: () => false,
    list: async () => assert.fail('nothing is listed'),
    run: async () => 'x',
    sessions: new SessionStore(),
    ledger: w.ledger,
    now: () => w.at(),
    tickMs: 0,
  });
  await plain.tick();
});

test('a MoMo run that fails: MoMo’s chat is told what went wrong; the shared ledger gets a code, never the text', async (t) => {
  const w = world(t, {
    momo: [routine],
    tasks: [],
    run: async () => {
      throw Object.assign(new Error('Inbox for ana@example.com unreadable'), { chatId: 'momo-chat-9' });
    },
  });
  await w.s.tick();
  assert.deepEqual(
    w.log.filter((l) => l[0] === 'momo.failed'),
    [['momo.failed', 'momo.r1', 'Inbox for ana@example.com unreadable']],
  );
  const [record] = await w.ledger.list('momo.r1');
  assert.deepEqual([record.status, record.reason, record.chatId], ['failed', MOMO_FAILED, undefined]);
  const files = fs.readdirSync(w.ledger.dir, { recursive: true }).map(String);
  for (const f of files.filter((n) => n.endsWith('.json')))
    assert.doesNotMatch(fs.readFileSync(path.join(w.ledger.dir, f), 'utf8'), /ana@example|unreadable/);
  assert.ok(!w.log.some((l) => l[0] === 'log' && /ana@example/.test(l[1])), 'nor the scheduler’s log');
  // a service with no failure keeper still fails with the code
  delete (w.source as any).failed;
  w.advance(DAY);
  await w.s.tick();
  assert.equal((await w.ledger.list('momo.r1'))[0].reason, MOMO_FAILED);
});
