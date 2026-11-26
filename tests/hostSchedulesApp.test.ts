// The app's side of scheduled tasks a machine fires itself (electron/host/hostSchedules.cjs, electron/app/hostSchedulesWiring.cjs, #2709 phase 2): a machine is sent the tasks whose agent is signed in on it, starting after the times this Mac handled; the Mac stops firing those; an older Host keeps none; and the runs a machine fired are adopted once each, in order, with their chats listed and followed and their times recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostSchedules } = require('../electron/host/hostSchedules.cjs');
const { wireHostSchedules } = require('../electron/app/hostSchedulesWiring.cjs');
const { scheduleCalls } = require('../electron/host/remoteSchedules.cjs');

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-host-sched-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const task = (o: any = {}) => ({
  id: 'nightly',
  name: 'Nightly',
  prompt: 'run the tests',
  rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
  status: 'ACTIVE',
  harness: 'claude',
  host_id: 'box',
  cwds: ['/srv/app'],
  schedule_from: 100,
  ...o,
});
const ROW = {
  harnesses: [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false, takesKey: true },
    { id: 'kimi', detected: true, signedIn: true },
  ],
};

function fakeHost(o: { runs?: any[]; refuse?: string; state?: string; store?: string; controlledByCode?: boolean } = {}) {
  const synced: any[] = [];
  const asked: number[] = [];
  const runs = o.runs ?? [];
  return {
    synced,
    asked,
    controlledByCode: o.controlledByCode === true,
    state: () => o.state ?? 'online',
    scheduleSync: async (p: any) => {
      if (o.refuse) throw Object.assign(new Error('nope'), { code: o.refuse });
      synced.push(p.tasks);
      return { held: p.tasks.length };
    },
    scheduleRuns: async ({ after }: { after: number }) => {
      asked.push(after);
      const out = runs.filter((r) => r.seq > after).slice(0, 2);
      return { runs: out, next: out.at(-1)?.seq ?? after, store: o.store ?? 's1' };
    },
  };
}

function world(t: any, o: { tasks?: any[]; host?: any; row?: any; handled?: number; dir?: string; adopt?: any; now?: number } = {}) {
  const dir = o.dir ?? tmp(t);
  const adopted: any[] = [];
  const reports: Error[] = [];
  const host = o.host ?? fakeHost();
  const s = createHostSchedules({
    file: path.join(dir, 'host-schedules.json'),
    tasks: async () => o.tasks ?? [task()],
    hostFor: (id: string) => (id === 'box' ? host : null),
    rowOf: (id: string) => (id === 'box' ? ('row' in o ? o.row : ROW) : null),
    handled: async () => o.handled ?? 0,
    adopt: o.adopt ?? (async (hostId: string, run: any) => void adopted.push([hostId, run.seq])),
    zone: () => 'Asia/Tokyo',
    now: () => o.now ?? 0,
    report: (e: Error) => reports.push(e),
  });
  return { s, host, adopted, reports, dir };
}

test('a machine is sent the tasks whose agent is signed in there, starting after the times this Mac handled; the Mac then leaves them to it', async (t) => {
  const tasks = [
    task({ model: 'opus', reasoning_effort: 'high', project_id: 'p1' }),
    task({ id: 'lent', harness: 'codex' }),
    task({ id: 'basic', harness: 'acp:kimi', status: 'PAUSED' }),
    task({ id: 'here', host_id: undefined }),
    task({ id: 'nofolder', cwds: [] }),
    task({ id: 'norule', rrule: '' }),
  ];
  const w = world(t, { tasks, handled: 5000 });
  assert.equal(w.s.firedByMachine(tasks[0]), false, 'nothing is held before a sync');
  await w.s.syncMachine('box');
  assert.deepEqual(w.host.synced, [
    [
      {
        id: 'nightly',
        name: 'Nightly',
        rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
        zone: 'Asia/Tokyo',
        prompt: 'run the tests',
        harness: 'claude',
        cwd: '/srv/app',
        status: 'ACTIVE',
        scheduleFrom: 5001,
        onApproval: 'wait',
        model: 'opus',
        effort: 'high',
        projectId: 'p1',
      },
      {
        id: 'basic',
        name: 'Nightly',
        rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
        zone: 'Asia/Tokyo',
        prompt: 'run the tests',
        harness: 'kimi',
        cwd: '/srv/app',
        status: 'PAUSED',
        scheduleFrom: 5001,
        onApproval: 'wait',
      },
    ],
  ]);
  assert.deepEqual(
    tasks.map((x) => w.s.firedByMachine(x)),
    [true, false, true, false, false, false],
  );
  // what the machine holds survives a restart of the app
  const again = world(t, { tasks, dir: w.dir });
  assert.equal(again.s.firedByMachine(tasks[0]), true);
  // a task that never handled a time starts from its own schedule
  const fresh = world(t, { tasks: [task({ schedule_from: undefined, name: undefined, prompt: undefined })] });
  await fresh.s.syncMachine('box');
  assert.deepEqual([fresh.host.synced[0][0].scheduleFrom, fresh.host.synced[0][0].name, fresh.host.synced[0][0].prompt], [1, '', '']);
});

