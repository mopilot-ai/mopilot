// A Host-fired scheduled run and approvals (U3, host/src/schedules.mjs + host/src/approvals.mjs): a run that stops on a card never waits for ever under `skip`, follows the normal clock under `wait` (and for an older app that sends no setting), and counts as working so the next due time does not start another beside it (A6, B3, B1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createHostSchedules, hostSchedulesFor } from '../host/src/schedules.mjs';
// @ts-ignore
import { wireTaskOf } from '../shared/host/hostSchedules.mjs';

const require = createRequire(import.meta.url);
const { RRule } = require('rrule');
const { scheduleRules } = require('../shared/schedule.mjs');
const rules = scheduleRules(RRule);
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 9, 0, 30);
const quiet = { report: () => undefined };

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

/** A Host with an ACP runtime that raises a card while it starts the run (`during`) or after (`later`). */
function world(t: any, o: { cardWhen?: 'during' | 'later' | 'never' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sched-approvals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host: any = new EventEmitter();
  const cancelled: string[] = [];
  host.cancel = (key: string) => cancelled.push(key);
  let clock = T0;
  let turns = 0;
  const card = (key: string, n: number) => {
    host.emit('event', { kind: 'turnStart', key, turnId: `t${n}` });
    host.emit('event', {
      kind: 'permission',
      key,
      requestId: `r${n}`,
      turnId: `t${n}`,
      toolCall: { title: 'rm -rf build', kind: 'delete' },
      options: [],
    });
  };
  const runtime: any = {
    host,
    familyOf: () => 'acp',
    permit: () => true,
    send: async (p: any) => {
      turns += 1;
      if (o.cardWhen !== 'never' && o.cardWhen !== 'later') card(p.key, turns);
      return { turnId: `t${turns}` };
    },
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    dataDir: dir,
    ...quiet,
    approvalClock: { now: () => clock },
  });
  let n = 0;
  const schedules = createHostSchedules({
    file: path.join(dir, 'schedules.json'),
    rules,
    start: async (p: any) => protocol.startScheduled(p),
    ready: async () => ({ ok: true }),
    busy: (chatId: string) => protocol.awaiting(chatId),
    mintChatId: (h: string) => `acp:${h}:c${++n}`,
    now: () => clock,
    report: () => undefined,
  });
  protocol.keepSchedules(schedules);
  const frames: any[] = [];
  const conn = protocol.connection((m: object) => frames.push(m));
  return {
    dir,
    host,
    runtime,
    protocol,
    schedules,
    cancelled,
    frames,
    conn,
    card,
    advance: (ms: number) => (clock += ms),
    turns: () => turns,
  };
}
const events = (w: any, kind: string) =>
  w.frames.filter((m: any) => m.frame?.item?.event?.kind === kind).map((m: any) => m.frame.item.event);
const statuses = (w: any) => w.schedules.runs(0).runs.map((r: any) => [r.status, r.chatId]);

test('B3: a task from an older app with no onApproval is `wait`; the setting is validated and kept as sent', () => {
  assert.equal('onApproval' in wireTaskOf(task()), false);
  assert.equal(wireTaskOf(task({ onApproval: 'skip' })).onApproval, 'skip');
  assert.equal(wireTaskOf(task({ onApproval: 'wait' })).onApproval, 'wait');
  assert.throws(() => wireTaskOf(task({ onApproval: 'maybe' })), /approval/);
});

