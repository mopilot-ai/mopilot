// The Mac's index of every machine's chats (electron/host/chatIndex.cjs, docs/host.md "Chat index, paging and events"): watch first and buffer, page to the end, apply only the events after the first page's baseline; notifications only from those; a stale or removed row never comes back; an offline or turned-off machine is never dialled; a machine with 20,000 chats holds a bounded number of rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';
import { event, row, world } from './support/host/chatIndexWorld.ts';

const require = createRequire(import.meta.url);
const { createChatIndex, MAX_ROWS, RETRY_MS, STABLE_MS } = require('../electron/host/chatIndex.cjs');
const HELLO = { protocol: { minor: 1, floor: 1 }, features: ['chatList', 'chatPaging', 'chatEvents'], capabilities: {}, moved: [] };

test('watch comes first, then the pages to the end; rows are newest activity first', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1), row(3)], [row(2)]] });
  w.index.sync();
  await w.until('ready');
  assert.deepEqual(
    w.calls,
    ['host.hello', 'host.chats.watch', 'host.chats:', 'host.chats:p1'],
    'hello first: a Host serves the versioned methods only after it',
  );
  assert.deepEqual(w.rows(), ['c3', 'c2', 'c1']);
});

test('events during the pages are buffered: those at or before the baseline and older revisions never apply or notify; a turn that ended after it does', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1, { rev: 5, title: 'newer' })]], at: 3 });
  const release = w.hold();
  w.index.sync();
  await waitFor(() => w.sessions.length === 1 && w.calls.includes('host.chats.watch'), 'the watch');
  w.push(event(2, row(1, { title: 'before baseline' }), 'turnEnded'));
  w.push(event(4, row(2, { rev: 2 }), 'created'));
  w.push(event(5, row(1, { rev: 4, title: 'older revision' }), 'changed'));
  w.push(event(6, row(1, { rev: 6, title: 'done' }), 'turnEnded'));
  release();
  await w.until('ready');
  assert.deepEqual(
    w.index
      .snapshot()[0]
      .rows.map((r: any) => [r.chatId, r.title])
      .sort(),
    [
      ['c1', 'done'],
      ['c2', 'chat 2'],
    ],
  );
  assert.deepEqual(w.notified, [['m', 'turnEnded', 'c1']], 'only the event after the baseline is news; the replay is not');
});

test('after the baseline a turn that ends or a card that waits notifies once; other changes and removals do not', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]], at: 1 });
  w.index.sync();
  await w.until('ready');
  w.push(event(2, row(1, { rev: 2, state: 'running' }), 'changed'));
  w.push(event(3, row(1, { rev: 3, state: 'idle' }), 'turnEnded'));
  w.push(event(4, row(1, { rev: 4, state: 'attention' }), 'attention'));
  assert.deepEqual(w.notified, [
    ['m', 'turnEnded', 'c1'],
    ['m', 'attention', 'c1'],
  ]);
  assert.equal(w.index.snapshot()[0].rows[0].state, 'attention');
  w.push({ event: 'chats', op: 'remove', kind: 'removed', seq: 5, generation: 'g1', chatId: 'c1' });
  assert.deepEqual(w.rows(), []);
  w.push({ event: 'other', op: 'upsert' });
  w.push(event(6, { nope: true }));
  assert.equal(w.notified.length, 2);
});

test('a resync or a new generation lists again, and a row the Host no longer shows (its scope changed) is gone', async (t) => {
  const clock = useFakeClock(t, 0);
  const pages = [[row(1), row(2)]];
  const w = world({ pages });
  w.index.sync();
  await w.until('ready');
  pages[0] = [row(1)]; // the Host's scope changed: its next list leaves c2 out
  w.push({ event: 'chats', op: 'resync', seq: 1, generation: 'g1' });
  assert.equal(w.state(), 'loading', 'a resync is not a partial list');
  clock.advance(RETRY_MS[0]);
  await waitFor(() => w.opened.length === 2 && w.state() === 'ready', 'the second list');
  assert.deepEqual(w.rows(), ['c1']);
  w.push(event(1, row(1), 'changed', { generation: 'g2' })); // the Host restarted
  clock.advance(RETRY_MS[1]);
  await waitFor(() => w.opened.length === 3, 'a third connection, after the longer wait');
});