test('a machine that is away keeps what it last held; one without schedules holds none; a failed sync is reported', async (t) => {
  const away = world(t, { host: fakeHost({ state: 'offline' }) });
  await away.s.syncMachine('box');
  assert.deepEqual(away.host.synced, []);
  const gone = world(t);
  await gone.s.syncMachine('nobody');
  const old = world(t, { host: fakeHost({ refuse: 'feature_missing' }) });
  await old.s.syncMachine('box');
  assert.equal(old.s.firedByMachine(task()), false);
  assert.deepEqual(old.reports, []);
  // a Host that held tasks and then is found to keep none (downgraded) gives them back to this Mac
  const was = world(t);
  await was.s.syncMachine('box');
  assert.equal(was.s.firedByMachine(task()), true);
  const downgraded = world(t, { dir: was.dir, host: fakeHost({ refuse: 'feature_missing' }) });
  await downgraded.s.syncMachine('box');
  assert.equal(downgraded.s.firedByMachine(task()), false);
  // a Mac this one only controls (paired by code) keeps none of its tasks: this Mac fires them, nothing is reported
  const controlled = world(t, { host: fakeHost({ refuse: 'forbidden', controlledByCode: true }) });
  await controlled.s.syncMachine('box');
  assert.equal(controlled.s.firedByMachine(task()), false);
  assert.deepEqual(controlled.reports, []);
  // the same refusal from a Mac paired as usual is reported
  const refusing = world(t, { host: fakeHost({ refuse: 'forbidden' }) });
  await refusing.s.syncMachine('box');
  assert.equal(refusing.reports[0].message, 'nope');
  const broken = world(t, { host: fakeHost({ refuse: 'timeout' }) });
  await broken.s.syncMachine('box');
  assert.equal(broken.reports[0].message, 'nope');
  // a machine not in the list, or a row with no agents: nothing is eligible
  const norow = world(t, { row: null });
  await norow.s.syncMachine('box');
  assert.deepEqual(norow.host.synced, [[]]);
});

test('the runs a machine fired are adopted once each, in order, across pages and restarts', async (t) => {
  const runs = [1, 2, 3].map((seq) => ({
    seq,
    taskId: 'nightly',
    scheduledFor: seq * 1000,
    status: 'started',
    harness: 'claude',
    cwd: '/srv/app',
  }));
  const w = world(t, { host: fakeHost({ runs }) });
  await w.s.syncMachine('box');
  assert.deepEqual(w.adopted, [
    ['box', 1],
    ['box', 2],
    ['box', 3],
  ]);
  await w.s.readAll();
  assert.equal(w.adopted.length, 3);
  const again = world(t, { dir: w.dir, host: fakeHost({ runs: [...runs, { ...runs[0], seq: 4 }] }) });
  await again.s.readAll();
  assert.deepEqual(again.adopted, [['box', 4]]);
  // a run that can't be adopted stops the read there: it is tried again next time
  let fail = true;
  const flaky = world(t, {
    host: fakeHost({ runs }),
    adopt: async (_h: string, run: any) => {
      if (run.seq === 2 && fail) throw new Error('disk full');
    },
  });
  await flaky.s.syncMachine('box');
  assert.equal(flaky.reports[0].message, 'disk full');
  fail = false;
  await flaky.s.readAll();
  assert.deepEqual(flaky.host.asked.slice(-1), [3]);
  // a machine that is away is not asked
  const away = world(t, { dir: w.dir, host: fakeHost({ runs, state: 'offline' }) });
  await away.s.readAll();
  assert.deepEqual(away.host.asked, []);
});