test('A6: a `skip` run that reaches a card closes it at once as expired, stops, and ends as needs-approval', async (t) => {
  const w = world(t);
  w.schedules.sync([task({ onApproval: 'skip' })]);
  await w.schedules.tick();
  // the chat is paused, not waiting
  assert.equal(w.turns(), 1);
  assert.deepEqual(w.cancelled, ['acp:kimi:c1']);
  assert.deepEqual(statuses(w), [
    ['started', 'acp:kimi:c1'],
    ['needs-approval', 'acp:kimi:c1'],
  ]);
  assert.equal(w.protocol.awaiting('acp:kimi:c1'), false);
  assert.deepEqual(
    ((await w.conn.call('host.hello', (await import('../shared/host/schema.mjs')).helloParams())) as any).agreed.features.includes(
      'approvals2',
    ),
    true,
  );
  assert.deepEqual(((await w.conn.call('host.pending', {})) as any).attention, [
    { chatId: 'acp:kimi:c1', kind: 'paused', since: T0, reason: 'approval_timeout' },
  ]);
  // the harness's own close and the turn's end add nothing
  w.host.emit('event', { kind: 'permissionCancelled', key: 'acp:kimi:c1', requestId: 'r1' });
  w.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled' });
  assert.equal(statuses(w).length, 2);
});

test('A6: a skip run that raises a card after its start was recorded is recorded once; a second card changes nothing', async (t) => {
  const w = world(t, { cardWhen: 'later' });
  w.schedules.sync([task({ onApproval: 'skip' })]);
  await w.schedules.tick();
  assert.deepEqual(statuses(w), [['started', 'acp:kimi:c1']]);
  await w.conn.call('host.hello', (await import('../shared/host/schema.mjs')).helloParams());
  await w.conn.call('chat.subscribe', { chatId: 'acp:kimi:c1', epoch: 0 });
  w.card('acp:kimi:c1', 1);
  w.host.emit('event', { kind: 'permission', key: 'acp:kimi:c1', requestId: 'r2', turnId: 't1', options: [] });
  assert.deepEqual(statuses(w), [
    ['started', 'acp:kimi:c1'],
    ['needs-approval', 'acp:kimi:c1'],
  ]);
  assert.equal(events(w, 'permissionCancelled').filter((e: any) => e.reason === 'expired').length, 2);
  // a later message is a person's: its cards wait as usual
  w.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled' });
  w.card('acp:kimi:c1', 2);
  assert.equal(w.protocol.awaiting('acp:kimi:c1'), true);
});

test('a `wait` run, and a run of an older app, keep the normal clock; the next due time is skipped while it waits', async (t) => {
  for (const onApproval of ['wait', undefined]) {
    const w = world(t);
    w.schedules.sync([task(onApproval ? { onApproval } : {})]);
    await w.schedules.tick();
    assert.deepEqual(statuses(w), [['started', 'acp:kimi:c1']]);
    assert.equal(w.protocol.awaiting('acp:kimi:c1'), true);
    assert.deepEqual(w.cancelled, []);
    // the next minute's time: the previous run is working (it waits on a card), so no second run starts beside it
    w.advance(MIN);
    await w.schedules.tick();
    assert.equal(w.turns(), 1);
    assert.equal(w.schedules.runs(0).runs.at(-1)?.reason, 'previous-running');
  }
});

test('the busy test counts a turn that waits for a person, from the session state and from the engine alike', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sched-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const started: string[] = [];
  let turn: string | undefined = 'awaitingUser';
  let waiting = false;
  const s = hostSchedulesFor({
    dataDir: dir,
    rules,
    protocol: { startScheduled: (p: any) => started.push(p.chatId), awaiting: () => waiting },
    harnesses: async () => [{ id: 'kimi', detected: true, signedIn: true }],
    state: { has: () => true, get: () => ({ turn }) },
    report: () => undefined,
  });
  s.sync([task()]);
  await s.tick();
  t.mock.timers.tick(MIN);
  await s.tick();
  assert.equal(started.length, 1, 'a run waiting on a card is still working (session state)');
  assert.equal(s.runs(0).runs.at(-1)?.reason, 'previous-running');
  turn = undefined;
  waiting = true;
  t.mock.timers.tick(MIN);
  await s.tick();
  assert.equal(started.length, 1, 'and so is one the engine holds a card for');
  waiting = false;
  t.mock.timers.tick(MIN);
  await s.tick();
  assert.equal(started.length, 2, 'an idle run no longer blocks the next');
});
