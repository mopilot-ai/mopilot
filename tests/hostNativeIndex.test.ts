// Native sessions as `host.chats` lists and tells them (#5576, Phase 4, slice 1): read-only rows kept apart from the journals, listed only to the kinds of client that may see them, in the same order and cursor as the Host's own chats, with the sessions this Host runs never among them. Fakes only: no agent's folder is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import chatsMethods from '../host/src/methods/chats.mjs';
import { createChatIndex } from '../host/src/chatIndex.mjs';
import { createNativeIndex, NATIVE_EVENT_GAP_MS } from '../host/src/nativeIndex.mjs';
import { chatScopeOf } from '../host/src/chatScope.mjs';
import { chatListOf } from '../host/src/chatList.mjs';

import { UUID, who, session, host, list } from './support/host/nativeKit.ts';

test('a native session is a read-only row with no epoch of its own, titled by what is known or by a short id', async () => {
  const h = host();
  h.native.upsert(session(1));
  h.native.upsert(session(2, { title: '', running: true }));
  h.native.upsert(session(3, { attention: true, app: 'terminal', folderMissing: true, format: 'unknown' }));
  const { chats } = await list(h, { origin: 'native' }, 'desktop');
  assert.deepEqual(
    chats.map((c: any) => [c.chatId, c.title, c.state]),
    [
      [`native:claude:${UUID(3)}`, 'session 3', 'attention'],
      [`native:claude:${UUID(2)}`, 'Session 000000', 'running'],
      [`native:claude:${UUID(1)}`, 'session 1', 'idle'],
    ],
  );
  const row = chats[0];
  assert.equal(row.origin, 'native');
  assert.equal(row.readOnly, true);
  assert.equal(row.epoch, 0);
  assert.equal(row.harness, 'claude');
  assert.equal(row.app, 'terminal');
  assert.equal(row.folderMissing, true);
  assert.equal(row.format, 'unknown');
  assert.ok(!('id' in row) && !('family' in row) && !('running' in row) && !('attention' in row), 'only the wire fields');
});

test('only a desktop, a terminal or a controller is told of native sessions; any other kind, and a client of unknown standing, gets an empty list and no feature', async () => {
  const h = host([{ chatId: 'claude:own', updatedAt: 5 }]);
  h.native.upsert(session(1));
  for (const kind of ['desktop', 'cli', 'controller']) assert.equal((await list(h, { origin: 'native' }, kind)).chats.length, 1, kind);
  for (const kind of ['phone', 'home', 'unknown', 'future-kind', null]) {
    const native = await list(h, { origin: 'native' }, kind);
    assert.deepEqual(native.chats, [], String(kind));
    assert.equal(native.next, undefined);
    const all = await list(h, { origin: 'all' }, kind);
    assert.ok(
      all.chats.every((c: any) => c.origin !== 'native'),
      `${kind}: the Host's own chats still list`,
    );
  }
  assert.equal(chatScopeOf(undefined)(who('desktop')).native, true);
  assert.equal(chatScopeOf(undefined)(undefined).native, false);
  // the hello names the features to the same kinds
  const shown = h.made.features;
  for (const f of ['nativeList', 'nativeEvents']) {
    assert.equal(shown[f]({ kind: 'controller', fingerprint: 'a' }), true);
    assert.equal(shown[f]({ kind: 'phone', fingerprint: 'a' }), false);
    assert.equal(shown[f](null), false);
  }
});

test('the default list is the Host’s own chats as before, and "all" merges both in one order with one cursor', async () => {
  const own = [10, 25, 40, 55, 70].map((u, i) => ({ chatId: `claude:own${i}`, updatedAt: u }));
  const h = host(own);
  for (const n of [1, 2, 3, 4, 5, 6]) h.native.upsert(session(n)); // updatedAt 10..60
  assert.ok(
    (await list(h, {}, 'desktop')).chats.every((c: any) => !c.origin),
    'an older client sees what it always saw',
  );
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const page = await list(h, { origin: 'all', limit: 3, ...(cursor ? { cursor } : {}) }, 'desktop');
    assert.ok(page.chats.length <= 3);
    seen.push(...page.chats.map((c: any) => c.chatId));
    cursor = page.next;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'no row twice');
  assert.equal(seen.length, 11, 'no row skipped');
  const whole = await list(h, { origin: 'all' }, 'desktop');
  assert.deepEqual(
    seen,
    whole.chats.map((c: any) => c.chatId),
    'paged and whole agree',
  );
  const times = whole.chats.map((c: any) => c.updatedAt);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
    'newest activity first across both',
  );
  assert.equal(whole.next, undefined);
  // a page of exactly the rows left has no next, and a cursor the Host never made is refused
  assert.equal((await list(h, { origin: 'all', limit: 11 }, 'desktop')).next, undefined);
  await assert.rejects(list(h, { origin: 'native', cursor: 'nonsense' }, 'desktop'), /not a place/);
  await assert.rejects(list(h, { origin: 'all', cursor: 'nonsense' }, 'desktop'), /not a place/);
});

