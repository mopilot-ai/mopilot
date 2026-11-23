// The scheduled tasks a Host keeps and fires itself (host/src/schedules.mjs, shared/host/hostSchedules.mjs, #2709 phase 2): each due time runs once, across a restart too; a time too old or a previous run still working is skipped, an agent not signed in on the machine fails the run with the reason; the app's set replaces what was kept; runs are read from a cursor; and the protocol serves the two methods only to an end that declares the feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createHostSchedules, readyOnOwnSignIn, hostSchedulesFor } from '../host/src/schedules.mjs';
import { wireTaskOf, scheduleParsers, MAX_TASKS, SCHEDULES_FEATURE } from '../shared/host/hostSchedules.mjs';
import * as S from '../shared/host/schema.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';

const require = createRequire(import.meta.url);
const { RRule } = require('rrule');
const { scheduleRules } = require('../shared/schedule.mjs');
const rules = scheduleRules(RRule);

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 9, 0, 30);
const task = (o: any = {}) => ({
  id: 'nightly',
  name: 'Nightly',
  rrule: 'FREQ=MINUTELY;INTERVAL=1',
  zone: 'UTC',
  prompt: 'run the tests',
  harness: 'kimi',
  cwd: '/srv/app',
  status: 'ACTIVE',
  scheduleFrom: 0,
  ...o,
});

function world(t: any, o: { ready?: any; start?: any; busy?: any; dir?: string } = {}) {
  const dir = o.dir ?? tmp(t);
  let clock = T0;
  const started: any[] = [];
  const reports: string[] = [];
  let n = 0;
  const make = () =>
    createHostSchedules({
      file: path.join(dir, 'schedules.json'),
      rules,
      start: o.start ?? (async (p: any) => void started.push(p)),
      ready: o.ready ?? (async () => ({ ok: true })),
      busy: o.busy,
      mintChatId: (h: string) => `acp:${h}:c${++n}`,
      now: () => clock,
      report: (m: string) => reports.push(m),
    });
  return { dir, make, s: make(), started, reports, at: (ms: number) => (clock = ms), advance: (ms: number) => (clock += ms) };
}

test('nextAt is when the next task is due: the earliest of them, and null with none or only ones that never come', (t) => {
  const w = world(t);
  assert.equal(w.s.nextAt(), null, 'no task');
  w.s.sync([
    task({ id: 'a', rrule: 'FREQ=HOURLY;INTERVAL=1' }),
    task({ id: 'b', rrule: 'FREQ=MINUTELY;INTERVAL=5' }),
    task({ id: 'c', rrule: 'not a rule' }),
  ]);
  // T0 is 09:00:30, so the next five-minute mark is 09:05, before the next hour
  assert.equal(w.s.nextAt(), Date.UTC(2026, 10, 4, 9, 5, 0));
  w.s.sync([task({ id: 'c', rrule: 'not a rule' })]);
  assert.equal(w.s.nextAt(), null);
});

test('each due time runs once, with the task’s prompt and folder, and is recorded for the app; a restart does not run it again', async (t) => {
  const w = world(t);
  w.s.sync([task({ model: 'm1' })]);
  await w.s.tick();
  assert.equal(w.started.length, 1);
  assert.deepEqual(w.started[0], { chatId: 'acp:kimi:c1', task: wireTaskOf(task({ model: 'm1' })) });
  await w.s.tick();
  assert.equal(w.started.length, 1, 'the same minute runs once');
  const again = w.make();
  await again.tick();
  assert.equal(w.started.length, 1, 'a restarted Host keeps what it handled');
  w.advance(MIN);
  await again.tick();
  assert.equal(w.started.length, 2);
  const { runs, next } = again.runs(0);
  assert.deepEqual(
    runs.map((r: any) => [r.seq, r.taskId, r.status, r.chatId, r.harness]),
    [
      [1, 'nightly', 'started', 'acp:kimi:c1', 'kimi'],
      [2, 'nightly', 'started', 'acp:kimi:c2', 'kimi'],
    ],
  );
  assert.equal(next, 2);
  assert.deepEqual([again.runs(2).runs, again.runs(2).next], [[], 2]);
  // the store keeps its name across a restart: the app's cursor stays good
  assert.equal(again.runs(0).store, w.s.runs(0).store);
  assert.equal(runs[0].scheduledFor, Date.UTC(2026, 10, 4, 9, 0));
  assert.equal(runs[0].cwd, '/srv/app');
  assert.equal(runs[0].projectId, undefined);
  again.sync([task({ projectId: 'p1' })]);
  w.advance(MIN);
  await again.tick();
  assert.equal(again.runs(2).runs[0].projectId, 'p1');
});

