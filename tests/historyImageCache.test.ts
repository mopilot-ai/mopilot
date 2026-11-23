// A chat's pictures are found in one read of its history, not one read each (#4820): a phone that reopens a long chat asks for every attached picture and screenshot step, and each ask used to read and parse the whole native transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { peerHistoryReader } = require('../electron/session/peerTranscript.cjs');
const { createHistoryImageCache } = require('../electron/session/historyImageCache.cjs');
const { historyImageItem } = require('../electron/session/historyImageItem.cjs');

const url = (n: number) => `data:image/png;base64,${'A'.repeat(100 + n)}`;
const message = (id: string, pictures: number) => ({
  type: 'userMessage',
  id,
  content: [{ type: 'text', text: 'look' }, ...Array.from({ length: pictures }, (_, i) => ({ type: 'image', url: url(i) }))],
});
const shot = (id: string) => ({
  type: 'mcpToolCall',
  id,
  tool: 'computer_screenshot',
  arguments: {},
  result: { content: [{ type: 'image', mimeType: 'image/png', data: 'B'.repeat(80) }] },
});
const turn = (id: string, ...items: any[]) => ({ id, items });

/** A phone-facing history reader over one chat whose turns the test can change; counts the reads of the native history. */
function rig(initial: any[], cache?: any) {
  const state = { turns: initial, reads: 0, delay: 0, fail: false };
  const record: { segments: { kind: string; nativeId: string; start?: number; count?: number }[] } = {
    segments: [{ kind: 'claude', nativeId: 'n1' }],
  };
  const chats = { records: new Map([['c1', record]]) };
  const read = async () => {
    state.reads++;
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    if (state.fail) throw new Error('unreadable');
    return { turns: state.turns };
  };
  const reader = peerHistoryReader(chats, () => read, cache);
  return { state, record, chats, reader };
}

const TURNS = [
  turn('t1', message('m1', 1), { type: 'agentMessage', id: 'a1', text: 'ok' }),
  turn('t2', message('m2', 2), shot('call1')),
  turn('t3', message('m3', 1)),
];

test('every picture of a chat is found in one read of its history', async () => {
  const { reader, state } = rig(TURNS);
  const found = [
    await reader.userImage('c1', 'm1', 0),
    await reader.userImage('c1', 'm2', 0),
    await reader.userImage('c1', 'm2', 1),
    await reader.userImage('c1', 'm3', 0),
  ];
  assert.deepEqual(
    found.map((f: any) => f.url),
    [url(0), url(0), url(1), url(0)],
  );
  assert.equal(await reader.callImage('c1', 'call1'), `data:image/png;base64,${'B'.repeat(80)}`);
  assert.equal(state.reads, 1, 'one read for four pictures and a screenshot step');
});

test('a message or step that is not there is not found, and does not read the history again at once', async () => {
  const { reader, state } = rig(TURNS);
  assert.equal(await reader.userImage('c1', 'nope', 0), null);
  assert.equal(await reader.userImage('c1', 'nope', 0), null);
  assert.equal(await reader.userImage('c1', 'm1', 5), null, 'a picture the message does not have');
  assert.equal(await reader.callImage('c1', 'm1'), null, 'a message is not a screenshot step');
  assert.equal(state.reads, 1);
});

test('a picture added after the history was read is found by reading it again, once the last read is old enough', async () => {
  let now = 1_000;
  const { reader, state } = rig(TURNS, createHistoryImageCache({ now: () => now, minRefreshMs: 5_000 }));
  await reader.userImage('c1', 'm1', 0);
  state.turns = [...TURNS, turn('t4', message('m4', 1))];
  assert.equal(await reader.userImage('c1', 'm4', 0), null, 'too soon after the last read');
  assert.equal(state.reads, 1);
  now += 5_000;
  assert.deepEqual((await reader.userImage('c1', 'm4', 0))?.url, url(0));
  assert.equal(state.reads, 2);
  // several asks for what is not there, together, read once
  now += 5_000;
  await Promise.all([reader.userImage('c1', 'zz1', 0), reader.userImage('c1', 'zz2', 0), reader.userImage('c1', 'zz3', 0)]);
  assert.equal(state.reads, 3);
});

test("when the chat's segments change the history is read again; a reference scoped to a turn finds only that turn", async () => {
  const { reader, state, record } = rig(TURNS);
  await reader.userImage('c1', 'm1', 0);
  record.segments = [...record.segments, { kind: 'codex', nativeId: 'n2' }];
  await reader.userImage('c1', 'm1', 0);
  assert.equal(state.reads, 3, 'the new segment was read as well, and the first again');
  assert.deepEqual((await reader.userImage('c1', '["claude:n1","t2","m2"]', 1))?.url, url(1));
  assert.equal(await reader.userImage('c1', '["claude:n1","t1","m2"]', 0), null, 'another turn');
  assert.equal(await reader.userImage('c1', '["other","t2","m2"]', 0), null, 'another segment');
  assert.equal(await reader.userImage('c1', '["live","t2","m2"]', 0), null, 'a live message is not saved history');
  assert.equal(state.reads, 3);
});

test('asks that arrive together share one read, and a read that fails is not kept', async () => {
  const { reader, state } = rig(TURNS);
  state.delay = 20;
  const all = await Promise.all(Array.from({ length: 8 }, () => reader.userImage('c1', 'm2', 0)));
  assert.ok(all.every((p: any) => p?.url === url(0)));
  assert.equal(state.reads, 1);
  const other = rig(TURNS);
  other.state.fail = true;
  await assert.rejects(other.reader.userImage('c1', 'm1', 0), /unreadable/);
  other.state.fail = false;
  assert.equal((await other.reader.userImage('c1', 'm1', 0))?.url, url(0));
  assert.equal(other.state.reads, 2);
});

