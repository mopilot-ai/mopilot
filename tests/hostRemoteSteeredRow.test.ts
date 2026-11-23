// A message the Host took into its running turn (#5141, electron/host/remoteSendProjection.cjs): nothing starts a turn for it, so its row is shown as sent, with no Send (sending it again would send it twice), and leaves the queue when that turn ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UUID, msg, world } from './support/host/remoteSendKit.ts';
import { CHAT, end, start, world as chatsWorld } from './support/host/remoteChatsKit.ts';
import { createRequire } from 'node:module';

const { createSendProjection } = createRequire(import.meta.url)('../electron/host/remoteSendProjection.cjs');

const settle = () => new Promise((r) => setImmediate(r));

test('a steered message stays as a sent row without Send until the turn ends, then leaves the queue once', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.receipt = { action: 'steered', id: UUID(1), turnId: UUID(1) };
  await w.service.send('c1', msg('into the turn', UUID(1)), 1);
  await settle();
  const row = w.queues.get('c1')!.find((q: any) => q.id === UUID(1));
  assert.deepEqual([row.steered, row.waitingFor], [true, undefined]);
  // the Host's stream says the turn ended: the row goes, and a second end changes nothing
  w.service.sent.settleSteered('c1');
  assert.equal(
    w.queues.get('c1')!.some((q: any) => q.id === UUID(1)),
    false,
  );
  assert.doesNotThrow(() => w.service.sent.settleSteered('c1'));
});

test('a message the Host queued behind the turn is not a steered one: it waits for its own turn start', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.receipt = { action: 'queued', id: UUID(1) };
  await w.service.send('c1', msg('after it', UUID(1)), 1);
  await settle();
  w.service.sent.settleSteered('c1');
  const row = w.queues.get('c1')!.find((q: any) => q.id === UUID(1));
  assert.equal(row?.steered, undefined);
  assert.equal(row !== undefined, true, 'the end of the running turn does not retire it');
});

test('a steered reply for a message no longer shown changes nothing', () => {
  let state: any = { queue: [] };
  const projection = createSendProjection({
    outbox: { pending: () => [], ack: () => undefined },
    state: () => ({ get: () => state, patch: (_c: string, next: any) => void (state = { ...state, ...next }) }),
    ownerOf: () => ({ hostId: 'host' }),
    rowOf: () => ({ status: 'online' }),
    connected: () => true,
    signin: new Set(),
    refused: new Map(),
    moved: new Set(),
  });
  projection.steered('chat', 'gone');
  projection.sent.settleSteered('chat');
  assert.deepEqual(state.queue, []);
});

test("the stream's end of a turn tells the send side to retire its steered rows, and a turn's start does not", async () => {
  const settled: string[] = [];
  const w = chatsWorld(undefined, undefined, {
    take: () => undefined,
    seen: () => undefined,
    settleSteered: (id: string) => void settled.push(id),
  });
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  w.host.fire.patch(CHAT, 1, start());
  w.host.fire.patch(CHAT, 2, end());
  await w.chats.settled(CHAT);
  assert.deepEqual(settled, [CHAT]);
});