test('paused, not yet scheduled from, or with no time left: nothing runs', async (t) => {
  const w = world(t);
  w.s.sync([
    task({ id: 'paused', status: 'PAUSED' }),
    task({ id: 'later', scheduleFrom: T0 + MIN }),
    task({ id: 'bad', rrule: 'NOT A RULE' }),
  ]);
  await w.s.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.s.runs(0).runs, []);
});

test('a time too old is skipped as missed, a previous run still working skips the next, and a machine that can’t run it fails with the reason', async (t) => {
  // the Host came back after more than 7 days: the latest due time is recorded as missed, not run
  const old = world(t);
  old.s.sync([task({ rrule: 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0' })]);
  await old.s.tick();
  assert.deepEqual(old.started, []);
  assert.deepEqual(
    old.s.runs(0).runs.map((r: any) => [r.status, r.reason]),
    [['skipped', 'missed']],
  );

  let running = true;
  const busy = world(t, { busy: () => running });
  busy.s.sync([task()]);
  await busy.s.tick();
  busy.advance(MIN);
  await busy.s.tick();
  running = false;
  busy.advance(MIN);
  await busy.s.tick();
  assert.deepEqual(
    busy.s.runs(0).runs.map((r: any) => [r.status, r.reason ?? null]),
    [
      ['started', null],
      ['skipped', 'previous-running'],
      ['started', null],
    ],
  );

  const out = world(t, { ready: async () => ({ ok: false, reason: "Kimi Code isn't signed in on this machine." }) });
  out.s.sync([task()]);
  await out.s.tick();
  assert.deepEqual(out.started, []);
  assert.deepEqual(
    out.s.runs(0).runs.map((r: any) => [r.status, r.reason]),
    [['failed', "Kimi Code isn't signed in on this machine."]],
  );

  const broken = world(t, {
    start: async () => {
      throw new Error('That folder does not exist.');
    },
  });
  broken.s.sync([task()]);
  await broken.s.tick();
  assert.deepEqual(
    broken.s.runs(0).runs.map((r: any) => [r.status, r.chatId, r.reason]),
    [['failed', 'acp:kimi:c1', 'That folder does not exist.']],
  );
  const thrown = world(t, {
    start: async () => {
      throw 'plain';
    },
  });
  thrown.s.sync([task()]);
  await thrown.s.tick();
  assert.equal(thrown.s.runs(0).runs[0].reason, 'plain');
});

test('the app’s set replaces what was kept: a task left out stops, and keeps what it handled if it comes back; only the newest runs are kept', async (t) => {
  const w = world(t);
  w.s.sync([task(), task({ id: 'other' })]);
  await w.s.tick();
  assert.equal(w.started.length, 2);
  assert.deepEqual(w.s.sync([task({ id: 'other' })]), { held: 1 });
  await w.s.tick();
  w.advance(MIN);
  await w.s.tick();
  assert.deepEqual(
    w.started.map((s: any) => s.task.id),
    ['nightly', 'other', 'other'],
  );
  // a task sent again later keeps the times it handled before it was dropped: it runs the minute it never handled, not its first one again
  w.s.sync([task({ id: 'other' }), task()]);
  await w.s.tick();
  assert.deepEqual(
    w.started.map((s: any) => s.task.id),
    ['nightly', 'other', 'other', 'nightly'],
  );
  const nightly = w.s.runs(0).runs.filter((r: any) => r.taskId === 'nightly');
  assert.deepEqual(
    nightly.map((r: any) => r.scheduledFor),
    [Date.UTC(2026, 10, 4, 9, 0), Date.UTC(2026, 10, 4, 9, 1)],
  );
  // a long absence keeps the newest 500 runs
  for (let i = 0; i < 260; i++) {
    w.advance(MIN);
    await w.s.tick();
  }
  const all = w.s.runs(0);
  assert.equal(all.runs.length, 200);
  assert.equal(all.runs[0].seq, w.s.runs(0).runs[0].seq);
  assert.ok(all.runs[0].seq > 1);
});

test('a check that throws is reported and the others still run; an unreadable file keeps nothing and says so; start checks on an interval', async (t) => {
  const throwing = world(t, {
    ready: async (h: string) => {
      if (h === 'boom') throw new Error('probe failed');
      return { ok: true };
    },
  });
  throwing.s.sync([task({ id: 'a', harness: 'boom' }), task({ id: 'b' })]);
  await throwing.s.tick();
  assert.deepEqual(throwing.reports, ['scheduled task a: probe failed']);
  assert.deepEqual(
    throwing.started.map((s: any) => s.task.id),
    ['b'],
  );
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'schedules.json'), '{not json');
  const unreadable = world(t, { dir });
  assert.match(unreadable.reports[0], /could not be read/);
  assert.deepEqual([unreadable.s.runs(0).runs, unreadable.s.runs(0).next], [[], 0]);
  // a file of another shape keeps the parts it can
  fs.writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify({ tasks: 'x', runs: 'y', seq: 'z' }));
  assert.deepEqual(world(t, { dir }).s.runs(0).runs, []);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = world(t);
  w.s.sync([task()]);
  const stop = w.s.start();
  await w.s.tick();
  const before = w.started.length;
  w.advance(MIN);
  t.mock.timers.tick(30_000);
  await w.s.tick();
  assert.ok(w.started.length > before);
  stop();
});

test('readyOnOwnSignIn: an agent runs a fired task only when installed and signed in on the machine itself', async () => {
  const ready = readyOnOwnSignIn(async () => [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false },
    { id: 'kimi', detected: false, signedIn: false },
  ]);
  assert.deepEqual(await ready('claude'), { ok: true });
  assert.deepEqual(await ready('codex'), { ok: false, reason: "Codex isn't signed in on this machine." });
  assert.deepEqual(await ready('kimi'), { ok: false, reason: "Kimi Code isn't installed on this machine." });
  assert.equal((await ready('gone')).ok, false);
});

