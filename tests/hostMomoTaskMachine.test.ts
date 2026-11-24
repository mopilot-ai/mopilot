// The parts of MoMo's tasks on a Host that take scripted Host sessions (host/src/momoTasks/localMachine.mjs, seam.mjs) and a home double (host/src/momoServices/tasks.mjs): turn ends, names, keys, and a home that is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createLocalMachine, endOf } from '../host/src/momoTasks/localMachine.mjs';
// @ts-ignore
import { createStartKeys, createTaskEnds, createTasksSeam } from '../host/src/momoTasks/seam.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import tasksService from '../host/src/momoServices/tasks.mjs';
import { fakeSessions, tasksWorld, ask, until } from './support/host/momoTasksWorld.ts';

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tasks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a turn end is a failure with its code, a restart, a Stop that says nothing, or the reply', () => {
  assert.deepEqual(endOf({ error: { code: 'auth', message: 'Not signed in' } }, ''), {
    kind: 'failed',
    signal: 'auth',
    message: 'Not signed in',
  });
  assert.deepEqual(endOf({ error: 'plain' }, ''), { kind: 'failed', signal: undefined, message: 'plain' });
  assert.deepEqual(endOf({ error: {} }, ''), { kind: 'failed', signal: undefined, message: '[object Object]' });
  assert.deepEqual(endOf({ interrupted: { by: 'host_restart' } }, ''), { kind: 'lost', reason: 'machine_restarted' });
  assert.deepEqual(endOf({ interrupted: { by: 'x' } }, ''), { kind: 'lost', reason: 'session_gone' });
  assert.equal(endOf({ stopReason: 'cancelled' }, ''), null);
  assert.deepEqual(endOf({ stopReason: 'end_turn' }, 'the reply'), { kind: 'finished', report: 'the reply' });
});

function machine(over: { stamp?: any; name?: string | null; keys?: any; sessions?: any } = {}) {
  const sessions = over.sessions ?? fakeSessions();
  const emitted: any[] = [];
  const keys = over.keys ?? {
    map: new Map<string, string>(),
    get(k: string) {
      return this.map.get(k) ?? null;
    },
    async set(k: string, c: string) {
      this.map.set(k, c);
    },
    async delete(k: string) {
      this.map.delete(k);
    },
  };
  const home = { stamp: () => (over.stamp === undefined ? { homeId: 'h1' } : over.stamp) };
  const local = createLocalMachine({
    sessions,
    home,
    workDir: path.join(os.tmpdir(), 'momo-task-work'),
    ends: { get: () => null, set: async () => undefined },
    keys,
    report: () => undefined,
    emit: async (m: string, c: string, e: any) => void emitted.push([m, c, e]),
    nameOf: () => (over.name === undefined ? null : over.name),
    newId: () => 'fixed-id',
  });
  return { local, sessions, emitted, keys, port: local.port() };
}
const req = (over: object = {}) => ({
  itemId: 'i1',
  machineId: 'h1',
  harness: 'claude',
  brief: 'b',
  readOnly: false,
  gateOrigin: 'task' as const,
  forbidTools: [],
  key: 'i1:1',
  ...over,
});

test('without a source, or away from home, no machine is listed; with one, it is named by the wiring, the home record or plain words', async () => {
  const none = machine();
  assert.deepEqual(await none.port.list(), []);
  const away = machine({ stamp: null });
  away.local.bind({ agents: () => [] });
  assert.deepEqual(await away.port.list(), []);
  await away.local.poll();
  const named = machine({ name: 'Studio' });
  named.local.bind({ agents: () => [{ id: 'claude', state: 'ready' }], outdated: () => true, installable: () => true });
  assert.deepEqual(await named.port.list(), [
    { machineId: 'h1', name: 'Studio', online: true, outdated: true, installable: true, agents: [{ id: 'claude', state: 'ready' }] },
  ]);
  const bare = machine();
  bare.local.bind({ agents: () => [] });
  assert.equal((await bare.port.list())[0].name, 'this machine');
  const own = machine({ name: 'Studio' });
  own.local.bind({ name: 'Wired', agents: () => [] });
  const [listed] = await own.port.list();
  assert.deepEqual([listed.name, listed.outdated, listed.installable], ['Wired', false, false]);
});