test('a session this Host runs, an archived one and a removed one are not listed, and a Host built without the option refuses a native list', async () => {
  const h = host([
    { chatId: `claude:${UUID(1)}`, updatedAt: 1 },
    { chatId: UUID(2), updatedAt: 1 },
  ]);
  h.native.upsert(session(1)); // the Host's Claude chat of the same id
  h.native.upsert({ ...session(2), family: 'codex' }); // the Host's Codex thread (a bare id)
  h.native.upsert(session(3));
  h.native.upsert(session(4, { archived: true }));
  h.native.upsert({ ...session(5), family: 'codex' });
  h.native.remove('claude', UUID(3));
  await h.log.index.ready();
  const ids = (await list(h, { origin: 'native' }, 'desktop')).chats.map((c: any) => c.chatId);
  assert.deepEqual(ids, [`native:codex:${UUID(5)}`]);
  assert.equal(h.native.size, 1);
  assert.equal(h.native.get(`native:claude:${UUID(1)}`), null, 'not readable or adoptable either');
  assert.equal(h.native.get(`native:codex:${UUID(5)}`).id, UUID(5));
  h.native.remove('claude', UUID(99)); // an id that was never listed
  const plain = host([], null);
  assert.equal(plain.native, undefined);
  assert.throws(() => list(plain, { origin: 'native' }, 'desktop'), /does not list native/);
  assert.equal((await list(plain, {}, 'desktop')).chats.length, 0);
});

test('a scan names the family’s sessions: the ones it no longer names leave, a failed scan is simply not applied', () => {
  const told: string[] = [];
  const idx = createNativeIndex({ announce: (kind, chatId) => told.push(`${kind} ${chatId.slice(-3)}`), now: () => 0 });
  idx.replace('claude', [session(1), session(2)]);
  idx.replace('codex', [{ ...session(7), family: 'codex' }]);
  idx.replace('claude', [session(2)]);
  idx.replace('claude', [session(2)]); // nothing changed: nothing told
  assert.deepEqual(told, ['created 001', 'created 002', 'created 007', 'removed 001']);
  assert.equal(idx.size, 2, 'the other family’s rows stay');
  assert.equal(idx.has(`native:claude:${UUID(1)}`), false);
});

