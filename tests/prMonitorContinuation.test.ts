// PR success continuations preserve explicit follow-ups across idle chats, restarts and retired reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrMonitor } from '../electron/session/prMonitor.cjs';
import { deferred } from './support/async-scenarios.ts';

const url = 'https://github.com/o/r/pull/1';
const continuation = { when: 'merged', message: 'Verify the merge, update the task list and build the authorized extension package.' };
function fixture(seed: any[] = []) {
  let saved = seed;
  const sent: any[] = [];
  const o = {
    load: () => saved,
    save: (rows: any[]) => {
      saved = structuredClone(rows);
    },
    exists: () => true,
    scope: () => 'claude/native/account',
    read: async (): Promise<any> => ({ state: 'OPEN', events: [], pending: 1, checksPassed: false, parents: [] }),
    blocked: async (): Promise<string | null> => null,
    deliver: async (_id: string, item: any): Promise<any> => {
      sent.push(item);
      return { started: true };
    },
    changed: () => {},
  };
  const monitor = new PrMonitor(o);
  return { o, monitor, sent, saved: () => saved };
}

test('merged PR wakes a read-only monitor once and consumes the durable follow-up after acceptance', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, continuation });
  assert.deepEqual(f.monitor.snapshot('chat').continuation, continuation);
  await f.monitor.tick();
  assert.equal(f.sent.length, 0);
  assert.match(f.monitor.snapshot('chat').message, /Waiting for PR merge/);
  const restored = fixture(f.saved());
  restored.o.read = async () => ({ state: 'MERGED', events: [], parents: [] });
  restored.o.deliver = async (_id, item) => {
    assert.ok(restored.saved()[0].claim);
    restored.sent.push(item);
    return { started: true };
  };
  await restored.monitor.tick();
  assert.equal(restored.sent.length, 1);
  assert.match(restored.sent[0].text, /Verify the merge/);
  assert.match(restored.sent[0].text, /update_task_list/);
  assert.equal(restored.sent[0].opts.human, false);
  assert.equal(restored.monitor.snapshot('chat').continuation, null);
  const final = fixture(restored.saved());
  final.o.read = restored.o.read;
  await final.monitor.tick();
  assert.equal(final.sent.length, 0);
});

test('checks continuation requires positive current-head evidence and waits through busy or stopped chats', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, continuation: { ...continuation, when: 'checks_pass' } });
  for (const pr of [
    { state: 'OPEN', events: [] },
    { state: 'OPEN', events: [], checksPassed: false },
  ]) {
    f.o.read = async () => pr;
    await f.monitor.tick();
    assert.equal(f.sent.length, 0);
  }
  f.o.read = async () => ({ state: 'OPEN', events: [], checksPassed: true });
  f.o.blocked = async () => 'stopped by user';
  await f.monitor.tick();
  assert.match(f.monitor.snapshot('chat').message, /stopped by user/);
  f.o.blocked = async () => null;
  await f.monitor.tick();
  assert.equal(f.sent.length, 1);
});

test('cancellation, rebind, scope retirement and disposal prevent late success dispatch', async () => {
  for (const retire of ['cancel', 'rebind', 'scope', 'dispose']) {
    const f = fixture();
    f.monitor.configure('chat', { url, continuation });
    const read = deferred<any>();
    f.o.read = () => read.promise;
    const pending = f.monitor.refresh('chat');
    if (retire === 'cancel') f.monitor.configure('chat', { continuation: null });
    if (retire === 'rebind') f.monitor.configure('chat', { url: url + '2' });
    if (retire === 'scope') f.o.scope = () => 'acp/other/account';
    if (retire === 'dispose') f.monitor.dispose();
    read.resolve({ state: 'MERGED', events: [] });
    await pending;
    assert.equal(f.sent.length, 0);
  }
});