test('a start for another machine, or while away, is refused; a start made before is the same chat', async () => {
  const m = machine();
  assert.deepEqual(await m.port.start(req({ machineId: 'other' })), {
    ok: false,
    code: 'machine_offline',
    message: "MoMo's home can't reach that machine from here.",
  });
  assert.equal((await machine({ stamp: null }).port.start(req())).ok, false);
  m.keys.map.set('i1:1', 'claude:first');
  m.sessions.turns.set('claude:first', 'running');
  assert.deepEqual(await m.port.start(req()), { ok: true, sessionId: 'claude:first' });
  assert.equal(m.sessions.sent.length, 0);
  // a key whose chat the Host no longer has starts a new one
  m.keys.map.set('i2:1', 'claude:gone');
  const fresh = await m.port.start(req({ key: 'i2:1', itemId: 'i2' }));
  assert.deepEqual([fresh.ok, (fresh as any).sessionId, m.keys.map.get('i2:1')], [true, 'claude:fixed-id', 'claude:fixed-id']);
  fs.rmSync(path.join(os.tmpdir(), 'tasks', 'i2'), { recursive: true, force: true });
});

test("a session is cancelled only on the Host it runs on: one that a move left on another Host is not this Host's to cancel, a stray after the lease is gone still is", async () => {
  const m = machine();
  await m.port.stop('h1', 'claude:mine');
  assert.deepEqual(m.sessions.cancelled, ['claude:mine']);
  // after a move the task still names the old Host: nothing is cancelled here, and the refusal reaches the task's own note
  await assert.rejects(m.port.stop('old-host', 'claude:theirs'), /runs on another machine/);
  assert.deepEqual(m.sessions.cancelled, ['claude:mine']);
  // a Host that never had the lease knows no id of its own: it cancels nothing (a stray of the lease it lost is stopped under the id it had; hostMomoTasksEnforcement)
  const lost = machine({ stamp: null });
  await assert.rejects(lost.port.stop('h1', 'claude:x'), /runs on another machine/);
});

test('events of chats that are not followed, or that name no chat, are ignored; text without content adds nothing', async () => {
  const m = machine();
  m.local.attach();
  m.local.track('claude:a');
  m.local.track('claude:a');
  m.sessions.emit({ kind: 'update', update: {} });
  m.sessions.emit(null);
  m.sessions.emit({ kind: 'turnEnd', key: 'claude:other' });
  m.sessions.emit({ kind: 'turnStart', chatId: 'claude:a' });
  m.sessions.emit({ kind: 'update', chatId: 'claude:a', update: { sessionUpdate: 'agent_message_chunk', content: {} } });
  m.sessions.emit({ kind: 'update', chatId: 'claude:a', update: { sessionUpdate: 'tool_call' } });
  m.sessions.emit({ kind: 'turnEnd', chatId: 'claude:a', stopReason: 'end_turn' });
  await until(() => m.emitted.length === 1, 'the end');
  assert.deepEqual(m.emitted[0], ['h1', 'claude:a', { kind: 'finished', report: '' }]);
  assert.equal(m.local.size(), 1);
  m.local.untrack('claude:a');
  assert.equal(m.local.size(), 0);
  m.local.detach();
});

test('a failing hand-over of an event is reported, not lost', async () => {
  const reports: string[] = [];
  const sessions = fakeSessions();
  const local = createLocalMachine({
    sessions,
    home: { stamp: () => ({ homeId: 'h1' }) },
    workDir: path.join(os.tmpdir(), 'momo-task-work'),
    ends: { get: () => null, set: async () => undefined },
    keys: { get: () => null, set: async () => undefined, delete: async () => undefined },
    emit: async () => {
      throw new Error('store closed');
    },
    report: (m: string) => reports.push(m),
    nameOf: () => null,
  });
  local.attach();
  local.track('claude:a');
  sessions.emit({ kind: 'turnEnd', key: 'claude:a', stopReason: 'end_turn' });
  await until(() => reports.length === 1, 'the report');
  assert.match(reports[0], /store closed/);
});

test('a chat that is idle or not known is gone; a working one runs; a refusal that is not an Error is still worded', async () => {
  const m = machine();
  m.sessions.turns.set('c1', 'awaitingUser');
  m.sessions.turns.set('c2', 'idle');
  assert.deepEqual(await m.port.probe('h1', 'c1'), { state: 'running' });
  assert.deepEqual(await m.port.probe('h1', 'c2'), { state: 'gone' });
  assert.deepEqual(await m.port.probe('h1', 'c3'), { state: 'gone' });
  m.sessions.sendFails = 'plain refusal' as any;
  const refused = await m.port.start(req({ key: 'k9', itemId: 'i9' }));
  assert.deepEqual([(refused as any).code, (refused as any).message], ['refused', 'plain refusal']);
  fs.rmSync(path.join(os.tmpdir(), 'tasks', 'i9'), { recursive: true, force: true });
  await m.port.stop('h1', 'c1');
  assert.deepEqual(m.sessions.cancelled, ['c1']);
  m.local.track('c1');
  await m.local.poll();
  assert.equal(m.emitted[0][2].kind, 'needs_you');
  assert.match(m.emitted[0][2].line, /this machine/);
  m.sessions.turns.delete('c1');
  await m.local.poll();
  assert.equal(m.emitted[1][2].kind, 'resumed');
});