test('what is kept is bounded: the least recently used chat goes first, and so does a chat past the byte limit', async () => {
  const cache = createHistoryImageCache({ maxEntries: 2, maxBytes: 1_000_000 });
  const reads: string[] = [];
  const record = (id: string) => ({ id, segments: [{ kind: 'claude', nativeId: id }] });
  const read = (id: string) => async () => (reads.push(id), { turns: [turn('t', message('m', 1))] });
  const ask = (rec: any) =>
    historyImageItem(
      rec,
      read(rec.id),
      'm',
      (i: any) => i.type === 'userMessage',
      () => undefined,
      cache,
    );
  const [a, b, c] = [record('a'), record('b'), record('c')];
  await ask(a);
  await ask(b);
  await ask(a);
  await ask(c);
  assert.deepEqual(reads, ['a', 'b', 'c'], 'a and b were kept; c took the place of b');
  await ask(a);
  assert.deepEqual(reads, ['a', 'b', 'c'], 'a stayed: it was used last');
  await ask(b);
  assert.deepEqual(reads, ['a', 'b', 'c', 'b'], 'b had gone');
  // a chat whose pictures alone pass the limit does not stay, and does not push the others out
  const small = createHistoryImageCache({ maxEntries: 4, maxBytes: 200 });
  const big = { id: 'big', segments: [{ kind: 'claude', nativeId: 'big' }] };
  const bigRead = async () => (reads.push('big'), { turns: [turn('t', message('m', 3))] });
  await historyImageItem(
    big,
    bigRead,
    'm',
    () => true,
    () => undefined,
    small,
  );
  await historyImageItem(
    big,
    bigRead,
    'm',
    () => true,
    () => undefined,
    small,
  );
  assert.equal(reads.filter((r) => r === 'big').length, 2, 'too large to keep');
});

test('without a cache the history is read for every ask, as before', async () => {
  let reads = 0;
  const read = async () => (reads++, { turns: TURNS });
  const record = { segments: [{ kind: 'claude', nativeId: 'n1' }] };
  await historyImageItem(record, read, 'm1', (i: any) => i.type === 'userMessage');
  await historyImageItem(record, read, 'm2', (i: any) => i.type === 'userMessage');
  assert.equal(reads, 2);
});

test('odd histories are indexed without harm: items with no pictures or no id, null turns, a segment read twice, an unreadable page', async () => {
  const odd = [
    null,
    { id: 't0' },
    turn(
      't1',
      null,
      { type: 'userMessage', id: 'noContent' },
      { type: 'userMessage', id: 'plain', content: [{ type: 'text', text: 'hi' }] },
      { type: 'userMessage', id: 'file', content: [{ type: 'localImage', path: '/tmp/a.png' }] },
      { type: 'userMessage', id: 'bare', content: [{ type: 'image' }] },
      { type: 'userMessage', content: [{ type: 'image', url: url(0) }] },
      {
        type: 'mcpToolCall',
        id: 'noImage',
        tool: 'computer_screenshot',
        arguments: {},
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
      {
        type: 'dynamicToolCall',
        id: 'dyn',
        tool: 'computer_screenshot',
        arguments: {},
        contentItems: [{ type: 'inputImage', imageUrl: url(2) }],
      },
      { type: 'agentMessage', id: 'a' },
    ),
  ];
  const { reader, state, record } = rig(odd as any);
  assert.equal(await reader.userImage('c1', 'noContent', 0), null);
  assert.equal(await reader.userImage('c1', 'plain', 0), null);
  assert.deepEqual(await reader.userImage('c1', 'file', 0), { path: '/tmp/a.png' });
  assert.equal(await reader.userImage('c1', 'bare', 0), null, 'a picture block with no source');
  assert.equal(await reader.callImage('c1', 'noImage'), null);
  assert.equal(await reader.callImage('c1', 'dyn'), url(2));
  assert.equal(state.reads, 1);
  // one native session split into two segments is read once; an unreadable page is an empty history
  record.segments = [
    { kind: 'claude', nativeId: 'n1', start: 0, count: 1 },
    { kind: 'claude', nativeId: 'n1', start: 1, count: 1 },
  ];
  state.reads = 0;
  state.turns = TURNS;
  assert.deepEqual((await reader.userImage('c1', 'm1', 0))?.url, url(0));
  assert.equal(state.reads, 1);
  const unreadable = rig(null as any);
  unreadable.state.turns = undefined as any;
  assert.equal(await unreadable.reader.userImage('c1', 'm1', 0), null);
});

test('when a chat read finishes while a newer one is still pending past the limit, the finished one stays and the pending one gives way', async () => {
  const cache = createHistoryImageCache({ maxEntries: 1 });
  const slow = (ms: number, id: string) => async () => (
    await new Promise((r) => setTimeout(r, ms)), { turns: [turn('t', message(id, 1))] }
  );
  const first = { id: 'first', segments: [{ kind: 'claude', nativeId: 'first' }] };
  const second = { id: 'second', segments: [{ kind: 'claude', nativeId: 'second' }] };
  const ask = (rec: any, id: string, read: any) =>
    historyImageItem(
      rec,
      read,
      id,
      () => true,
      () => undefined,
      cache,
    );
  const [a, b] = await Promise.all([ask(first, 'f', slow(10, 'f')), ask(second, 's', slow(60, 's'))]);
  assert.ok(a, 'the one that finished first is answered');
  assert.ok(b, 'and so is the one that gave way: its own read is still its answer');
  let reads = 0;
  const counted = async () => (reads++, { turns: [turn('t', message('f', 1))] });
  await ask(first, 'f', counted);
  assert.equal(reads, 0, 'the first stayed kept: no read');
});
