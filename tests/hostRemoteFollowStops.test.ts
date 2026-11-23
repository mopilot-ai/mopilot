// A followed machine chat is in step with its Host or says why not, with a retry in place (#5404): a subscribe that failed, a record that could not be written and an item this app cannot read each used to leave the chat running with no end to come, in silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, end, ev, start, text, tick, world } from './support/host/remoteChatsKit.ts';
import { fakeClock } from './support/ports/clock.ts';

const { installClock } = createRequire(import.meta.url)('../electron/platform/ports/clock.cjs');

const settle = async (clock: ReturnType<typeof fakeClock>, ...waits: number[]) => {
  for (const ms of waits) {
    clock.advance(ms);
    for (let i = 0; i < 6; i++) await tick();
  }
};
const running = {
  snapshot: { rev: 2, items: [{ t: 'user', turnId: 't1', text: 'hi' }, start()] },
  patches: null,
  generation: 'g1',
  inflight: [],
};
const finished = {
  snapshot: { rev: 4 },
  patches: [
    { rev: 3, patch: { item: text('done') } },
    { rev: 4, patch: { item: end() } },
  ],
  generation: 'g1',
  inflight: [],
};

test('a subscribe that fails for a reason that is not the machine being away is tried again, and ends the turn with words when it keeps failing', async (t) => {
  const clock = fakeClock();
  t.after(installClock(clock));
  const w = world();
  w.host.reply = running;
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  // the connection returns, and the Host refuses the read once
  let calls = 0;
  w.host.subscribe = async (chatId: string, from?: number, gen?: string) => {
    w.host.asked.push([chatId, from, gen]);
    if (++calls === 1) throw Object.assign(new Error('Too much live history arrived.'), { code: 'invalid' });
    return finished;
  };
  w.host.fire.state('offline');
  w.host.fire.state('online');
  await settle(clock, 0, 1000);
  assert.equal(calls, 2, 'read again');
  assert.equal(w.emitted.at(-1).kind, 'turnEnd');
  assert.deepEqual(w.reported.length, 1, 'the first failure was reported');
  // and one that never answers is told, once
  const w2 = world();
  w2.host.reply = running;
  w2.chats.follow(CHAT);
  await w2.chats.settled(CHAT);
  w2.host.subscribe = async () => {
    throw Object.assign(new Error('no'), { code: 'invalid' });
  };
  w2.host.fire.state('offline');
  w2.host.fire.state('online');
  await settle(clock, 0, 1000, 4000, 15000);
  const ended = w2.emitted.filter((e) => e.kind === 'turnEnd');
  assert.equal(ended.length, 1);
  assert.match(ended[0].error, /Lost contact with this chat/);
});

test('a record that cannot be written does not move the chat past it: the next read starts at the last one applied', async (t) => {
  const clock = fakeClock();
  t.after(installClock(clock));
  const items = new FakeItems();
  const w = world(undefined, items);
  w.host.reply = running;
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const append = items.append.bind(items);
  let failed = false;
  items.append = (id: string, ...records: any[]) => {
    if (!failed && records.some((r) => r.t === 'update')) {
      failed = true;
      throw new Error('disk');
    }
    return append(id, ...records);
  };
  w.host.fire.patch(CHAT, 3, text('done'));
  await tick();
  await tick();
  w.host.reply = finished;
  await settle(clock, 1000);
  const last = w.host.asked.at(-1);
  assert.equal(last[1], 2, 'read again from the last record applied');
  assert.equal(
    items.records.some((r) => r.t === 'update'),
    true,
    'the record is written by the retry',
  );
  assert.equal(w.emitted.at(-1).kind, 'turnEnd');
});

test('an item of a known family this app cannot read shows as one short row, never nothing; one with no turn is reported once', async () => {
  const w = world();
  w.host.reply = {
    snapshot: { rev: 4, items: [{ t: 'user', turnId: 't1', text: 'hi' }, start(), ev({ kind: 'update', turnId: 't1' }), ev({ kind: 7 })] },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const rows = w.emitted.filter((e) => e.kind === 'update');
  assert.equal(rows.length, 1);
  assert.match(rows[0].update.content.text, /can’t be shown by this version of MoPilot/);
  assert.equal(w.reported.length, 1, 'the one with no turn is reported');
});