test('invalid continuations are rejected on configure and load without overwriting state', () => {
  for (const value of [
    false,
    [],
    {},
    { when: 'merged', message: '' },
    { when: 'merged', message: ' ' },
    { when: 'later', message: 'x' },
    { when: 'merged', message: 3 },
    { when: 'merged', message: 'x'.repeat(2001) },
  ]) {
    const f = fixture();
    f.monitor.configure('chat', { url, continuation });
    const before = f.saved();
    assert.throws(() => f.monitor.configure('chat', { continuation: value }), /Invalid PR continuation/);
    assert.equal(f.saved(), before);
    const corrupt = fixture([{ ...before[0], continuation: value }]);
    assert.throws(() => corrupt.monitor.snapshot('chat'), /Invalid PR monitor/);
  }
});

test('closed PR, network errors, rejection, uncertain acceptance and explicit retry retain the follow-up', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, continuation });
  f.o.read = async () => ({ state: 'CLOSED', events: [], checksPassed: true });
  await f.monitor.tick();
  assert.equal(f.sent.length, 0);
  assert.match(f.monitor.snapshot('chat').message, /closed without merging/);
  f.o.read = async () => {
    throw new Error('offline');
  };
  await f.monitor.tick();
  assert.equal(f.monitor.snapshot('chat').error, 'offline');
  f.o.read = async () => ({ state: 'MERGED', events: [] });
  f.o.deliver = async () => ({ started: false, error: 'not accepted' });
  await f.monitor.tick();
  assert.equal(f.monitor.snapshot('chat').uncertain, true);
  assert.deepEqual(f.monitor.snapshot('chat').continuation, continuation);
  const restored = fixture(f.saved());
  restored.o.read = f.o.read;
  await restored.monitor.tick();
  assert.equal(restored.sent.length, 0);
  restored.monitor.configure('chat', { retry: true });
  await restored.monitor.tick();
  assert.equal(restored.sent.length, 1);
});

test('independent settings and a cancelled follow-up survive late acceptance with its reservation', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, continuation });
  f.o.read = async () => ({ state: 'MERGED', events: [] });
  const accepted = deferred<any>();
  f.o.deliver = () => accepted.promise;
  const task = f.monitor.refresh('chat');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(f.monitor.snapshot('chat').claim);
  f.monitor.configure('chat', { addressComments: true, continuation: null });
  accepted.resolve({ started: true });
  await task;
  assert.equal(f.monitor.snapshot('chat').addressComments, true);
  assert.equal(f.monitor.snapshot('chat').continuation, null);
  assert.equal(f.monitor.snapshot('chat').uncertain, true);
});

test('a ready follow-up preserves simultaneous feedback for the next Auto-fix turn', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, autoFix: true, continuation: { ...continuation, when: 'checks_pass' } });
  f.o.read = async () => ({ state: 'OPEN', checksPassed: true, events: [{ key: 'review', text: 'New unresolved review feedback' }] });
  await f.monitor.tick();
  assert.match(f.sent[0].text, /PR continuation/);
  assert.deepEqual(f.saved()[0].seen, []);
  await f.monitor.tick();
  assert.match(f.sent[1].text, /New unresolved review feedback/);
  assert.deepEqual(f.saved()[0].seen, ['review']);
  await f.monitor.tick();
  assert.equal(f.sent.length, 2);
});

test('an explicitly armed one-shot follow-up works after Auto-fix exhausted its budget', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, autoFix: true });
  let head = 0;
  f.o.read = async () => ({ state: 'OPEN', events: [{ key: String(++head), text: 'Failing check' }] });
  for (let i = 0; i < 6; i++) await f.monitor.tick();
  assert.equal(f.sent.length, 5);
  f.monitor.configure('chat', { continuation });
  f.o.read = async () => ({ state: 'MERGED', events: [] });
  await f.monitor.tick();
  assert.equal(f.sent.length, 6);
  assert.equal(f.monitor.snapshot('chat').continuation, null);
});

test('a continuation does not spend the remaining Auto-fix attempt needed for simultaneous feedback', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, autoFix: true });
  let head = 0;
  f.o.read = async () => ({ state: 'OPEN', events: [{ key: String(++head), text: 'Failing check' }] });
  for (let i = 0; i < 4; i++) await f.monitor.tick();
  f.monitor.configure('chat', { continuation: { ...continuation, when: 'checks_pass' } });
  f.o.read = async () => ({ state: 'OPEN', checksPassed: true, events: [{ key: 'review', text: 'New unresolved review feedback' }] });
  await f.monitor.tick();
  assert.equal(f.monitor.snapshot('chat').attempts, 4);
  await f.monitor.tick();
  assert.match(f.sent.at(-1).text, /New unresolved review feedback/);
  assert.equal(f.monitor.snapshot('chat').attempts, 5);
});