test('events: a watcher that asked and may see is told on the same count as the Host’s chats, one per row per gap, and a removal at once', async () => {
  const h = host([{ chatId: 'claude:own', updatedAt: 1 }]);
  const sent: Record<string, any[]> = { desk: [], phone: [], plain: [], controller: [] };
  const watch = async (name: string, kind: string, native: boolean) =>
    h.made.handlers['host.chats.watch'](
      { ...(native ? { native: true } : {}) },
      'x',
      who(kind),
      (m: any) => void sent[name]!.push(m),
      new Set(),
    );
  await watch('desk', 'desktop', true);
  await watch('phone', 'phone', true); // asked, may not see
  await watch('plain', 'desktop', false); // may see, did not ask
  await watch('controller', 'controller', true);
  const times = { now: 1_000, timers: [] as { fn: () => void; ms: number }[] };
  h.native.close();
  const idx = createNativeIndex({
    owned: () => false,
    announce: (...a) => h.log.index.announce(...a),
    now: () => times.now,
    later: (fn: () => void, ms: number) => {
      const timer = { fn, ms, unref() {} };
      times.timers.push(timer);
      return timer;
    },
    cancel: (t: any) => void (times.timers = times.timers.filter((x) => x !== t)),
  });
  idx.upsert(session(1)); // created, told
  times.now += 500;
  idx.upsert(session(1, { title: 'one', updatedAt: 99 })); // inside the gap: waits
  idx.upsert(session(1, { title: 'two', updatedAt: 100 })); // still one timer
  assert.equal(times.timers.length, 1);
  assert.equal(times.timers[0]!.ms, NATIVE_EVENT_GAP_MS - 500);
  assert.equal(sent.desk!.length, 1);
  times.timers.shift()!.fn();
  assert.equal(sent.desk!.length, 2);
  assert.equal(sent.desk![1].chat.title, 'two', 'what is told when the wait ends is the row as it is then');
  assert.equal(sent.desk![1].kind, 'changed');
  assert.deepEqual(
    sent.desk!.map((m) => m.seq),
    [1, 2],
  );
  assert.deepEqual(
    sent.controller!.map((m) => m.seq),
    [1, 2],
  );
  assert.deepEqual(sent.phone, [], 'a kind that may not see them hears nothing, not even a count');
  assert.deepEqual(sent.plain, [], 'a watcher that did not ask hears only the Host’s chats');
  // a change then a removal inside the gap: the removal is told at once and nothing is left waiting
  idx.upsert(session(1, { title: 'three', updatedAt: 101 }));
  assert.equal(times.timers.length, 1);
  idx.remove('claude', UUID(1));
  assert.equal(times.timers.length, 0);
  const last = sent.desk!.at(-1);
  assert.equal(last.op, 'remove');
  assert.equal(last.chatId, `native:claude:${UUID(1)}`);
  assert.equal(last.seq, 3);
  // a row archived after it was listed leaves like a removal; the timer of a row gone when it fires tells nothing
  times.now += 10_000;
  idx.upsert(session(2));
  times.now += 100;
  idx.upsert(session(2, { title: 'later' }));
  idx.upsert(session(2, { archived: true }));
  idx.remove('claude', UUID(2));
  const before = sent.desk!.length;
  for (const t of times.timers) t.fn();
  assert.equal(sent.desk!.length, before, 'nothing told for a row that is gone');
  idx.close();
});

test('a watcher that is behind is told once to list again, and the count of a native event carries on from the Host’s own', async () => {
  const h = host([{ chatId: 'claude:own', updatedAt: 1 }]);
  let accept = true;
  const got: any[] = [];
  await h.made.handlers['host.chats.watch']({ native: true }, 'x', who('desktop'), (m: any) => (got.push(m), accept), new Set());
  h.native.upsert(session(1));
  accept = false;
  h.native.upsert(session(2));
  accept = true;
  h.native.upsert(session(3));
  h.native.upsert(session(4));
  assert.deepEqual(
    got.map((m) => [m.seq, m.op]),
    [
      [1, 'upsert'],
      [2, 'upsert'],
      [3, 'resync'],
      [4, 'upsert'],
    ],
    'the one it could not take sets it behind: its next event is the one request to list again, then it is told as before',
  );
  h.native.close();
});

test('a send that throws is reported and does not stop the others', async () => {
  const h = host();
  await h.made.handlers['host.chats.watch'](
    { native: true },
    'x',
    who('desktop'),
    () => {
      throw new Error('socket closed');
    },
    new Set(),
  );
  const ok: any[] = [];
  await h.made.handlers['host.chats.watch']({ native: true }, 'x', who('cli'), (m: any) => void ok.push(m), new Set());
  h.native.upsert(session(1));
  assert.equal(ok.length, 1);
});