test('the ledger is written only while this Host is the running home, and start keys keep only the newest', async (t) => {
  const dir = tmp(t);
  const safeStorage = createFileSafeStorage(dir);
  let running = false;
  const seam = createTasksSeam({ dir, safeStorage, home: { stamp: () => (running ? { homeId: 'h1' } : null) }, now: Date.now });
  await assert.rejects(
    seam.change(() => ({ doc: 1, out: 1 })),
    /not running on this machine/,
  );
  assert.equal(await seam.read(), null);
  running = true;
  assert.equal(await seam.change(() => ({ doc: { v: 1 }, out: 'ok' })), 'ok');
  assert.deepEqual(await seam.read(), { v: 1 });
  const keys = createStartKeys({ dir, safeStorage, now: Date.now, keep: 3 });
  assert.equal(keys.get('a'), null);
  for (let i = 0; i < 5; i++) await keys.set(`k${i}`, `c${i}`);
  assert.deepEqual([keys.get('k0'), keys.get('k1'), keys.get('k2'), keys.get('k4')], [null, null, 'c2', 'c4']);
});

/** The service over a home double: what a real home never gives (no record, no gate). */
function double(over: { record?: any; gate?: any; stamp?: any } = {}) {
  const hooks: Record<string, any> = {};
  const provided: Record<string, any> = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tasks-double-'));
  const safeStorage = createFileSafeStorage(dir);
  const home = {
    storage: { dir },
    workDir: (name: string) => path.join(dir, 'work', name),
    data: { safeStorage },
    granted: () => true,
    machine: () => 'this machine',
    stamp: () => (over.stamp === undefined ? { homeId: 'h1', leaseEpoch: 1 } : over.stamp),
    record: () => (over.record === undefined ? null : over.record),
    use: (id: string, h: any) => void (hooks[id] = h),
    provide: (id: string, api: any) => void (provided[id] = api),
    service: (id: string) => (id === 'gate' ? over.gate : undefined),
  };
  tasksService({ home, sessions: fakeSessions(), report: () => undefined });
  return { api: provided.tasks, hooks: hooks.tasks, dir, home };
}

test("with no home record the machine is named by its id, and with no gate a task's action is refused", async (t) => {
  const d = double();
  t.after(() => fs.rmSync(d.dir, { recursive: true, force: true }));
  d.api.bind({ machine: { agents: () => [{ id: 'claude', state: 'ready' }] } });
  const { item } = await d.api.create(ask);
  assert.equal((await d.api.view())[0].where.machine.name, 'this machine');
  assert.deepEqual(await d.api.guardedRun(item.where.sessionId, { tool: 'x' }, () => 1), { refused: true, reason: 'gate_unavailable' });
  const named = double({ record: { name: 'Studio' } });
  t.after(() => fs.rmSync(named.dir, { recursive: true, force: true }));
  named.api.bind({ machine: { agents: () => [{ id: 'claude', state: 'ready' }] } });
  await named.api.create(ask);
  assert.equal((await named.api.view())[0].where.machine.name, 'Studio');
});

test('pause and wipe before anything was built, and a second wipe, do nothing', async (t) => {
  const d = double();
  t.after(() => fs.rmSync(d.dir, { recursive: true, force: true }));
  d.hooks.pause();
  await d.hooks.wipe();
  await d.hooks.wipe();
  d.api.bind({ machine: { agents: () => [] }, watches: { toolIsReadOnly: async () => true, read: async () => ({ fingerprint: 'a' }) } });
  assert.deepEqual(await d.api.view(), []);
});

test('the timers poll and tick, report a round that fails and go on, and stop on pause', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  const chat = item.where.sessionId as string;
  w.sessions.turns.set(chat, 'awaitingUser');
  t.mock.timers.tick(5_000);
  await until(async () => (await w.tasks.view())[0]?.state === 'needs_you', 'the poll');
  t.mock.timers.tick(60_000);
  const original = w.sessions.state.has;
  w.sessions.state.has = () => {
    throw new Error('boom');
  };
  t.mock.timers.tick(5_000);
  await until(() => w.reports.some((r: string) => /MoMo tasks poll: boom/.test(r)), 'the failed round to be reported');
  w.sessions.state.has = original;
  t.mock.timers.tick(5_000);
  await w.home.lifecycle('pause');
  const reported = w.reports.length;
  w.sessions.state.has = () => {
    throw new Error('after pause');
  };
  t.mock.timers.tick(10_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(w.reports.length, reported);
});

