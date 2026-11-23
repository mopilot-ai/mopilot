// PR monitor ownership, durable delivery, failure recovery and scheduling contract tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrMonitor } from '../electron/session/prMonitor.cjs';
import { deferred } from './support/async-scenarios.ts';

const url = 'https://github.com/o/r/pull/1';
const row = (chatId = 'chat') => ({
  chatId,
  url,
  autoFix: true,
  addressComments: true,
  seen: [] as string[],
  claim: null as string | null,
});
const pr = (state = 'OPEN', events = [{ key: 'failed', text: 'Failing check: unit-tests' }]) => ({ state, events });
function fixture(overrides: Record<string, any> = {}) {
  let saved: any[] = [];
  const delivered: any[] = [];
  const changed: string[] = [];
  const o = {
    load: () => [],
    save: (rows: any[]) => {
      saved = structuredClone(rows);
    },
    exists: () => true,
    scope: () => 'codex/session/account',
    read: async () => pr(),
    blocked: async () => null,
    deliver: async (id: string, item: any) => {
      delivered.push([id, item]);
      return { started: true };
    },
    changed: (id: string) => changed.push(id),
    ...overrides,
  };
  const monitor = new PrMonitor(o);
  return { monitor, o, delivered, changed, saved: () => saved };
}

test('binding defaults, canonical URLs, independent edits and failed persistence preserve authoritative state', () => {
  const f = fixture();
  assert.equal(f.monitor.snapshot('empty'), null);
  assert.equal(f.monitor.configure('a', { url: url + '/?q=x' }).autoFix, false);
  f.monitor.configure('b', { url, autoFix: true, addressComments: true });
  f.monitor.configure('a', { addressComments: true });
  assert.equal(f.monitor.snapshot('a')!.url, url);
  assert.equal(f.monitor.snapshot('b')!.autoFix, true);
  f.monitor.configure('b', { url: url.replace('/1', '/2') });
  assert.deepEqual(f.monitor.snapshot('b')!.seen, []);
  f.o.save = () => {
    throw new Error('disk full');
  };
  assert.throws(() => f.monitor.configure('b', { autoFix: false }), /disk full/);
  assert.equal(f.monitor.snapshot('b')!.autoFix, true);
  for (const patch of [{ url: 'bad' }, { autoFix: 1 }, { addressComments: 'true' }]) assert.throws(() => f.monitor.configure('a', patch));
  f.o.exists = () => false;
  assert.throws(() => f.monitor.configure('a', { url }), /unavailable/);
});

test('load validation refuses corrupt data without overwriting it; no automatic tick on unreadable state', async () => {
  const bad = [
    null,
    {},
    [null],
    [{ ...row(), chatId: '' }],
    [{ ...row(), url: 'bad' }],
    [{ ...row(), autoFix: 1 }],
    [{ ...row(), addressComments: 1 }],
    [{ ...row(), seen: {} }],
    [{ ...row(), seen: [1] }],
    [{ ...row(), claim: 1 }],
    [row(), row()],
  ];
  for (const value of bad) {
    const f = fixture({ load: () => value, save: () => assert.fail('must preserve unreadable data') });
    assert.throws(() => f.monitor.snapshot('chat'), /Invalid/);
    await f.monitor.tick();
    assert.throws(() => f.monitor.configure('chat', { url }));
  }
  const f = fixture({
    load: () => {
      throw new Error('read denied');
    },
  });
  assert.throws(() => f.monitor.snapshot('chat'), /read denied/);
});

test('background autofix durably claims before send and deduplicates the same event across restart', async () => {
  const f = fixture();
  f.monitor.configure('opaque:"a:b\\c', { url, autoFix: true });
  f.o.deliver = async (id: string, item: any) => {
    assert.ok(f.saved()[0].claim);
    assert.equal(item.opts.human, false);
    assert.match(item.text, /^\[Automated PR monitor message, not from the user\]/);
    assert.match(item.text, /does not forbid or grant merging/);
    assert.doesNotMatch(item.text, /do not merge|auto-merge/i);
    f.delivered.push([id, item]);
    return { started: true };
  };
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.monitor.snapshot('opaque:"a:b\\c')!.message, 'Monitoring');
  const next = fixture({ load: () => f.saved() });
  await next.monitor.tick();
  assert.equal(next.delivered.length, 0);
  next.o.read = async () => pr('OPEN', [{ key: 'new head', text: 'Failing check: test' }]);
  await next.monitor.tick();
  assert.equal(next.delivered.length, 1);
});