test('a Host that keeps asking for a new list gets longer waits; a list that held for a minute starts them again', async (t) => {
  const clock = useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]] });
  w.index.sync();
  await w.until('ready');
  w.push({ event: 'chats', op: 'resync', seq: 1, generation: 'g1' });
  clock.advance(RETRY_MS[0]);
  await waitFor(() => w.opened.length === 2 && w.state() === 'ready', 'the second list');
  w.push({ event: 'chats', op: 'resync', seq: 1, generation: 'g1' });
  clock.advance(RETRY_MS[0]);
  assert.equal(w.opened.length, 2, 'the second wait is longer than the first');
  clock.advance(RETRY_MS[1] - RETRY_MS[0]);
  await waitFor(() => w.opened.length === 3 && w.state() === 'ready', 'the third list');
  clock.advance(STABLE_MS);
  w.push({ event: 'chats', op: 'resync', seq: 1, generation: 'g1' });
  clock.advance(RETRY_MS[0]);
  await waitFor(() => w.opened.length === 4, 'the first wait again');
});

test('an incomplete list is partial and tried again; a failed connection is failed and tried again with the waits growing', async (t) => {
  const clock = useFakeClock(t, 0);
  const partial = world({ pages: [[row(1)]], incomplete: true });
  partial.index.sync();
  await partial.until('partial');
  clock.advance(RETRY_MS[0]);
  await waitFor(() => partial.opened.length === 2, 'the list again');
  const failing = world({ failOpen: true });
  failing.index.sync();
  await failing.until('failed');
  clock.advance(RETRY_MS[0]);
  await waitFor(() => failing.opened.length === 2, 'the second try');
  await failing.until('failed');
  clock.advance(RETRY_MS[1] - 1);
  assert.equal(failing.opened.length, 2, 'the second wait is longer');
  clock.advance(1);
  await waitFor(() => failing.opened.length === 3, 'the third try');
});

test('an offline machine and one turned off are never dialled; one that goes offline closes and keeps its rows as stale', async (t) => {
  useFakeClock(t, 0);
  for (const o of [{ online: false }, { off: true }]) {
    const w = world(o);
    w.index.sync();
    assert.deepEqual(w.opened, []);
    assert.deepEqual(w.index.snapshot(), []);
  }
  const w = world({ pages: [[row(1)]] });
  w.index.sync();
  await w.until('ready');
  w.machine.online = false;
  w.index.sync();
  assert.equal(w.state(), 'stale');
  assert.deepEqual(w.rows(), ['c1']);
  assert.equal(w.sessions[0].closed, 1);
});

test('a machine removed or revoked while paging closes its connection and nothing late is applied', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1)], [row(2)]] });
  const release = w.hold();
  w.index.sync();
  await waitFor(() => w.calls.includes('host.chats.watch'), 'the watch');
  w.machine.present = false;
  w.index.sync();
  release();
  await waitFor(() => w.sessions[0].closed >= 1, 'the connection closed');
  assert.deepEqual(w.index.snapshot(), []);
  w.push(event(1, row(9)));
  assert.deepEqual(w.index.snapshot(), []);
});

test('a machine with 20,000 chats holds only the newest rows, with the title and folder cut, and an event for a chat that is no longer held still says it holds only some', async (t) => {
  useFakeClock(t, 0);
  const many = Array.from({ length: 2400 }, (_, i) => row(i + 1, { title: 'x'.repeat(500), folder: '/f'.repeat(500) }));
  const pages = Array.from({ length: Math.ceil(many.length / 600) }, (_, i) => many.slice(i * 600, i * 600 + 600));
  const w = world({ pages, pageSize: 600 });
  w.index.sync();
  await w.until('ready').catch(() => w.until('partial'));
  const [m] = w.index.snapshot();
  assert.equal(m.rows.length <= MAX_ROWS, true);
  assert.equal(m.truncated, true);
  assert.equal(m.rows[0].title.length, 160);
  assert.equal(m.rows[0].folder.length, 400);
  w.index.dispose();
  assert.deepEqual(w.index.snapshot(), []);
});

test('a full machine lets go of the single oldest row for a newer one; an event for a chat that is not held is not a banner', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(10), row(11)], [row(12)]], maxRows: 3 });
  w.index.sync();
  await w.until('ready');
  w.push(event(1, row(13, { updatedAt: 99 }), 'created'));
  assert.deepEqual(w.rows(), ['c13', 'c12', 'c11']);
  assert.equal(w.index.snapshot()[0].truncated, true);
  w.push(event(2, row(1, { updatedAt: 1, state: 'attention' }), 'attention'));
  assert.deepEqual(w.rows(), ['c13', 'c12', 'c11'], 'older than every row held: not kept');
  assert.deepEqual(w.notified, [], 'a chat this Mac does not list is not news');
});

