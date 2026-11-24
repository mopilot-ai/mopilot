// What goes wrong around the Mac's chat index (electron/host/chatIndex.cjs): a retry that outlives its machine's being online, a list that never ends or a call that never answers, a connection that drops or a key that changed, a flood of events, and a Host that sends what it should not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';
import { event, row, world } from './support/host/chatIndexWorld.ts';

const HELLO = { protocol: { minor: 1, floor: 1 }, features: ['chatList', 'chatPaging', 'chatEvents'], capabilities: {}, moved: [] };
const require = createRequire(import.meta.url);
const {
  createChatIndex,
  rowOf,
  CALL_MS,
  COALESCE_MS,
  BUFFER_MAX,
  RETRY_MS,
  NOTICES_PER_WINDOW,
  NOTICE_WINDOW_MS,
} = require('../electron/host/chatIndex.cjs');

test('a retry that waits when its machine goes offline, or is turned off, never dials; a machine that never loaded and goes offline is stale, not loading', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({ failOpen: true });
  w.index.sync();
  await w.until('failed');
  w.machine.online = false;
  w.index.sync();
  assert.equal(w.state(), 'stale');
  clock.advance(10 * 60_000);
  assert.equal(w.opened.length, 1, 'the pending retry was cancelled with the machine');
  // the timer itself is checked too: a machine that went offline between the wait and the dial
  const v = world({ failOpen: true });
  v.index.sync();
  await v.until('failed');
  v.machine.off = true; // no sync heard of it
  clock.advance(RETRY_MS[0]);
  assert.equal(v.opened.length, 1, 'the retry read the registry again before it dialled');
  assert.equal(v.state(), 'stale');
  // never loaded: the first connection is still opening
  const hold = world({ pages: [[row(1)]] });
  const release = hold.hold();
  hold.index.sync();
  assert.equal(hold.state(), 'loading');
  hold.machine.online = false;
  hold.index.sync();
  assert.equal(hold.state(), 'stale');
  release();
});

test('a list that never ends, one that repeats a cursor and a call that never answers all fail the machine', async (t) => {
  const clock = useFakeClock(t, 0);
  const endless = world({
    pageSize: 200,
    call: (m, p) => (m === 'host.chats' ? { chats: [], next: `x${p.cursor ?? ''}1`, at: 0, generation: 'g1' } : undefined),
  });
  endless.index.sync();
  await endless.until('failed');
  assert.equal(endless.calls.length < 100, true, `it gave up after ${endless.calls.length} calls`);
  const loop = world({ call: (m) => (m === 'host.chats' ? { chats: [row(1)], next: 'same', at: 0, generation: 'g1' } : undefined) });
  loop.index.sync();
  await loop.until('failed');
  assert.equal(loop.calls.filter((c) => c.startsWith('host.chats:')).length, 2, 'the repeated cursor ended it');
  const hung = world({ call: (m) => (m === 'host.chats' ? new Promise(() => undefined) : undefined) });
  hung.index.sync();
  await waitFor(() => hung.calls.includes('host.chats:'), 'the list request');
  clock.advance(CALL_MS);
  await hung.until('failed');
  assert.equal(hung.sessions[0].closed, 1, 'its connection was let go');
});

test('a connection that ends under a machine the registry still calls online fails it and dials again; a machine paired again is followed with its new key', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]] });
  w.index.sync();
  await w.until('ready');
  w.push({ event: 'connection.closed', reason: 'The machine closed the connection.' });
  assert.equal(w.state(), 'failed');
  clock.advance(RETRY_MS[0]);
  await waitFor(() => w.opened.length === 2 && w.state() === 'ready', 'a new connection');
  w.machine.pin = 'k2'; // paired again: the old connection belongs to the old key
  w.index.sync();
  await waitFor(() => w.opened.length === 3, 'a connection with the new key');
  assert.deepEqual(w.opened, ['m:k1', 'm:k1', 'm:k2']);
  assert.equal(w.sessions[1].closed, 1);
  w.index.sync();
  assert.equal(w.opened.length, 3, 'the same key is not dialled again');
});