test('reservation and acknowledgement persistence failures never lose or replay a follow-up', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture();
    f.monitor.configure('chat', { url, continuation });
    f.o.read = async () => ({ state: 'MERGED', events: [] });
    const save = f.o.save;
    let writes = 0;
    f.o.save = (rows) => {
      if (++writes === failAt) throw new Error('disk full');
      save(rows);
    };
    await f.monitor.tick();
    assert.deepEqual(f.monitor.snapshot('chat').continuation, continuation);
    assert.match(f.monitor.snapshot('chat').error, /disk full/);
    assert.equal(f.sent.length, failAt === 1 ? 0 : 1);
    const restored = fixture(f.saved());
    restored.o.read = f.o.read;
    await restored.monitor.tick();
    assert.equal(restored.sent.length, failAt === 1 ? 1 : 0);
  }
});

test('configuration while an old read waits coalesces one fresh read for the latest owner', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url });
  const old = deferred<any>();
  let reads = 0;
  f.o.read = async () => {
    reads++;
    return reads === 1 ? old.promise : { state: 'OPEN', events: [] };
  };
  const first = f.monitor.refresh('chat');
  f.monitor.configure('chat', { continuation });
  const latest = f.monitor.refresh('chat');
  f.monitor.configure('chat', { addressComments: true });
  assert.equal(f.monitor.refresh('chat'), latest);
  old.resolve({ state: 'MERGED', events: [] });
  await Promise.all([first, latest]);
  assert.equal(reads, 2);
  assert.equal(f.sent.length, 0);
  assert.equal(f.monitor.snapshot('chat').message, 'Waiting for PR merge');
});

test('queued fresh reads stop on disposal and follow account ownership changes', async () => {
  for (const dispose of [false, true]) {
    const f = fixture();
    f.monitor.configure('chat', { url, continuation });
    const old = deferred<any>();
    let reads = 0;
    f.o.read = async () => {
      reads++;
      return reads === 1 ? old.promise : { state: 'MERGED', events: [] };
    };
    const first = f.monitor.refresh('chat');
    f.o.scope = () => 'acp/replacement/account';
    const latest = f.monitor.refresh('chat');
    if (dispose) f.monitor.dispose();
    old.resolve({ state: 'MERGED', events: [] });
    await Promise.all([first, latest]);
    assert.equal(reads, dispose ? 1 : 2);
    assert.equal(f.sent.length, dispose ? 0 : 1);
  }
});

test('turn-end rechecks ignore absent, cancelled, disposed and unreadable monitor ownership', () => {
  const f = fixture();
  assert.equal(f.monitor.afterTurn('missing'), undefined);
  f.monitor.configure('chat', { url, continuation: null });
  assert.equal(f.monitor.afterTurn('chat'), undefined);
  f.monitor.dispose();
  assert.equal(f.monitor.afterTurn('chat'), undefined);
  const corrupt = fixture([null]);
  assert.equal(corrupt.monitor.afterTurn('chat'), undefined);
});

test('turn-end recheck trails an in-flight busy verdict and coalesces repeated settlement signals', async () => {
  const f = fixture();
  f.monitor.configure('chat', { url, continuation });
  f.o.read = async () => ({ state: 'MERGED', events: [] });
  const gate = deferred<string | null>();
  let checks = 0;
  f.o.blocked = () => (++checks === 1 ? gate.promise : Promise.resolve(null));
  const first = f.monitor.refresh('chat');
  await Promise.resolve();
  assert.equal(checks, 1);
  const next = f.monitor.afterTurn('chat');
  assert.equal(f.monitor.afterTurn('chat'), next);
  gate.resolve('chat busy');
  await Promise.all([first, next]);
  assert.equal(checks, 2);
  assert.equal(f.sent.length, 1);
});