test('syncAll sends every machine a task runs on or that holds tasks; an unreadable file starts empty', async (t) => {
  const w = world(t, { tasks: [task(), task({ id: 'x', host_id: 'other' }), task({ id: 'y', host_id: undefined })] });
  await w.s.syncAll();
  assert.equal(w.host.synced.length, 1);
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'host-schedules.json'), '{bad');
  assert.equal(world(t, { dir }).s.firedByMachine(task()), false);
  fs.writeFileSync(path.join(dir, 'host-schedules.json'), 'null');
  assert.equal(world(t, { dir }).s.firedByMachine(task()), false);
  // with no zone given, the Mac's own is sent
  const plain = createHostSchedules({
    file: path.join(tmp(t), 'h.json'),
    tasks: async () => [task()],
    hostFor: () => w.host,
    rowOf: () => ROW,
    handled: async () => 0,
    adopt: async () => undefined,
    report: () => undefined,
  });
  await plain.syncMachine('box');
  assert.equal(w.host.synced.at(-1)[0].zone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('the wiring adopts a run like a chat this Mac started on the machine, records it once, and tells the user; a skipped time is recorded quietly', async (t) => {
  const dir = tmp(t);
  const runs = [
    {
      seq: 1,
      taskId: 'nightly',
      scheduledFor: 1000,
      status: 'started',
      harness: 'claude',
      cwd: '/srv/app',
      chatId: 'claude:u1',
      projectId: 'p1',
    },
    {
      seq: 2,
      taskId: 'nightly',
      scheduledFor: 2000,
      status: 'failed',
      harness: 'kimi',
      cwd: '/srv/app',
      reason: "Kimi Code isn't signed in on this machine.",
    },
    { seq: 3, taskId: 'gone', scheduledFor: 3000, status: 'skipped', harness: 'codex', cwd: '/srv/app', reason: 'missed', chatId: 'u3' },
    { seq: 4, taskId: 'nightly', scheduledFor: 1000, status: 'started', harness: 'claude', cwd: '/srv/app' },
    { seq: 5, taskId: 'unknown', scheduledFor: 5000, status: 'failed', harness: 'claude', cwd: '/srv/app' },
  ];
  const host = fakeHost({ runs });
  const adopted: any[] = [];
  let rows: any = null;
  const live: any = {
    machineChats: {
      hostFor: () => host,
      rowOf: () => ROW,
      adopt: async (chatId: string, at: any) => void adopted.push([chatId, at]),
      onRows: (fn: () => void) => ((rows = fn), () => (rows = null)),
    },
  };
  const claims = new Map<string, any>();
  const ledger = {
    latest: async () => 0,
    claim: async (id: string, due: number, fields: any) => {
      const k = `${id}@${due}`;
      if (claims.has(k)) return null;
      claims.set(k, fields);
      return fields;
    },
  };
  const announced: any[] = [];
  const notices: any[] = [];
  const changes: any[] = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const wired = wireHostSchedules({
    live,
    store: { list: async () => ({ tasks: [task()] }) },
    ledger,
    dir,
    announce: (e: any) => announced.push(e),
    notify: (...a: any[]) => notices.push(a),
    changed: (e: any) => changes.push(e),
  });
  const stop = wired.start();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(adopted, [
    ['acp:host-claude:u1', { hostId: 'box', folder: '/srv/app' }],
    ['acp:host-codex:u3', { hostId: 'box', folder: '/srv/app' }],
  ]);
  assert.deepEqual(announced[0], {
    harness: 'acp',
    chatId: 'acp:host-claude:u1',
    cwd: '/srv/app',
    worktreeOf: null,
    hostId: 'box',
    projectId: 'p1',
  });
  assert.equal(announced[1].projectId, null);
  assert.deepEqual(claims.get('nightly@1000'), {
    status: 'started',
    harness: 'claude',
    by: { machine: 'box' },
    chatId: 'acp:host-claude:u1',
  });
  assert.deepEqual(claims.get('nightly@2000'), {
    status: 'failed',
    harness: 'acp:kimi',
    by: { machine: 'box' },
    reason: "Kimi Code isn't signed in on this machine.",
  });
  assert.equal(claims.get('gone@3000').reason, 'missed');
  // a time already recorded (seq 4) tells nobody again; a skipped one is recorded without a notice
  assert.deepEqual(notices, [
    ['acp:host-claude:u1', { id: 'nightly', name: 'Nightly' }, {}],
    [null, { id: 'nightly', name: 'Nightly' }, { error: "Kimi Code isn't signed in on this machine." }],
    [null, { id: 'unknown', name: 'unknown' }, { error: '' }],
  ]);
  assert.deepEqual(changes, [{ id: 'nightly' }, { id: 'nightly' }, { id: 'gone' }, { id: 'unknown' }]);
  assert.equal(wired.firedByMachine(task()), true);
  assert.deepEqual(wired.phoneFields(task()), { hostId: 'box', firesWhileMacAway: true }, 'a phone hears it runs while the Mac is away');
  // the listing marks a task its machine fires itself
  assert.deepEqual(
    wired.marked({ tasks: [task(), task({ id: 'here', host_id: undefined })], errors: [] }).tasks.map((x: any) => x.fired_by),
    ['machine', undefined],
  );
  // a change of tasks or machines sends the sets again once it settles; the periodic read asks what ran
  const syncs = host.synced.length;
  wired.resync();
  wired.resync();
  rows?.();
  t.mock.timers.tick(2000);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(host.synced.length, syncs + 1);
  const asks = host.asked.length;
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.ok(host.asked.length > asks);
  wired.resync();
  stop();
  assert.equal(rows, null);
  // with Host not wired, nothing is sent and nothing is held
  const off = wireHostSchedules({
    live: {},
    store: { list: async () => ({ tasks: [task()] }) },
    ledger,
    dir: tmp(t),
    announce: () => undefined,
    notify: () => undefined,
    changed: () => undefined,
  });
  const stopOff = off.start();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(off.firedByMachine(task()), false);
  // a phone reads the task's machine and that this Mac fires it (electron/remote/methods/read.cjs)
  assert.deepEqual(off.phoneFields(task()), { hostId: 'box', firesWhileMacAway: false });
  assert.deepEqual(off.phoneFields(task({ host_id: undefined })), { hostId: null, firesWhileMacAway: false });
  stopOff();
  // a machine that fails the sync is noted, never thrown into the scheduler, and holds nothing
  const failing = fakeHost({ refuse: 'timeout' });
  const noted = wireHostSchedules({
    live: { machineChats: { ...live.machineChats, hostFor: () => failing, onRows: () => () => undefined } },
    store: { list: async () => ({ tasks: [task()] }) },
    ledger,
    dir: tmp(t),
    announce: () => undefined,
    notify: () => undefined,
    changed: () => undefined,
  });
  const stopNoted = noted.start();
  // a store that can't be read, and machines that can't be followed, are noted: starting never throws
  const unready = wireHostSchedules({
    live: {
      machineChats: {
        onRows: () => {
          throw new Error('no rows');
        },
      },
    },
    store: {
      list: async () => {
        throw new Error('store not ready');
      },
    },
    ledger,
    dir: tmp(t),
    announce: () => undefined,
    notify: () => undefined,
    changed: () => undefined,
  });
  const stopUnready = unready.start();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  stopUnready();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(noted.firedByMachine(task()), false);
  stopNoted();
});

test('a task the machine starts holding begins at the moment of the sync; a held one keeps its own start', async (t) => {
  const w = world(t, { now: 9999, handled: 5000 });
  await w.s.syncMachine('box');
  assert.equal(w.host.synced[0][0].scheduleFrom, 9999);
  await w.s.syncMachine('box');
  assert.equal(w.host.synced[1][0].scheduleFrom, 5001);
});

test('a machine whose store was reset is read from the start again; a run that keeps failing to adopt is passed over after three tries', async (t) => {
  const runs = [1, 2].map((seq) => ({
    seq,
    taskId: 'nightly',
    scheduledFor: seq * 1000,
    status: 'started',
    harness: 'claude',
    cwd: '/srv/app',
  }));
  const w = world(t, { host: fakeHost({ runs, store: 'old' }) });
  await w.s.syncMachine('box');
  assert.equal(w.adopted.length, 2);
  const reset = world(t, { dir: w.dir, host: fakeHost({ runs: [{ ...runs[0] }], store: 'new' }) });
  await reset.s.readAll();
  assert.deepEqual(reset.adopted, [['box', 1]]);
  assert.deepEqual(reset.host.asked, [2, 0, 1]);
  let tries = 0;
  const stuck = world(t, {
    host: fakeHost({ runs }),
    adopt: async (_h: string, run: any) => {
      if (run.seq === 1) {
        tries++;
        throw new Error('no chat');
      }
    },
  });
  await stuck.s.syncMachine('box');
  await stuck.s.readAll();
  assert.equal(tries, 2);
  await stuck.s.readAll();
  assert.equal(tries, 3);
  assert.deepEqual(stuck.host.asked.slice(-1), [2]);
  assert.equal(stuck.reports.length, 3);
});

test('a machine that left the list holds nothing: this Mac fires its tasks again', async (t) => {
  const w = world(t);
  await w.s.syncMachine('box');
  assert.equal(w.s.firedByMachine(task()), true);
  const gone = world(t, { dir: w.dir, row: null });
  assert.equal(gone.s.firedByMachine(task()), false);
});

test('the remote Host’s schedule requests go through its control channel by name', async () => {
  const asked: any[] = [];
  const calls = scheduleCalls(async (method: string, params: any) => (asked.push([method, params]), { ok: true }));
  await calls.scheduleSync({ tasks: [] });
  await calls.scheduleRuns({ after: 3 });
  assert.deepEqual(asked, [
    ['host.scheduleSync', { tasks: [] }],
    ['host.scheduleRuns', { after: 3 }],
  ]);
});

test('a task set to skip approvals is sent as skip, anything else as wait (U3)', async (t) => {
  const w = world(t, { tasks: [task({ on_approval: 'skip' }), task({ id: 'b', on_approval: 'wait' }), task({ id: 'c' })] });
  await w.s.syncMachine('box');
  assert.deepEqual(
    w.host.synced[0].map((x: any) => [x.id, x.onApproval]),
    [
      ['nightly', 'skip'],
      ['b', 'wait'],
      ['c', 'wait'],
    ],
  );
});