test('a burst of events reaches the windows once, after a short wait; more events than the buffer holds read the list again', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]], at: 0 });
  w.index.sync();
  await w.until('ready');
  clock.advance(COALESCE_MS);
  const before = w.changes.length;
  for (let i = 0; i < 50; i++) w.push(event(i + 1, row(1, { rev: i + 2, title: `t${i}` })));
  assert.equal(w.changes.length, before, 'nothing yet');
  clock.advance(COALESCE_MS);
  assert.equal(w.changes.length, before + 1, 'one change for fifty events');
  const full = world({ pages: [[row(1)]] });
  const release = full.hold();
  full.index.sync();
  await waitFor(() => full.calls.includes('host.chats.watch'), 'the watch');
  for (let i = 0; i <= BUFFER_MAX; i++) full.push(event(i + 1, row(2, { rev: i + 1 })));
  assert.equal(full.state(), 'loading', 'the buffer would not hold them: the list is read again');
  release();
  assert.equal(full.sessions[0].closed >= 1, true);
});

test('generations: an event before the watch answered is buffered without a spurious relist; a Host with no generation, or one that changes between pages, is not trusted', async (t) => {
  const clock = useFakeClock(t, 0);
  const early = world({ pages: [[row(1)]], at: 0 });
  early.index.sync();
  await waitFor(() => early.sessions.length === 1, 'the connection');
  early.push(event(1, row(1, { rev: 2, title: 'early' })), 0);
  await early.until('ready');
  assert.equal(early.opened.length, 1, 'no second connection');
  assert.equal(early.index.snapshot()[0].rows[0].title, 'early');
  const none = world({ call: (m) => (m === 'host.chats.watch' ? { watching: true, at: 0 } : undefined) });
  none.index.sync();
  await none.until('failed');
  const changing = world({
    pages: [[row(1)], [row(2)]],
    call: (m, p) => (m === 'host.chats' && p.cursor ? { chats: [row(2)], at: 0, generation: 'other' } : undefined),
  });
  changing.index.sync();
  await waitFor(() => changing.calls.includes('host.chats:p1'), 'the second page');
  assert.equal(changing.state(), 'loading');
  clock.advance(RETRY_MS[0]);
  await waitFor(() => changing.opened.length === 2, 'it read the list again');
  // the Host restarted between two lists: the events of its new run are a new list too
  const restarted = world({ pages: [[row(1)]] });
  restarted.index.sync();
  await restarted.until('ready');
  restarted.push(event(1, row(1, { rev: 3 }), 'changed', { generation: 'g9' }));
  assert.equal(restarted.state(), 'loading');
});

test('what a Host sends is checked: a missing, fractional or textual count, an id that is long or odd, a state that is unknown, numbers that are not whole and a text cut through a surrogate pair', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]], at: 0 });
  w.index.sync();
  await w.until('ready');
  const bad = [
    { ...event(2, row(1, { rev: 2, title: 'no seq' })), seq: undefined },
    event(2.5 as any, row(1, { rev: 3, title: 'fraction' })),
    event('5' as any, row(1, { rev: 4, title: 'text' })),
    event(2, row(0, { chatId: 'x'.repeat(300) })),
    event(3, row(1, { chatId: '__proto__' })),
    event(4, row(1, { chatId: 'a b' })),
  ];
  for (const ev of bad) w.push(ev);
  assert.deepEqual(w.rows(), ['c1']);
  assert.equal(w.index.snapshot()[0].rows[0].title, 'chat 1');
  const r = rowOf({
    chatId: 'c9',
    title: `${'a'.repeat(159)}😀`,
    state: 'weird',
    updatedAt: -3,
    createdAt: 1.5,
    epoch: '7',
    rev: Number.MAX_SAFE_INTEGER + 2,
  });
  assert.equal(r.title, 'a'.repeat(159), 'half a pair is dropped');
  assert.deepEqual([r.state, r.updatedAt, r.createdAt, r.epoch, r.rev], ['idle', 0, 0, 0, 0]);
  assert.equal(rowOf({ chatId: 'c9', title: 'ok😀' }).title, 'ok😀');
  assert.equal(rowOf({ chatId: 'c1' }).chatId, 'c1');
  for (const junk of [null, 'x', { chatId: 5 }, { chatId: '' }, { chatId: 'constructor' }]) assert.equal(rowOf(junk), null);
});

