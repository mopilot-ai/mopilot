// A chat's stream the Host ended or the connection cut off for a reason other than a storage fault (#5404): the chat is read again from where it stands, and told to the person when it cannot be, never left running with no end to come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, end, start, text, tick, world } from './support/host/remoteChatsKit.ts';
import { fakeClock } from './support/ports/clock.ts';

const { installClock } = createRequire(import.meta.url)('../electron/platform/ports/clock.cjs');

const open = async (t: any) => {
  const clock = fakeClock();
  const restore = installClock(clock);
  t.after(restore);
  const w = world();
  w.host.reply = {
    snapshot: { rev: 2, items: [{ t: 'user', turnId: 't1', text: 'hi' }, start()] },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  return { w, clock };
};

test('a stream the Host ended is read again from the last rev, and the turn it missed ends', async (t) => {
  const { w, clock } = await open(t);
  w.host.reply = {
    snapshot: { rev: 4 },
    patches: [
      { rev: 3, patch: { item: text('done') } },
      { rev: 4, patch: { item: end() } },
    ],
    generation: 'g1',
    inflight: [],
  };
  w.host.fire.closed(CHAT, 'too_large');
  clock.advance(1000);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(w.host.asked.at(-1), [CHAT, 2, 'g1']);
  assert.equal(w.emitted.at(-1).kind, 'turnEnd');
});

test('a stream that cannot be read again after three tries ends the running turn with words, once', async (t) => {
  const { w, clock } = await open(t);
  w.host.subscribe = async () => {
    throw Object.assign(new Error('refused'), { code: 'invalid' });
  };
  w.host.fire.closed(CHAT, 'too_large');
  for (const ms of [1000, 4000, 15000]) {
    clock.advance(ms);
    for (let i = 0; i < 5; i++) await tick();
  }
  const ended = w.emitted.filter((e) => e.kind === 'turnEnd');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].stopReason, 'error');
  assert.match(ended[0].error, /Lost contact with this chat/);
});

test('a close while the machine is away waits for its return instead of counting tries; a close of a chat no longer followed does nothing', async (t) => {
  const { w, clock } = await open(t);
  w.host.st = 'offline';
  w.host.fire.closed(CHAT, 'too_large');
  w.host.fire.closed('acp:kimi:other', 'too_large');
  for (const ms of [1000, 4000, 15000, 15000]) {
    clock.advance(ms);
    for (let i = 0; i < 3; i++) await tick();
  }
  assert.equal(w.emitted.filter((e) => e.kind === 'turnEnd').length, 0);
  assert.equal(w.host.asked.length, 1);
});