test('a native list says it is incomplete while the Host’s own list is, pages by its own cursor, and a Host without an attach hook still lists', async () => {
  let fail = true;
  const h = host([], {}, async () => {
    if (fail) throw new Error('disk');
    return [];
  });
  h.native.upsert(session(1));
  h.native.upsert(session(2));
  h.native.upsert(session(3));
  const first = await list(h, { origin: 'native', limit: 2 }, 'desktop');
  assert.equal(first.incomplete, true);
  const merged = await list(h, { origin: 'all' }, 'desktop');
  assert.equal(merged.incomplete, true, 'the merged list says it too while the Host’s own list is partial');
  assert.equal(first.chats.length, 2);
  assert.ok(first.next);
  const rest = await list(h, { origin: 'native', limit: 2, cursor: first.next }, 'desktop');
  assert.equal(rest.chats.length, 1);
  assert.equal(rest.next, undefined);
  fail = false;
  assert.equal((await list(h, { origin: 'native' }, 'desktop')).incomplete, undefined);
  assert.equal((await list(h, { origin: 'all' }, 'desktop')).incomplete, undefined);
  // an option with nothing to attach is fine; a watch that asks for native rows on a Host with none is just a plain watch
  const bare: any = chatsMethods({
    dataDir: '/d',
    log: {
      chats: async () => [],
      fillTitle: () => ({ status: 'deferred' }),
      index: createChatIndex({ load: async () => [], epoch: () => 1 }),
    },
    epochs: { current: () => 1 },
    nativeSessions: {},
  } as any);
  assert.deepEqual((await list({ made: bare }, { origin: 'native' }, 'desktop')).chats, []);
  const none: any = chatsMethods({
    dataDir: '/d',
    log: {
      chats: async () => [],
      fillTitle: () => ({ status: 'deferred' }),
      index: createChatIndex({ load: async () => [], epoch: () => 1 }),
    },
    epochs: { current: () => 1 },
  } as any);
  const told: any[] = [];
  const watching = await none.handlers['host.chats.watch']({ native: true }, 'x', who('desktop'), (m: any) => void told.push(m), new Set());
  assert.equal(watching.watching, true);
  h.native.close();
});

test('a row that the Host starts to run while its change waits is not told, the real timers are used by default, and a watcher with no scope asks for nothing native', () => {
  const told: string[] = [];
  let owned = false;
  const waiting: (() => void)[] = [];
  const idx = createNativeIndex({
    owned: () => owned,
    announce: (kind, chatId) => told.push(kind),
    now: () => 5_000,
    later: (fn: () => void) => (waiting.push(fn), {}), // a timer with no unref
    cancel: () => {},
  });
  idx.upsert(session(1));
  idx.upsert(session(1, { title: 'b' }));
  owned = true; // the Host began to run this session
  waiting.shift()!();
  assert.deepEqual(told, ['created'], 'nothing told for a session the Host owns now');
  const fresh = createNativeIndex({ announce: () => undefined });
  fresh.upsert(session(1));
  fresh.upsert(session(1, { title: 'b' })); // inside the real gap: a real timer, ended with the index
  fresh.close();
  const chats = createChatIndex({ load: async () => [], epoch: () => 1 });
  const got: any[] = [];
  chats.watch((m) => void got.push(m), undefined, { native: true });
  chats.announce('created', 'native:claude:x', 1, {});
  assert.deepEqual(got, [], 'a watch with no scope is never told of native rows');
  const reported: string[] = [];
  const loud = createChatIndex({ load: async () => [], epoch: () => 1, report: (m) => void reported.push(m) });
  loud.watch(
    () => {
      throw new Error('closed');
    },
    { sees: () => true, names: () => true, native: true },
    { native: true },
  );
  loud.announce('removed', 'native:claude:x', 2);
  assert.match(reported.join(), /could not be sent/);
});

test('an index with no hooks and a session with no title work, and a list of a Host with no native index is empty for a native call', async () => {
  const idx = createNativeIndex();
  const { title: _title, ...untitled } = session(4);
  idx.upsert(untitled);
  idx.upsert(session(4, { updatedAt: 1e6 }));
  idx.close();
  const scope = chatScopeOf(undefined)(who('desktop'));
  assert.equal(idx.page({ limit: 5 }, scope).chats[0]!.title, 'session 4');
  const log: any = { chats: async () => [], fillTitle: () => ({ status: 'deferred' }) };
  const plain = chatListOf(log, { current: () => 1 } as any);
  const answer: any = await plain({ limit: 5, origin: 'native' }, who('desktop'));
  assert.deepEqual(answer.chats, []);
  assert.equal(answer.next, undefined);
  const { title: _t2, ...bare } = session(8);
  const no = createNativeIndex();
  for (const n of [30, 20, 10, 40]) no.upsert(session(n)); // arrive in any order, listed newest first
  assert.deepEqual(
    no.page({ limit: 9 }, scope).chats.map((c: any) => c.updatedAt),
    [400, 300, 200, 100],
  );
  no.upsert({ ...bare, updatedAt: 1 });
  no.remove('claude', UUID(30));
  no.remove('claude', UUID(20));
  no.remove('claude', UUID(10));
  no.remove('claude', UUID(40));
  assert.equal(no.page({ limit: 5 }, scope).chats[0]!.title, 'Session 000000');
});