test('a notifier or a change listener that throws is reported, never thrown into the connection', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({
    pages: [[row(1)]],
    at: 0,
    notify: () => {
      throw new Error('notify broke');
    },
    onChange: () => {
      throw new Error('change broke');
    },
  });
  w.index.sync();
  await w.until('ready');
  w.push(event(1, row(1, { rev: 2 }), 'turnEnded'));
  clock.advance(COALESCE_MS);
  assert.deepEqual(w.reported.map((e: any) => e.message).sort(), ['change broke', 'notify broke']);
  assert.equal(w.state(), 'ready');
});

test('a remove for a chat on a later page, heard while paging, leaves it out; disposing closes every connection', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1)], [row(2)]], at: 0 });
  const release = w.hold();
  w.index.sync();
  await waitFor(() => w.calls.includes('host.chats.watch'), 'the watch');
  w.push({ event: 'chats', op: 'remove', kind: 'removed', seq: 1, generation: 'g1', chatId: 'c2' });
  release();
  await w.until('ready');
  assert.deepEqual(w.rows(), ['c1']);
  const stuck = world({ pages: [[row(1)]] });
  stuck.index.sync();
  await stuck.until('ready');
  stuck.index.dispose();
  assert.equal(stuck.sessions[0].closed, 1);
});

test('rows that tie on time are told apart by id, whether the list is cut at the cap or an event pushes one out', async (t) => {
  useFakeClock(t, 0);
  const w = world({
    pages: [[row(1, { updatedAt: 5, startedBy: 'Du' }), row(2, { updatedAt: 5 })], [row(3, { updatedAt: 5 })]],
    maxRows: 2,
  });
  w.index.sync();
  await w.until('ready');
  assert.deepEqual(w.rows(), ['c1', 'c2'], 'the tie goes by id when the list is cut');
  assert.equal(w.index.snapshot()[0].rows[0].startedBy, 'Du');
  w.push(event(1, row(0, { updatedAt: 5 }), 'created'));
  assert.deepEqual(w.rows(), ['c0', 'c1'], 'and when an event pushes the last one out');
  w.push({ event: 'chats', op: 'sideways', seq: 2, generation: 'g1', chatId: 'c1' });
  assert.deepEqual(w.rows(), ['c0', 'c1']);
  // the last page carries the list past the cap, all on one time: the ids decide which stay
  const over = world({
    pages: [
      [row(1, { updatedAt: 5 }), row(2, { updatedAt: 5 })],
      [row(3, { updatedAt: 5 }), row(4, { updatedAt: 5 })],
    ],
    maxRows: 3,
  });
  over.index.sync();
  await over.until('ready');
  assert.deepEqual(over.rows(), ['c1', 'c2', 'c3']);
  assert.equal(over.index.snapshot()[0].truncated, true);
});

test('whatever ends the run first wins: a watch answered after the machine left, and a failure that arrives after it, change nothing', async (t) => {
  useFakeClock(t, 0);
  let answer!: (v: unknown) => void;
  let fail!: (e: unknown) => void;
  const late = world({ call: (m) => (m === 'host.chats.watch' ? new Promise((r) => (answer = r)) : undefined) });
  late.index.sync();
  await waitFor(() => late.calls.includes('host.chats.watch'), 'the watch');
  late.machine.present = false;
  late.index.sync();
  answer({ watching: true, generation: 'g1' });
  assert.deepEqual(late.index.snapshot(), []);
  // a hello answered after the machine left
  let greet!: (v: unknown) => void;
  const greeted = world({ call: (m) => (m === 'host.hello' ? new Promise((r) => (greet = r)) : undefined) });
  greeted.index.sync();
  await waitFor(() => greeted.calls.includes('host.hello'), 'the hello');
  greeted.machine.present = false;
  greeted.index.sync();
  greet(HELLO);
  await waitFor(() => greeted.sessions[0].closed === 1, 'its connection closed');
  assert.deepEqual(greeted.calls, ['host.hello'], 'nothing else was asked');
  const failing = world({ call: (m) => (m === 'host.chats.watch' ? new Promise((_, r) => (fail = r)) : undefined) });
  failing.index.sync();
  await waitFor(() => failing.calls.includes('host.chats.watch'), 'the watch');
  failing.machine.present = false;
  failing.index.sync();
  fail(new Error('too late'));
  await waitFor(() => failing.sessions[0].closed === 1, 'its connection closed');
  assert.deepEqual(failing.reported, [], 'a failure of a run that ended is not news');
});