test('a Host without the list says feature_missing: the machine is unsupported and left alone until it has been away and is back', async (t) => {
  useFakeClock(t, 0);
  let asked = 0;
  const idx = createChatIndex({
    machines: () => [{ id: 'm', online, record: {} }],
    open: async () => ({
      close: () => undefined,
      call: async () => {
        asked++;
        throw Object.assign(new Error('old'), { code: 'feature_missing' });
      },
    }),
  });
  let online = true;
  idx.sync();
  await waitFor(() => idx.snapshot()[0]?.state === 'unsupported', 'unsupported');
  idx.sync();
  assert.equal(asked, 1, 'not asked again');
  online = false;
  idx.sync();
  online = true;
  idx.sync();
  await waitFor(() => asked === 2, 'asked again after it was away');
});

test('the registry’s machines decide who is followed: Host access closed follows nobody, an online machine is followed with its record', async (t) => {
  useFakeClock(t, 0);
  const { createMachineChatIndex } = require('../electron/host/chatIndexWiring.cjs');
  const opened: string[] = [];
  let open = true;
  const idx = createMachineChatIndex({
    registry: {
      list: () => [
        { id: 'a', status: 'online', hostKey: 'abc' },
        { id: 'b', status: 'offline' },
      ],
    },
    openPaired: async (record: any) => {
      opened.push(record.id);
      return {
        close: () => undefined,
        call: async (m: string) =>
          m === 'host.hello' ? HELLO : m === 'host.chats' ? { chats: [], at: 0, generation: 'g' } : { watching: true, generation: 'g' },
      };
    },
    allowed: () => open,
    onChange: () => undefined,
  });
  idx.sync();
  await waitFor(() => idx.snapshot()[0]?.state === 'ready', 'ready');
  assert.deepEqual(opened, ['a'], 'the offline machine is not dialled');
  open = false;
  idx.sync();
  assert.deepEqual(idx.snapshot(), [], 'without access nothing is kept');
  const plain = createMachineChatIndex({
    registry: { list: () => [] },
    onChange: () => undefined,
    openPaired: async () => ({ close: () => undefined, call: async () => ({}) }),
  });
  plain.sync();
  assert.deepEqual(plain.snapshot(), []);
  // the registry's own change callback is told to the index first, then goes on to its own work
  const told: string[] = [];
  const wrapped = plain.wrap((...a: string[]) => told.push(a.join()));
  wrapped('x', 'y');
  assert.deepEqual(told, ['x,y']);
  // a connection that fails is noted, not thrown
  const failing = createMachineChatIndex({
    registry: { list: () => [{ id: 'a', status: 'online' }] },
    onChange: () => undefined,
    openPaired: async () => {
      throw new Error('no route');
    },
  });
  failing.sync();
  await waitFor(() => failing.snapshot()[0]?.state === 'failed', 'failed');
  failing.dispose();
});

test('a Host that does not list chats, or does not page them, is asked only what it offers', async (t) => {
  useFakeClock(t, 0);
  const old = world({ features: ['chatEvents'] });
  old.index.sync();
  await old.until('unsupported');
  assert.deepEqual(old.calls, ['host.hello'], 'nothing else is asked of a Host without the chat list');
  const unpaged = world({ features: ['chatList', 'chatEvents'], pages: [[row(1), row(2)], [row(3)]] });
  unpaged.index.sync();
  await unpaged.until('ready');
  assert.equal(unpaged.index.snapshot()[0].truncated, true, 'the machine says it holds only some');
  assert.deepEqual(
    unpaged.calls,
    ['host.hello', 'host.chats.watch', 'host.chats:'],
    'no cursor to a Host that does not page; a full page may have more behind it',
  );
  assert.deepEqual(unpaged.rows(), ['c2', 'c1']);
});

test('a Host that refuses the versioned methods before hello is never asked them first', async (t) => {
  useFakeClock(t, 0);
  const w = world({ pages: [[row(1)]] });
  w.index.sync();
  await w.until('ready');
  assert.equal(w.calls[0], 'host.hello');
  assert.deepEqual(w.reported, [], 'no refusal came back');
});

test('a machines service made without anyone to tell dials nothing for the chat list', async () => {
  const { createMachineChatIndex } = require('../electron/host/chatIndexWiring.cjs');
  const opened: string[] = [];
  const idx = createMachineChatIndex({
    registry: { list: () => [{ id: 'a', status: 'online' }] },
    openPaired: async (record: any) => (opened.push(record.id), { close: () => undefined, call: async () => ({}) }),
  });
  idx.sync();
  assert.deepEqual(opened, []);
  assert.deepEqual(idx.snapshot(), []);
});