test('read-only monitoring, terminal PRs, no events, busy chats and persisted uncertain delivery never start turns', async () => {
  for (const settings of [{ autoFix: false }, {}]) {
    for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
      const f = fixture({ load: () => [{ ...row(), ...settings }], read: async () => pr(state, []) });
      await f.monitor.refresh('chat');
      assert.equal(f.delivered.length, 0);
      assert.ok(f.monitor.snapshot('chat')!.message);
    }
  }
  for (const initial of [
    { ...row(), autoFix: false },
    { ...row(), claim: 'uncertain' },
  ]) {
    const f = fixture({ load: () => [initial] });
    await f.monitor.tick();
    assert.equal(f.delivered.length, 0);
  }
  const f = fixture({ load: () => [row()], blocked: async () => 'approval required' });
  await f.monitor.tick();
  assert.match(f.monitor.snapshot('chat')!.message!, /approval required/);
  f.o.blocked = async () => null;
  await f.monitor.tick();
  assert.equal(f.delivered.length, 1);
  await f.monitor.refresh('unknown');
  f.o.exists = () => false;
  await f.monitor.tick();
});

test('equivalent overlapping reads coalesce; settings, scope, deletion and disposal retire stale success and errors', async () => {
  for (const retire of ['configure', 'scope', 'delete', 'dispose'])
    for (const rejected of [false, true]) {
      const pending = deferred<any>();
      const f = fixture({ load: () => [row()], read: () => pending.promise });
      const first = f.monitor.refresh('chat');
      assert.equal(f.monitor.refresh('chat'), first);
      if (retire === 'configure') f.monitor.configure('chat', { autoFix: false });
      if (retire === 'scope') f.o.scope = () => 'claude/new/account';
      if (retire === 'delete') f.o.exists = () => false;
      if (retire === 'dispose') f.monitor.dispose();
      if (rejected) pending.reject(new Error('old failure'));
      else pending.resolve(pr());
      await first;
      assert.equal(f.delivered.length, 0);
      if (retire !== 'dispose') assert.equal(f.monitor.snapshot('chat')!.error, undefined);
      else {
        await f.monitor.tick();
        assert.throws(() => f.monitor.refresh('chat'), /stopped/);
      }
    }
});

test('retirement while the availability gate waits cannot dispatch a continuation', async () => {
  const gate = deferred<null>();
  const f = fixture({ load: () => [row()], blocked: () => gate.promise });
  const task = f.monitor.refresh('chat');
  await Promise.resolve();
  f.monitor.configure('chat', { autoFix: false });
  gate.resolve(null);
  await task;
  assert.equal(f.delivered.length, 0);
});

test('network failure recovers; refused, rejected and unacknowledged deliveries require explicit retry', async () => {
  const f = fixture({
    load: () => [row()],
    read: async () => {
      throw new Error('offline');
    },
  });
  await f.monitor.tick();
  assert.equal(f.monitor.snapshot('chat')!.error, 'offline');
  f.o.read = async () => pr();
  for (const result of [undefined, { started: false, error: 'not signed in' }, 'reject']) {
    f.o.deliver = async (): Promise<any> => {
      if (result === 'reject') throw 'transport failed';
      return result;
    };
    await f.monitor.tick();
    assert.ok(f.monitor.snapshot('chat')!.uncertain);
    const previous = f.monitor.snapshot('chat')!.claim;
    await f.monitor.tick();
    assert.equal(f.monitor.snapshot('chat')!.claim, previous);
    f.monitor.configure('chat', { retry: true });
  }
  f.o.deliver = async () => ({ started: true });
  f.o.save = () => {
    throw new Error('write failed');
  };
  await f.monitor.tick();
  assert.equal(f.monitor.snapshot('chat')!.uncertain, false);
  assert.match(f.monitor.snapshot('chat')!.error!, /write failed/);
});