test('the wire task and the two parsers refuse what the Host can’t keep', () => {
  assert.equal(SCHEDULES_FEATURE, 'schedules');
  assert.ok(S.FEATURES.includes('schedules'));
  assert.deepEqual(S.REQUIRES['host.scheduleSync'], ['schedules']);
  const ok = wireTaskOf(task({ model: 'm', effort: 'high', projectId: 'p1', name: 7 }));
  assert.deepEqual([ok.model, ok.effort, ok.projectId, ok.name], ['m', 'high', 'p1', '']);
  for (const [bad, why] of [
    [null, /needed/],
    [task({ id: '../x' }), /task id/],
    [task({ rrule: '' }), /schedule/],
    [task({ zone: 'Mars/Base' }), /time zone/],
    [task({ prompt: 7 }), /prompt/],
    [task({ harness: 'Not Agent' }), /agent/],
    [task({ cwd: '' }), /folder/],
    [task({ status: 'ON' }), /status/],
    [task({ scheduleFrom: -1 }), /time/],
    [task({ model: '' }), /model/],
  ] as const)
    assert.throws(() => wireTaskOf(bad), why);
  assert.deepEqual(scheduleParsers['host.scheduleSync']({ tasks: [task()] }).tasks, [wireTaskOf(task())]);
  assert.throws(() => scheduleParsers['host.scheduleSync']({ tasks: 'x' }), /at most/);
  assert.throws(
    () => scheduleParsers['host.scheduleSync']({ tasks: Array.from({ length: MAX_TASKS + 1 }, (_, i) => task({ id: `t${i}` })) }),
    /at most/,
  );
  assert.throws(() => scheduleParsers['host.scheduleSync']({ tasks: [task(), task()] }), /once/);
  assert.deepEqual(scheduleParsers['host.scheduleRuns']({ after: 3 }), { after: 3 });
  assert.throws(() => scheduleParsers['host.scheduleRuns']({ after: -1 }), /cursor/);
  assert.deepEqual(S.parseParams('host.scheduleRuns', { after: 0 }), { after: 0 });
});