test('a resync heard while paging is not applied: the list is read again; a page without chats is an empty page; after dispose a sync does nothing', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]] });
  const release = w.hold();
  w.index.sync();
  await waitFor(() => w.calls.includes('host.chats.watch'), 'the watch');
  w.push({ event: 'chats', op: 'resync', seq: 1, generation: 'g1' });
  release();
  await waitFor(() => w.state() === 'loading' && w.sessions[0].closed >= 1, 'a list to read again');
  clock.advance(RETRY_MS[0]);
  await w.until('ready');
  const empty = world({ call: (m) => (m === 'host.chats' ? { at: 0, generation: 'g1' } : undefined) });
  empty.index.sync();
  await empty.until('ready');
  assert.deepEqual(empty.rows(), []);
  empty.index.dispose();
  empty.index.sync();
  assert.deepEqual(empty.index.snapshot(), []);
});

test('the index works with no listeners of its own: a connection that will not close, a change and a notification all pass quietly', async (t) => {
  const clock = useFakeClock(t, 0);
  let online = true;
  let push: (e: any) => void = () => undefined;
  let opens = 0;
  const idx = createChatIndex({
    machines: () => [{ id: 'm', online, record: {} }],
    open: async (_: any, onEvent: any) => {
      opens++;
      push = onEvent;
      return {
        close: () => {
          throw new Error('stuck');
        },
        call: async (m: string) =>
          m === 'host.hello'
            ? HELLO
            : m === 'host.chats'
              ? { chats: [row(1)], at: 0, generation: 'g' }
              : { watching: true, generation: 'g' },
      };
    },
  });
  idx.sync();
  idx.sync();
  await waitFor(() => idx.snapshot()[0]?.state === 'ready', 'ready');
  idx.sync();
  assert.equal(opens, 1, 'a machine without a pin is followed once');
  push({ event: 'chats', op: 'upsert', kind: 'turnEnded', seq: 1, generation: 'g', chatId: 'c1', chat: row(1, { rev: 2 }) });
  clock.advance(COALESCE_MS);
  online = false;
  idx.sync();
  assert.equal(idx.snapshot()[0].state, 'stale');
});

test('a Host cannot make banners: fresh ids, a state that does not match the kind, and a flood are not news; a listed chat that really waits is', async (t) => {
  const clock = useFakeClock(t, 0);
  const listed = Array.from({ length: 10 }, (_, i) => row(i + 1));
  const w = world({ pages: [listed.slice(0, 5), listed.slice(5)], at: 0, pageSize: 5 });
  w.index.sync();
  await w.until('ready');
  let seq = 0;
  // chats it never listed, said to need a person
  for (let i = 0; i < 20; i++) w.push(event(++seq, row(100 + i, { state: 'attention', rev: 2 }), 'attention'));
  // listed chats whose row does not say what the kind says
  w.push(event(++seq, row(1, { state: 'idle', rev: 2 }), 'attention'));
  w.push(event(++seq, row(2, { state: 'running', rev: 2 }), 'turnEnded'));
  assert.deepEqual(w.notified, [], 'none of those is a banner');
  // a flood of true events is cut to a few a minute
  for (let i = 1; i <= 10; i++) w.push(event(++seq, row(i, { state: 'attention', rev: 3 }), 'attention'));
  assert.equal(w.notified.length, NOTICES_PER_WINDOW);
  clock.advance(NOTICE_WINDOW_MS);
  w.push(event(++seq, row(1, { state: 'idle', rev: 4 }), 'turnEnded'));
  assert.equal(w.notified.length, NOTICES_PER_WINDOW + 1, 'a minute later it may tell again');
});
