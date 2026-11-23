// The scheduler in main (electron/platform/scheduler.cjs): each scheduled time runs once, across MoPilots and
// with the Codex app and Claude Desktop; a time missed while nothing was open is caught up once within 7 days;
// a run is skipped while the previous one is going; an unattended run whose approval waits an hour is marked.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const { Scheduler } = require('../electron/platform/scheduler.cjs');
const { RunLedger } = require('../electron/platform/runLedger.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const MIN = 60_000;
const DAY = 86_400_000;
/** 2030-01-01 09:00:30 local */
const START = new Date(2030, 0, 1, 9, 0, 30).getTime();
const task = (o: object = {}) => ({ id: 't1', name: 'Check', status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=1', created_at: 1, ...o });

/** A native app that runs tasks too, as the scheduler sees it. */
function fakeNative(o: { installed?: boolean; running?: boolean; ok?: boolean; tasks?: Record<string, number>; mark?: boolean } = {}) {
  const n: any = {
    label: 'the Codex app',
    open: o.running ?? false,
    marks: [] as any[],
    tasks: o.tasks ?? {},
    ok: o.ok ?? true,
    canMark: o.mark ?? true,
    installed: () => o.installed ?? true,
    running: async () => n.open,
    read: () => ({ ok: n.ok, tasks: new Map(Object.entries(n.tasks).map(([id, through]) => [id, { active: true, through }])) }),
    markHandled: (id: string, at: number, next: number | null, now: number) => (n.marks.push([id, at, next, now]), n.canMark),
  };
  return n;
}

function make(t: any, over: any = {}) {
  let clock = START;
  const dir = over.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  if (!over.dir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const started: string[] = [];
  const notified: any[] = [];
  const logs: string[] = [];
  const sessions = over.sessions ?? new SessionStore();
  const ledger = new RunLedger({ dir, now: () => clock });
  // the ledger began long ago: these tests are not about the first upgrade
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.baseline'))) fs.writeFileSync(path.join(dir, '.baseline'), String(over.baseline ?? 1));
  const s = new Scheduler({
    enabled: () => true,
    list: async () => [task()],
    run: async (a: any) => (started.push(a.id), `chat-${started.length}`),
    sessions,
    ledger,
    notify: (chatId: string, _a: any, o: any) => notified.push([chatId, o.catchUp]),
    now: () => clock,
    tickMs: 0,
    log: (m: string) => logs.push(m),
    ...over,
  });
  return { s, dir, ledger, sessions, started, notified, logs, advance: (ms: number) => (clock += ms), at: () => clock };
}

test('a time runs once: the next check, and a second MoPilot on the same ledger, leave it alone', async (t) => {
  const a = make(t);
  const b = make(t, { dir: a.dir });
  await a.s.tick();
  assert.deepEqual(a.started, ['t1'], '9:00 came due before the first check');
  assert.deepEqual(a.notified, [['chat-1', false]], 'on time: not a catch-up');
  await a.s.tick();
  await b.s.tick();
  assert.deepEqual(b.started, []);
  a.advance(MIN);
  await Promise.all([a.s.tick(), b.s.tick()]);
  assert.equal(a.started.length + b.started.length, 2, '9:01 ran exactly once between them');
  const records = await a.ledger.list('t1');
  assert.deepEqual(
    records.map((r: any) => r.status),
    ['started', 'started'],
  );
  assert.equal(records[1].chatId, 'chat-1');
});

test('a claim another MoPilot made between the check and the claim is left to it', async (t) => {
  const m = make(t);
  await m.s.tick();
  // as if the ledger read before the other MoPilot's claim landed
  m.ledger.latest = async () => 0;
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
});

test('a rule with no time after this one still runs it, and tells the native app there is no next', async (t) => {
  const codex = fakeNative({ tasks: { t1: 0 } });
  // once, at 9:00 local (17:00 UTC)
  const m = make(t, {
    list: async () => [task({ rrule: 'FREQ=DAILY;DTSTART=20300101T170000Z;COUNT=1', native_app: 'codex-app' })],
    natives: { 'codex-app': codex },
  });
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.equal(codex.marks[0][2], null);
});

test('regular 30-second polls do not keep postponing minutely and hourly tasks', async (t) => {
  for (const [rule, initial] of [
    ['FREQ=MINUTELY;INTERVAL=1', new Date(2030, 0, 1, 9, 0, 30).getTime()],
    ['FREQ=HOURLY;INTERVAL=1', new Date(2030, 0, 1, 9, 59, 30).getTime()],
  ] as const) {
    // the time before the first poll already ran: only the next one is due
    const m = make(t, { list: async () => [task({ rrule: rule, created_at: initial })] });
    m.advance(initial - START);
    for (let i = 0; i < 2; i++) {
      m.advance(30_000);
      await m.s.tick();
    }
    assert.deepEqual(m.started, ['t1'], rule);
  }
});

test('paused tasks, tasks with no rule, and a turned-off scheduler start nothing', async (t) => {
  let on = false;
  const m = make(t, {
    enabled: () => on,
    list: async () => [
      task(),
      task({ id: 'p', status: 'PAUSED' }),
      task({ id: 'n', rrule: undefined }),
      task({ id: 'bad', rrule: 'NOPE' }),
    ],
  });
  await m.s.tick();
  assert.deepEqual(m.started, []);
  on = true;
  // 9:00 came due while the scheduler was off: not caught up; the next time runs
  await m.s.tick();
  assert.deepEqual(m.started, []);
  m.advance(MIN);
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
});

test('times before the task was made, resumed or rescheduled, or before the ledger began, are not missed runs', async (t) => {
  const made = make(t, { list: async () => [task({ created_at: START })] });
  await made.s.tick();
  assert.deepEqual(made.started, [], '9:00 was before it was made at 9:00:30');
  made.advance(MIN);
  await made.s.tick();
  assert.deepEqual(made.started, ['t1']);
  const resumed = make(t, { list: async () => [task({ schedule_from: START })] });
  await resumed.s.tick();
  assert.deepEqual(resumed.started, []);
  const upgraded = make(t, { baseline: START });
  await upgraded.s.tick();
  assert.deepEqual(upgraded.started, []);
});

test('a time missed while nothing was open runs once, as a catch-up; older ones are dropped', async (t) => {
  // daily at 6:00; MoPilot opens at 9:00:30
  const m = make(t, { list: async () => [task({ rrule: 'FREQ=DAILY;BYHOUR=6;BYMINUTE=0' })] });
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.deepEqual(m.notified, [['chat-1', true]]);
  assert.equal((await m.ledger.list('t1'))[0].scheduledFor, new Date(2030, 0, 1, 6).getTime());
  // closed for ten days: one run for the latest time
  m.advance(10 * DAY);
  await m.s.tick();
  assert.equal(m.started.length, 2);
  await m.s.tick();
  assert.equal(m.started.length, 2);
  // a monthly task last due more than 7 days ago is recorded as missed, not run
  const monthly = make(t, { list: async () => [task({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=20;BYHOUR=9;BYMINUTE=0' })] });
  await monthly.s.tick();
  assert.deepEqual(monthly.started, []);
  assert.deepEqual(
    (await monthly.ledger.list('t1')).map((r: any) => [r.status, r.reason]),
    [['skipped', 'missed']],
  );
  await monthly.s.tick();
  assert.equal((await monthly.ledger.list('t1')).length, 1);
});

test('while the previous run is still going, the next time is skipped and says why', async (t) => {
  const m = make(t);
  await m.s.tick();
  m.sessions.patch('chat-1', { turn: 'running' });
  m.advance(MIN);
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.deepEqual(
    (await m.ledger.list('t1')).map((r: any) => [r.status, r.reason ?? null]),
    [
      ['skipped', 'previous-running'],
      ['started', null],
    ],
  );
  // it finished: the time after runs
  m.sessions.patch('chat-1', { turn: 'idle' });
  m.advance(MIN);
  await m.s.tick();
  assert.deepEqual(m.started, ['t1', 't1']);
  // a run whose chat this MoPilot doesn't have doesn't block
  const other = make(t, { dir: m.dir, sessions: new SessionStore() });
  other.advance(3 * MIN);
  await other.s.tick();
  assert.deepEqual(other.started, ['t1']);
});

test('a run longer than many scheduled times still blocks the next, past the skips it caused', async (t) => {
  const m = make(t);
  await m.s.tick();
  m.sessions.patch('chat-1', { turn: 'running' });
  for (let i = 0; i < 8; i++) {
    m.advance(MIN);
    await m.s.tick();
  }
  assert.deepEqual(m.started, ['t1']);
  assert.equal((await m.ledger.list('t1')).filter((r: any) => r.reason === 'previous-running').length, 8);
  m.sessions.patch('chat-1', { turn: 'idle' });
  m.advance(MIN);
  await m.s.tick();
  assert.deepEqual(m.started, ['t1', 't1']);
});

test('a run that fails to start is recorded and logged, and the next task still runs', async (t) => {
  const started: string[] = [];
  const m = make(t, {
    list: async () => [task({ id: 'bad' }), task({ id: 'good' })],
    run: async (a: any) => {
      if (a.id === 'bad') throw new Error('no window');
      started.push(a.id);
      return 'c';
    },
  });
  await m.s.tick();
  assert.deepEqual(started, ['good']);
  assert.match(m.logs[0], /bad did not start: no window/);
  assert.deepEqual(
    (await m.ledger.list('bad')).map((r: any) => [r.status, r.reason]),
    [['failed', 'no window']],
  );
  // a time that failed is not retried
  await m.s.tick();
  assert.deepEqual(started, ['good']);
});

test('the Codex app open with the task runs it itself; closed, MoPilot runs it and records it there first', async (t) => {
  const codex = fakeNative({ running: true, tasks: { t1: 0 } });
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.deepEqual(await m.ledger.times('t1'), [], 'no claim: the app runs it');
  codex.open = false;
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  const at = new Date(2030, 0, 1, 9, 0).getTime();
  assert.deepEqual(codex.marks, [['t1', at, at + MIN, m.at()]]);
  // the app ran 9:01 itself (its store says so): MoPilot leaves it
  m.advance(MIN);
  codex.tasks.t1 = at + MIN;
  await m.s.tick();
  assert.equal(m.started.length, 1);
});

test('a native app without the task, or not installed, doesn’t hold MoPilot back', async (t) => {
  const codex = fakeNative({ running: true });
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.deepEqual(codex.marks, [], 'nothing to record in a store that lacks it');
  const gone = fakeNative({ installed: false, ok: false });
  const g = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': gone } });
  await g.s.tick();
  assert.deepEqual(g.started, ['t1']);
  // a native app this build doesn't know
  const u = make(t, { list: async () => [task({ native_app: 'other-app' })] });
  await u.s.tick();
  assert.deepEqual(u.started, ['t1']);
});

test('a native store MoPilot can’t read leaves the task to that app, logged once', async (t) => {
  const codex = fakeNative({ ok: false });
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  await m.s.tick();
  m.advance(MIN);
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.equal(m.logs.length, 1);
  assert.match(m.logs[0], /left to the Codex app: its schedule store isn't recognized/);
});

test('the app opening between the claim and the run, or a busy store, gives the time back', async (t) => {
  const codex = fakeNative({ tasks: { t1: 0 } });
  // it opens as MoPilot claims
  let reads = 0;
  codex.running = async () => reads++ > 0;
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.deepEqual(await m.ledger.times('t1'), [], 'released');
  assert.match(m.logs[0], /t1 waits: the Codex app opened or its store is busy/);
  const busy = fakeNative({ tasks: { t1: 0 }, mark: false });
  const b = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': busy } });
  await b.s.tick();
  assert.deepEqual(b.started, []);
  busy.canMark = true;
  await b.s.tick();
  assert.deepEqual(b.started, ['t1'], 'tried again');
});

test('each native app is asked once per check, however many tasks it has', async (t) => {
  const codex = fakeNative({ tasks: {} });
  let asked = 0;
  const running = codex.running;
  codex.running = async () => (asked++, running());
  const m = make(t, {
    list: async () => [task({ id: 'a', native_app: 'codex-app' }), task({ id: 'b', native_app: 'codex-app' })],
    natives: { 'codex-app': codex },
  });
  await m.s.tick();
  assert.equal(asked, 1);
  assert.deepEqual(m.started, ['a', 'b']);
});

test('the store is brought up to date before each check', async (t) => {
  const order: string[] = [];
  const m = make(t, {
    before: async () => void order.push('sync'),
    list: async () => (order.push('list'), []),
  });
  await m.s.tick();
  assert.deepEqual(order, ['sync', 'list']);
});

test('an unattended approval waiting an hour is marked needs attention; answering clears it', async (t) => {
  const m = make(t, { list: async () => [] });
  const { s, sessions, advance } = m;
  sessions.patch('c1', {
    scheduled: { unattended: true, computer: false, onApproval: 'wait' },
    approvals: [{ id: 1, method: 'x', params: {} }],
  });
  sessions.patch('c2', {
    scheduled: { unattended: false, computer: false, onApproval: 'wait' },
    approvals: [{ id: 2, method: 'x', params: {} }],
  });
  await s.tick();
  advance(59 * MIN);
  await s.tick();
  assert.equal(sessions.get('c1').scheduled.needsAttention, undefined);
  advance(2 * MIN);
  await s.tick();
  assert.equal(sessions.get('c1').scheduled.needsAttention, true);
  // someone is there for a run started with Run now: no mark
  assert.equal(sessions.get('c2').scheduled.needsAttention, undefined);
  sessions.patch('c1', { approvals: [] });
  await s.tick();
  assert.equal(sessions.get('c1').scheduled.needsAttention, false);
});

// Turning schedules off, or off and on, while a check is under way (#574): no further launches, and the time
// spent disabled is never replayed as missed runs; times after schedules are back on still run.
test('disabling schedules during task discovery prevents launches and skips the disabled interval', async (t) => {
  let on = true;
  let release!: (tasks: object[]) => void;
  const m = make(t, { enabled: () => on, list: () => new Promise((resolve) => (release = resolve)) });
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  on = false;
  m.advance(5 * MIN);
  release([task()]);
  await checking;
  assert.deepEqual(m.started, []);
  on = true;
  release = undefined as any;
  const resumed = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  release([task()]);
  await resumed;
  assert.deepEqual(m.started, []);
});

test('disabling schedules while one task starts prevents the remaining launches', async (t) => {
  let on = true;
  let release!: (chat: string) => void;
  const started: string[] = [];
  const m = make(t, {
    enabled: () => on,
    list: async () => [task(), task({ id: 't2' })],
    run: (a: any) => {
      started.push(a.id);
      return a.id === 't1' ? new Promise((resolve) => (release = resolve)) : Promise.resolve('chat-2');
    },
  });
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  on = false;
  release('chat');
  await checking;
  assert.deepEqual(started, ['t1']);
  assert.deepEqual(
    m.notified.map((n) => n[0]),
    ['chat'],
  );
});

test('disabling during the last launch advances the cutoff through the disabled time', async (t) => {
  let on = true;
  let release!: (chat: string) => void;
  const started: string[] = [];
  const m = make(t, {
    enabled: () => on,
    run: (a: any) => {
      started.push(a.id);
      return new Promise((resolve) => (release = resolve));
    },
  });
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  on = false;
  m.advance(5 * MIN);
  release('chat');
  await checking;
  on = true;
  await m.s.tick();
  assert.deepEqual(started, ['t1']);
});

test('an off/on preference transition invalidates pending discovery and skips its stale due time', async (t) => {
  let release!: (tasks: object[]) => void;
  const m = make(t, { list: () => new Promise((resolve) => (release = resolve)) });
  m.s.settingsChanged(true); // unrelated preference updates do not cancel the check
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  m.s.settingsChanged(false);
  m.advance(5 * MIN);
  m.s.settingsChanged(true);
  release([task()]);
  await checking;
  assert.deepEqual(m.started, []);
  release = undefined as any;
  const resumed = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  release([task()]);
  await resumed;
  assert.deepEqual(m.started, []);
});

test('an off/on transition while a run starts cancels remaining launches and does not replay disabled time', async (t) => {
  let release!: (chat: string) => void;
  const started: string[] = [];
  const m = make(t, {
    list: async () => [task(), task({ id: 't2' })],
    run: (a: any) => {
      started.push(a.id);
      return a.id === 't1' ? new Promise((resolve) => (release = resolve)) : Promise.resolve('chat-2');
    },
  });
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  m.s.settingsChanged(false);
  m.advance(5 * MIN);
  m.s.settingsChanged(true);
  release('chat');
  await checking;
  await m.s.tick();
  assert.deepEqual(started, ['t1']);
});

test('a stale launch leaves the re-enable cutoff intact so newly authorized occurrences still run', async (t) => {
  let release!: (chat: string) => void;
  const started: string[] = [];
  const m = make(t, {
    run: (a: any) => {
      started.push(a.id);
      return started.length === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve('new-chat');
    },
  });
  m.advance(MIN);
  const checking = m.s.tick();
  await waitFor(() => release, 'the scheduler read');
  m.s.settingsChanged(false);
  m.advance(5 * MIN);
  m.s.settingsChanged(true);
  m.advance(4 * MIN);
  release('old-chat');
  await checking;
  await m.s.tick();
  assert.deepEqual(started, ['t1', 't1']);
});

test('an incomplete newer record cannot allow overlap with an older running chat', async (t) => {
  const m = make(t);
  await m.s.tick();
  m.sessions.patch('chat-1', { turn: 'running' });
  fs.writeFileSync(m.ledger.fileOf('t1', -(m.at() + 1)), '');
  m.advance(60_000);
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.equal((await m.ledger.list('t1'))[0].reason, 'previous-running');
});

test('a committed scheduled occurrence still launches when pruning old history fails', async (t) => {
  const m = make(t);
  m.ledger.keep = 1;
  fs.mkdirSync(path.dirname(m.ledger.fileOf('t1', 1)), { recursive: true });
  fs.mkdirSync(m.ledger.fileOf('t1', 1));
  await m.s.tick();
  assert.deepEqual(m.started, ['t1']);
  assert.equal((await m.ledger.list('t1'))[0].status, 'started');
  await m.s.tick();
  assert.deepEqual(m.started, ['t1'], 'the same occurrence is not launched twice');
});

test('non-finite task timestamps cannot suppress every scheduled occurrence', async (t) => {
  for (const field of ['created_at', 'schedule_from']) {
    const a = make(t, { list: async () => [task({ [field]: 'Infinity' })] });
    await a.s.tick();
    assert.deepEqual(a.started, ['t1'], field);
  }
});

for (const method of ['item/commandExecution/requestApproval', 'claude/permission', 'acp/permission']) {
  test(`a replacement ${method} approval gets its own attention deadline even when its request id is reused`, async (t) => {
    const m = make(t, { list: async () => [] });
    const scheduled = { unattended: true, computer: false, onApproval: 'wait' };
    const card = { id: 1, method, params: {} };
    m.sessions.patch('c1', { scheduled, approvals: [card] });
    await m.s.tick();
    m.advance(61 * MIN);
    await m.s.tick();
    assert.equal(m.sessions.get('c1').scheduled.needsAttention, true);
    // The answer and identical replacement happen between scheduler checks.
    m.sessions.patch('c1', { approvals: [] });
    m.sessions.patch('c1', { approvals: [card] });
    await m.s.tick();
    assert.equal(m.sessions.get('c1').scheduled.needsAttention, false);
    m.advance(59 * MIN);
    await m.s.tick();
    assert.equal(m.sessions.get('c1').scheduled.needsAttention, false);
    m.advance(MIN);
    await m.s.tick();
    assert.equal(m.sessions.get('c1').scheduled.needsAttention, true);
  });
}

test('attention follows the oldest still-pending approval rather than the chat or newest card', async (t) => {
  const m = make(t, { list: async () => [] });
  const scheduled = { unattended: true, computer: false, onApproval: 'wait' };
  const a = { id: 1, method: 'ask', params: {} },
    b = { id: 2, method: 'ask', params: {} };
  m.sessions.patch('c', { scheduled, approvals: [a] });
  await m.s.tick();
  m.advance(30 * MIN);
  m.sessions.patch('c', { approvals: [a, b] });
  await m.s.tick();
  m.advance(31 * MIN);
  await m.s.tick();
  assert.equal(m.sessions.get('c').scheduled.needsAttention, true);
  m.sessions.patch('c', { approvals: [b] });
  await m.s.tick();
  assert.equal(m.sessions.get('c').scheduled.needsAttention, false);
  m.advance(29 * MIN);
  await m.s.tick();
  assert.equal(m.sessions.get('c').scheduled.needsAttention, true);
  m.sessions.patch('c', { scheduled: { ...scheduled, unattended: false, needsAttention: true } });
  await m.s.tick();
  assert.equal(m.sessions.get('c').scheduled.needsAttention, false);
  assert.equal(m.s.waiting.has('c'), false, 'attended chats retain no unattended timers');
});

test('attention forgets removed chats and accepts legacy cards without a private token', async (t) => {
  const m = make(t, { list: async () => [] });
  m.sessions.approvalToken = undefined;
  m.sessions.patch('c', { scheduled: { unattended: true }, approvals: [{ id: 1, method: 'ask', params: {} }] });
  await m.s.tick();
  m.advance(60 * MIN);
  await m.s.tick();
  assert.equal(m.sessions.get('c').scheduled.needsAttention, true);
  m.sessions.chats.delete('c');
  await m.s.tick();
  assert.equal(m.s.waiting.has('c'), false);
});

for (const phase of ['discovery', 'latest', 'previous', 'claim', 'confirm']) {
  for (const reenable of [false, true]) {
    test(`a pending ${phase} cannot launch after schedules turn off${reenable ? ' and on' : ''}`, async (t) => {
      let enabled = true;
      const codex = fakeNative({ tasks: { t1: 0 } });
      const m = make(t, { enabled: () => enabled, list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (release = r));
      const [owner, method, nth] =
        phase === 'discovery'
          ? [codex, 'running', 1]
          : phase === 'confirm'
            ? [codex, 'running', 2]
            : phase === 'previous'
              ? [m.s, 'previousRunning', 1]
              : [m.ledger, phase, 1];
      const original = owner[method].bind(owner);
      let calls = 0;
      owner[method] = async (...args: any[]) => {
        const result = await original(...args);
        if (++calls === nth) {
          entered();
          await gate;
        }
        return result;
      };
      const checking = m.s.tick();
      await waiting;
      enabled = false;
      m.s.settingsChanged(false);
      m.advance(MIN);
      if (reenable) {
        enabled = true;
        m.s.settingsChanged(true);
      }
      release();
      await checking;
      assert.deepEqual(m.started, []);
      assert.deepEqual(codex.marks, [], 'stale authorization cannot advance the native watermark');
      assert.deepEqual(await m.ledger.times('t1'), [], 'any acquired starting claim is released');
      enabled = true;
      m.s.settingsChanged(true);
      m.advance(MIN);
      await m.s.tick();
      assert.deepEqual(m.started, ['t1'], 'a newly authorized occurrence still runs');
    });
  }
}

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`a ${harness} task without a native app cannot launch after its claim loses authorization`, async (t) => {
    let enabled = true;
    const m = make(t, { enabled: () => enabled, list: async () => [task({ harness })] });
    const claim = m.ledger.claim.bind(m.ledger);
    m.ledger.claim = async (...args: any[]) => {
      const record = await claim(...args);
      enabled = false;
      m.s.settingsChanged(false);
      return record;
    };
    await m.s.tick();
    assert.deepEqual(m.started, []);
    assert.deepEqual(await m.ledger.times('t1'), []);
    m.ledger.claim = claim;
    enabled = true;
    m.s.settingsChanged(true);
    m.advance(MIN);
    await m.s.tick();
    assert.deepEqual(m.started, ['t1']);
    assert.equal((await m.ledger.list('t1'))[0].harness, harness);
  });
}

for (const disable of [false, true]) {
  test(`native confirmation failure releases the unlaunched claim${disable ? ' after disabling schedules' : ''}`, async (t) => {
    let enabled = true;
    const codex = fakeNative({ tasks: { t1: 0 } });
    const m = make(t, { enabled: () => enabled, list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
    let calls = 0;
    codex.running = async () => {
      if (++calls === 2) {
        if (disable) {
          enabled = false;
          m.s.settingsChanged(false);
        }
        throw new Error('confirmation failed');
      }
      return false;
    };
    await m.s.tick();
    assert.deepEqual(m.started, []);
    assert.deepEqual(codex.marks, []);
    assert.deepEqual(await m.ledger.times('t1'), []);
    assert.match(m.logs[0], /confirmation failed/);
  });
}

test('a native bookkeeping exception releases the unlaunched claim and reports its original failure', async (t) => {
  const codex = fakeNative({ tasks: { t1: 0 } });
  codex.markHandled = () => {
    throw new Error('bookkeeping failed');
  };
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.deepEqual(await m.ledger.times('t1'), []);
  assert.match(m.logs[0], /bookkeeping failed/);
});

test('a cleanup error cannot hide the native confirmation failure', async (t) => {
  const codex = fakeNative({ tasks: { t1: 0 } });
  let calls = 0;
  codex.running = async () => {
    if (++calls === 2) throw new Error('confirmation failed');
    return false;
  };
  const m = make(t, { list: async () => [task({ native_app: 'codex-app' })], natives: { 'codex-app': codex } });
  m.ledger.release = async () => {
    throw new Error('cleanup failed');
  };
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.match(m.logs[0], /confirmation failed/);
});

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`${harness} notification failure cannot mark a launched scheduled run failed`, async (t) => {
    const { Notifier } = require('../electron/platform/notify.cjs');
    const notifier = new Notifier({
      getMode: () => 'always',
      show: () => {
        throw new Error('OS notification failed');
      },
    });
    const m = make(t, {
      list: async () => [task({ harness })],
      notify: (id: string) => notifier.notify('scheduled', id, {}),
    });
    await m.s.tick();
    assert.equal((await m.ledger.lastRun('t1')).status, 'started');
    assert.equal((await m.ledger.lastRun('t1')).chatId, 'chat-1');
    m.sessions.patch('chat-1', { turn: 'running' });
    m.advance(MIN);
    await m.s.tick();
    assert.deepEqual(m.started, ['t1']);
    assert.equal((await m.ledger.list('t1'))[0].reason, 'previous-running');
  });
}

test('a pending harness transfer never starts a scheduled run', async (t) => {
  const pending = task({ transfer_from: 'codex', transfer_status: 'ACTIVE' });
  const m = make(t, { list: async () => [pending] });
  await m.s.tick();
  assert.deepEqual(m.started, []);
  assert.deepEqual(await m.ledger.list('t1'), []);
});
