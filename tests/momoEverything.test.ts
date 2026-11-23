// What Everything shows (A2, electron/momo/everything.cjs over the history index's `recent`): the newest exchanges of the main chat and of each open channel, each with its channel's name ("Main" for the main chat), filtered by one channel or all, nothing of an archived or deleted channel, long text clipped, and an index that can't be read says so. The index side is checked against the real HistoryIndex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { createEverything, MAIN_NAME, MAX_ROWS, CLIP } = require('../electron/momo/everything.cjs');
const { createChannels, memoryStorage } = require('../electron/momo/channels.cjs');
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-everything-')), 'history');

async function rig() {
  let n = 0;
  const channels = createChannels({ storage: memoryStorage(), newId: () => (++n).toString(16).padStart(16, '0') });
  const trip = await channels.create('Trip');
  const work = await channels.create('Work');
  await channels.linkChat(trip.id, 'chat-trip');
  await channels.linkChat(work.id, 'chat-work');
  const index = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe(), saveMs: 1e9 });
  const chunk = (chatId: string, turnId: string, at: number, user = `u-${turnId}`, assistant = `a-${turnId}`) => ({
    chatId,
    turnId,
    at,
    harness: 'claude',
    kind: 'main',
    user,
    assistant,
  });
  index.add([
    chunk('chat-main', 't1', 100),
    chunk('chat-trip', 't2', 300),
    chunk('chat-work', 't3', 200),
    chunk('coding', 't4', 400),
    chunk('chat-old', 't5', 500),
  ]);
  const state = { main: 'chat-main' as string | null };
  const everything = createEverything({
    recent: (ids: string[], limit: number) => index.recent(ids, limit),
    channels,
    mainChatId: () => state.main,
  });
  return { everything, channels, index, state, trip, work, chunk };
}
const names = (r: any) => r.rows.map((x: any) => `${x.name}:${x.turnId}`);

test('every channel’s rows by time, newest first, each with its channel’s name; coding chats and chats no channel owns never show', async () => {
  const { everything, trip, work } = await rig();
  const all = everything.list();
  assert.deepEqual(names(all), ['Trip:t2', 'Work:t3', `${MAIN_NAME}:t1`]);
  assert.deepEqual(
    all.rows.map((r: any) => r.channelId),
    [trip.id, work.id, null],
  );
  assert.deepEqual(all.rows[0], {
    chatId: 'chat-trip',
    turnId: 't2',
    channelId: trip.id,
    name: 'Trip',
    at: 300,
    user: 'u-t2',
    assistant: 'a-t2',
  });
  assert.deepEqual(all.filters, [
    { id: 'main', name: 'Main' },
    { id: trip.id, name: 'Trip' },
    { id: work.id, name: 'Work' },
  ]);
  assert.equal(all.unavailable, false);
});

test('a filter shows one channel, or Main, and an unknown, archived or deleted one shows nothing', async () => {
  const { everything, channels, trip, work } = await rig();
  assert.deepEqual(names(everything.list(trip.id)), ['Trip:t2']);
  assert.deepEqual(names(everything.list('main')), ['Main:t1']);
  assert.deepEqual(names(everything.list(null)), ['Trip:t2', 'Work:t3', 'Main:t1']);
  assert.deepEqual(names(everything.list('ch_ffffffffffffffff')), []);
  await channels.archive(trip.id);
  assert.deepEqual(names(everything.list(trip.id)), []);
  assert.deepEqual(names(everything.list()), ['Work:t3', 'Main:t1']);
  assert.deepEqual(
    everything.list().filters.map((f: any) => f.id),
    ['main', work.id],
  );
  await channels.remove(work.id);
  assert.deepEqual(names(everything.list()), ['Main:t1']);
});

test('before the main chat exists only the channels show; a channel with no chat yet has no row', async () => {
  const { everything, state, channels } = await rig();
  state.main = null;
  assert.deepEqual(names(everything.list()), ['Trip:t2', 'Work:t3']);
  await channels.create('Fresh');
  assert.deepEqual(names(everything.list()), ['Trip:t2', 'Work:t3']);
  assert.deepEqual(
    everything.list().filters.map((f: any) => f.name),
    ['Main', 'Trip', 'Work', 'Fresh'],
  );
  const none = createEverything({
    recent: () => assert.fail('nothing to read'),
    channels: { list: () => ({ channels: [] }), chatIdOf: () => null },
    mainChatId: () => null,
  });
  assert.deepEqual(none.list(), { rows: [], filters: [{ id: 'main', name: 'Main' }], unavailable: false });
});

test('long text is clipped to a short line, and an unreadable index says so', async () => {
  const { everything, index, chunk } = await rig();
  index.add([chunk('chat-trip', 't6', 600, 'x'.repeat(5000), '  ')]);
  const row = everything.list().rows[0];
  assert.equal(row.turnId, 't6');
  assert.equal(row.user.length, CLIP);
  assert.ok(row.user.endsWith('…'));
  assert.equal(row.assistant, '');
  const down = createEverything({
    recent: () => null,
    channels: { list: () => ({ channels: [] }), chatIdOf: () => null },
    mainChatId: () => 'chat-main',
  });
  assert.deepEqual(down.list(), { rows: [], filters: [{ id: 'main', name: 'Main' }], unavailable: true });
});

test('the index returns the newest chunks of the chats asked for, at most the limit, and none when it can’t be read', async () => {
  const { index, chunk } = await rig();
  assert.deepEqual(
    index.recent(['chat-main', 'chat-work'], 10).map((r: any) => r.turnId),
    ['t3', 't1'],
  );
  assert.deepEqual(
    index.recent(['chat-main', 'chat-work', 'chat-trip'], 2).map((r: any) => r.turnId),
    ['t2', 't3'],
  );
  assert.deepEqual(index.recent([], 10), []);
  assert.equal(MAX_ROWS, 100);
  const broken = new HistoryIndex({
    dir: tmp(),
    safeStorage: fakeSafe(),
    saveMs: 1e9,
    open: () => {
      throw new Error('no sqlite');
    },
  });
  assert.equal(broken.recent(['chat-main'], 5), null);
  void chunk;
});

test('a row of a chat that is not one of the targets is left out', async () => {
  const { channels } = await rig();
  const e = createEverything({
    recent: () => [{ chatId: 'stranger', turnId: 't', at: 1, user: 'u', assistant: 'a' }],
    channels,
    mainChatId: () => 'chat-main',
  });
  assert.deepEqual(e.list().rows, []);
});