test("the machine's agents come from the Host's harness status when the wiring passes it, basic agents as acp:<id>", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tasks-harnesses-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks: Record<string, any> = {};
  const provided: Record<string, any> = {};
  const home = {
    storage: { dir },
    workDir: (name: string) => path.join(dir, 'work', name),
    data: { safeStorage: createFileSafeStorage(dir) },
    granted: () => true,
    machine: () => 'this machine',
    stamp: () => ({ homeId: 'h1', leaseEpoch: 1 }),
    record: () => ({ name: 'Studio' }),
    use: (id: string, h: any) => void (hooks[id] = h),
    provide: (id: string, api: any) => void (provided[id] = api),
    service: () => undefined,
  };
  const harnesses = async () => [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false },
    { id: 'kimi', detected: false, signedIn: false },
  ];
  tasksService({ home, sessions: fakeSessions(), harnesses, report: () => undefined });
  const api = provided.tasks;
  const ready = await api.create(ask);
  assert.equal(ready.item.state, 'working');
  const signedOut = await api.create({ ...ask, title: 'b', where: { machineId: 'h1', harness: 'codex' } });
  assert.equal(signedOut.error?.code, 'agent_signed_out');
  const missing = await api.create({ ...ask, title: 'c', where: { machineId: 'h1', harness: 'acp:kimi' } });
  assert.equal(missing.error?.code, 'agent_missing');
  // a wiring that names the machine but gives no agents still reads them from the Host
  api.bind({ machine: { name: 'Wired' } });
  assert.equal((await api.view())[0].where.machine.name, 'Wired');
});

test('the same start key twice is one chat and one message; a key whose chat the Host lost starts a new one', async () => {
  const m = machine();
  const first = await m.port.start(req({ key: 'twice:1', itemId: 'twice' }));
  const second = await m.port.start(req({ key: 'twice:1', itemId: 'twice' }));
  assert.deepEqual([first.ok, (second as any).sessionId === (first as any).sessionId, m.sessions.sent.length], [true, true, 1]);
  m.sessions.turns.clear();
  const third = await m.port.start(req({ key: 'twice:1', itemId: 'twice' }));
  assert.deepEqual([(third as any).sessionId === (first as any).sessionId, m.sessions.sent.length], [true, 2]);
  fs.rmSync(path.join(os.tmpdir(), 'momo-task-work'), { recursive: true, force: true });
});

test('a chat id with the form of a MoMo chat is never made for a task', async () => {
  const sessions = fakeSessions();
  const local = createLocalMachine({
    sessions,
    home: { stamp: () => ({ homeId: 'h1' }) },
    workDir: path.join(os.tmpdir(), 'momo-task-work'),
    keys: { get: () => null, set: async () => undefined, delete: async () => undefined },
    ends: { get: () => null, set: async () => undefined },
    emit: async () => undefined,
    report: () => undefined,
    nameOf: () => null,
    newId: () => 'ae544126-8d95-8e94-8581-c0de1912d2bd',
  });
  local.bind({ agents: () => [] });
  await assert.rejects(local.port().start(req()), /must not have the form of a MoMo chat/);
  assert.equal(sessions.sent.length, 0);
});

test('how sessions ended is kept sealed, newest last, and read back', async (t) => {
  const dir = tmp(t);
  const ends = createTaskEnds({ dir, safeStorage: createFileSafeStorage(dir), now: Date.now, keep: 2 });
  assert.equal(ends.get('a'), null);
  await ends.set('a', { kind: 'finished', report: 'ra' });
  await ends.set('b', { kind: 'finished', report: 'rb' });
  await ends.set('c', { kind: 'lost', reason: 'machine_restarted' });
  assert.deepEqual(
    [ends.get('a'), ends.get('b'), ends.get('c')],
    [null, { kind: 'finished', report: 'rb' }, { kind: 'lost', reason: 'machine_restarted' }],
  );
});

test('the seed hook writes one record into each file the service keeps, so a move can be tested', async (t) => {
  const d = double();
  t.after(() => fs.rmSync(d.dir, { recursive: true, force: true }));
  await d.hooks.seed();
  for (const name of ['tasks.json', 'task-keys.json', 'task-ends.json']) assert.ok(fs.existsSync(path.join(d.dir, name)), name);
  const items = await d.api.view();
  assert.deepEqual(
    items.map((v: any) => [v.title, v.state]),
    [['Seed', 'watching']],
  );
});