test('ACK persistence failure preserves the reservation through restart', async () => {
  let writes = 0;
  const f = fixture({ load: () => [row()] });
  f.o.save = (rows: any[]) => {
    if (++writes === 2) throw new Error('ACK write failed');
  };
  await f.monitor.tick();
  assert.equal(f.delivered.length, 1);
  assert.equal(f.monitor.snapshot('chat')!.uncertain, true);
  const next = fixture({ load: () => [{ ...row(), claim: 'saved reservation' }] });
  await next.monitor.tick();
  assert.equal(next.delivered.length, 0);
});

test('settings edited during send survive its late result and retain the reservation', async () => {
  for (const fail of [false, true]) {
    const send = deferred<any>();
    const f = fixture({ load: () => [row()], deliver: () => send.promise });
    const task = f.monitor.refresh('chat');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(f.monitor.snapshot('chat')!.uncertain, true);
    f.monitor.configure('chat', { autoFix: false, addressComments: false });
    if (fail) send.reject(new Error('late rejection'));
    else send.resolve({ started: true });
    await task;
    assert.equal(f.monitor.snapshot('chat')!.autoFix, false);
    assert.equal(f.monitor.snapshot('chat')!.addressComments, false);
    assert.equal(f.monitor.snapshot('chat')!.error, undefined);
    assert.equal(f.monitor.snapshot('chat')!.uncertain, true);
  }
});

test('tick serializes across chats and disposal stops a pending sweep', async () => {
  const pending = deferred<any>();
  const reads: string[] = [];
  const f = fixture({
    load: () => [row('a'), row('b')],
    read: (_url: string, _comments: boolean, id: string) => {
      reads.push(id);
      return pending.promise;
    },
  });
  const task = f.monitor.tick();
  assert.deepEqual(reads, ['a']);
  f.monitor.dispose();
  pending.resolve(pr());
  await task;
  assert.deepEqual(reads, ['a']);
});

test('automatic attempts are durably bounded and explicit Retry replenishes the budget', async () => {
  let head = 0;
  const f = fixture({ load: () => [row()], read: async () => pr('OPEN', [{ key: `head-${++head}`, text: 'Failing check: tests' }]) });
  for (let i = 0; i < 7; i++) await f.monitor.tick();
  assert.equal(f.delivered.length, 5);
  assert.equal(f.monitor.snapshot('chat')!.limited, true);
  assert.match(f.monitor.snapshot('chat')!.message!, /attempt limit/);
  const restarted = fixture({ load: () => f.saved() });
  await restarted.monitor.tick();
  assert.equal(restarted.delivered.length, 0);
  f.monitor.configure('chat', { retry: true });
  await f.monitor.tick();
  assert.equal(f.delivered.length, 6);
  for (const attempts of [-1, 0.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    const bad = fixture({ load: () => [{ ...row(), attempts }] });
    assert.throws(() => bad.monitor.snapshot('chat'), /Invalid/);
  }
});

test('an unread stack keeps the last one read while the base is unchanged; a new base or a read stack replaces it', async () => {
  const parent = { url: 'https://github.com/o/r/pull/2', title: 'Parent', state: 'OPEN', headRefName: 'b', baseRefName: 'main' };
  const reads: any[] = [
    { state: 'OPEN', events: [], baseRefName: 'b', parents: [parent] },
    { state: 'OPEN', events: [], baseRefName: 'b', parents: null },
    { state: 'OPEN', events: [], baseRefName: 'main', parents: null },
    { state: 'OPEN', events: [], baseRefName: 'b', parents: [] },
  ];
  const { monitor } = fixture({ read: async () => reads.shift() });
  monitor.configure('chat', { url });
  const parents = async () => {
    await monitor.refresh('chat');
    return monitor.snapshot('chat').pr.parents;
  };
  assert.deepEqual(await parents(), [parent]);
  // the parents' read failed: the cards stay as last read
  assert.deepEqual(await parents(), [parent]);
  // the PR moved to another base, so the old stack no longer describes it
  assert.deepEqual(await parents(), []);
  assert.deepEqual(await parents(), []);
  // a fresh binding has no last stack to keep
  monitor.configure('chat', { url: 'https://github.com/o/r/pull/3' });
  reads.push({ state: 'OPEN', events: [], baseRefName: 'b', parents: null });
  assert.deepEqual(await parents(), []);
});