test('the protocol serves the schedule methods to an end that declares them, refuses an older one, and a fired run starts its chat at epoch 0', async (t) => {
  const dir = tmp(t);
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const sends: any[] = [];
  const prepared: any[] = [];
  const runtime: any = {
    host: Object.assign(new EventEmitter(), { cancel: () => undefined }),
    send: async (p: any) => (sends.push(p), { action: 'started', id: 'm', turnId: 'm' }),
    prepare: async (p: any) => void prepared.push(p),
  };
  const kept = { sync: (tasks: any[]) => ({ held: tasks.length }), runs: (after: number) => ({ runs: [], next: after }) };
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({}) });
  protocol.keepSchedules(kept as any);
  const conn = protocol.connection(() => undefined);
  await conn.call('host.hello', S.helloParams());
  assert.deepEqual(await conn.call('host.scheduleSync', { tasks: [task()] }), { held: 1 });
  assert.deepEqual(await conn.call('host.scheduleRuns', { after: 4 }), { runs: [], next: 4 });
  const old = protocol.connection(() => undefined);
  await old.call('host.hello', { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'schedules') });
  await assert.rejects(old.call('host.scheduleRuns', { after: 0 }), (e: any) => e.code === 'feature_missing');
  const none = createProtocol({ runtime, epochs, guard, status: () => ({}) }).connection(() => undefined);
  await none.call('host.hello', S.helloParams());
  await assert.rejects(none.call('host.scheduleSync', { tasks: [] }), (e: any) => e.code === 'unsupported');
  // a fired run: a basic agent's chat starts as acp:<agent>, Claude Code as itself, with the task's folder, prompt and model
  await protocol.startScheduled({ chatId: 'acp:kimi:r1', task: wireTaskOf(task({ model: 'm1' })) });
  await protocol.startScheduled({ chatId: 'claude:00000000-0000-4000-8000-000000000002', task: wireTaskOf(task({ harness: 'claude' })) });
  assert.deepEqual(
    sends.map((s) => [s.key, s.text, s.cwd, s.pick?.model ?? null]),
    [
      ['acp:kimi:r1', 'run the tests', '/srv/app', 'm1'],
      ['claude:00000000-0000-4000-8000-000000000002', 'run the tests', '/srv/app', null],
    ],
  );
  assert.deepEqual(prepared, [{ chatId: 'claude:00000000-0000-4000-8000-000000000002', harness: 'claude', cwd: '/srv/app' }]);
  assert.equal(epochs.current('acp:kimi:r1'), 0);
});

test('with no chat id maker or clock given, a run’s chat gets a Host id for its agent; a check that throws a non-error is reported as it is', async (t) => {
  const dir = tmp(t);
  const started: any[] = [];
  const reports: string[] = [];
  const s = createHostSchedules({
    file: path.join(dir, 'schedules.json'),
    rules,
    start: async (p: any) => void started.push(p.chatId),
    ready: async (h: string) => {
      if (h === 'odd') throw 'not an error';
      return { ok: true };
    },
    report: (m: string) => reports.push(m),
  });
  s.sync([task({ id: 'k' }), task({ id: 'c', harness: 'claude' }), task({ id: 'x', harness: 'codex' }), task({ id: 'o', harness: 'odd' })]);
  await s.tick();
  assert.match(started[0], /^acp:kimi:[0-9a-f-]{36}$/);
  assert.match(started[1], /^claude:[0-9a-f-]{36}$/);
  assert.match(started[2], /^[0-9a-f-]{36}$/);
  // the real clock may cross a minute between the sync's check and this one, which is then a second due time of the same task: its report is the same line
  assert.deepEqual([...new Set(reports)], ['scheduled task o: not an error']);
});

test('a Host that stops while starting a run records it as interrupted when it is back, with the chat it was starting', async (t) => {
  const dir = tmp(t);
  let release: () => void = () => undefined;
  const w = world(t, { dir, start: () => new Promise<void>((r) => (release = r)) });
  w.s.sync([task()]);
  void w.s.tick();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  // the Host stops here: a new one reads the same file
  const back = world(t, { dir });
  assert.deepEqual(
    back.s.runs(0).runs.map((r: any) => [r.status, r.chatId, r.reason]),
    [['failed', 'acp:kimi:c1', 'The machine restarted while starting this run.']],
  );
  // and does not run that time again
  await back.s.tick();
  assert.deepEqual(back.started, []);
  release();
});

test('the Host’s schedules as the CLI makes them: kept in its data folder, started through the protocol, a running chat’s task skipped', async (t) => {
  const dir = tmp(t);
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const started: any[] = [];
  const running = new Set<string>();
  const s = hostSchedulesFor({
    dataDir: dir,
    rules,
    protocol: { startScheduled: (p: any) => started.push(p.chatId) },
    harnesses: async () => [{ id: 'kimi', detected: true, signedIn: true }],
    state: { has: (id: string) => running.has(id), get: () => ({ turn: 'running' }) },
    report: () => undefined,
  });
  s.sync([task()]);
  await s.tick();
  assert.equal(started.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'schedules.json')));
  running.add(started[0]);
  t.mock.timers.tick(MIN);
  await s.tick();
  assert.equal(started.length, 1, 'the previous run still works');
  assert.equal(s.runs(0).runs.at(-1)?.reason, 'previous-running');
});

test('a task changed while its readiness is checked does not start as it was; the task as it is now still runs (#3618)', async (t) => {
  for (const [label, next] of [
    ['removed', []],
    ['paused', [task({ status: 'PAUSED' })]],
    ['revised', [task({ prompt: 'run the linter' })]],
  ] as const) {
    let release: () => void = () => undefined;
    let held = true;
    const w = world(t, {
      ready: () =>
        held
          ? new Promise((resolve) => {
              release = () => resolve({ ok: true });
            })
          : Promise.resolve({ ok: true }),
    });
    w.s.sync([task()]);
    // the check is waiting on readiness; the app's set changes meanwhile
    await new Promise((r) => setImmediate(r));
    held = false;
    w.s.sync(next as any);
    release();
    await w.s.tick();
    assert.ok(
      w.started.every((s: any) => s.task.prompt !== 'run the tests'),
      `${label}: the task as it was before the change never starts`,
    );
    assert.ok(
      w.s.runs(0).runs.every((r: any) => r.status !== 'started' || r.chatId === w.started[0]?.chatId),
      `${label}: no run is recorded for the obsolete task`,
    );
    if (label === 'revised') {
      assert.deepEqual(
        w.started.map((s: any) => s.task.prompt),
        ['run the linter'],
        'the revised task runs its due time, which the obsolete one gave back',
      );
    } else {
      assert.deepEqual(w.started, [], `${label}: nothing runs`);
      // brought back as it is now, the due time it never ran is still its own
      w.s.sync([task({ prompt: 'run the linter' })]);
      await w.s.tick();
      assert.deepEqual(
        w.started.map((s: any) => s.task.prompt),
        ['run the linter'],
        `${label}: the task as it is now runs later`,
      );
    }
  }
});

test('a later task the same check had not reached yet is read as it is then; a revised task that ran before keeps the time it ran (#3618)', async (t) => {
  let release: () => void = () => undefined;
  let hold = false;
  const w = world(t, {
    ready: (h: string) =>
      hold && h === 'kimi'
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
  });
  w.s.sync([task()]);
  await w.s.tick();
  assert.equal(w.started.length, 1, 'the 9:00 time ran');
  // 9:01: the first task waits on readiness while the app drops the second one and revises the first
  w.advance(MIN);
  hold = true;
  w.s.sync([task(), task({ id: 'later', harness: 'claude' })]);
  await new Promise((r) => setImmediate(r));
  hold = false;
  w.s.sync([task({ prompt: 'run the linter' })]);
  release();
  await w.s.tick();
  assert.deepEqual(
    w.started.map((s: any) => [s.task.id, s.task.prompt]),
    [
      ['nightly', 'run the tests'],
      ['nightly', 'run the linter'],
    ],
    'the dropped task never starts, and the revised one runs 9:01 once',
  );
  assert.deepEqual(
    w.s.runs(0).runs.map((r: any) => r.scheduledFor),
    [Date.UTC(2026, 10, 4, 9, 0), Date.UTC(2026, 10, 4, 9, 1)],
  );
});
