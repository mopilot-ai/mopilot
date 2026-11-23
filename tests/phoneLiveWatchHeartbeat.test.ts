// The net's idle heartbeat: after a turn ends, in the background, after a send, and for a chat idle a long time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snap, grown, live, front, rig, counts, since } from './support/liveWatchRig';
import { END_MS, EXPECT_MS, IDLE_MS, createLiveWatch, expectReply } from '../mobile/src/presentation/liveWatch';
import { startCatchUp } from '../mobile/src/catchUp';

test('a turn seen to end is read once more at 1.5 s, then the idle heartbeat takes over: 8, 12, 20, 20, 20 s', async () => {
  assert.deepEqual(IDLE_MS, [8000, 12000, 20000]);
  assert.deepEqual(EXPECT_MS, [3000, 6000, 10000]);
  assert.equal(END_MS, 1500);
  const r = rig([snap(), grown(1, { session: { turn: 'idle' } }), ...Array(8).fill(grown(1, { session: { turn: 'idle' } }))]);
  r.feed.start();
  await r.settle();
  await r.tick(4000);
  assert.equal(r.reads(), 2, 'the quiet read found the turn over');
  await r.tick(END_MS - 1);
  assert.equal(r.reads(), 2);
  await r.tick(1);
  assert.equal(r.reads(), 3, 'one more read for the rows that closed the turn');
  let reads = 3;
  for (const wait of [8000, 12000, 20000, 20000, 20000]) {
    await r.tick(wait - 1);
    assert.equal(r.reads(), reads, `not before ${wait}`);
    await r.tick(1);
    assert.equal(r.reads(), ++reads, `at ${wait}`);
  }
  assert.equal(r.timers(), 1, 'the heartbeat runs while the chat is open');
  r.feed.stop();
  assert.equal(r.timers(), 0);
});

test('a chat opened idle is on the heartbeat from the start, and a live event moves it back', async () => {
  const idle = (over: object = {}) => snap({ session: { turn: 'idle' }, ...over });
  const r = rig([idle(), idle(), idle()]);
  r.feed.start();
  await r.settle();
  await r.tick(7999);
  assert.equal(r.reads(), 1);
  await r.tick(1);
  assert.equal(r.reads(), 2);
  await r.tick(10_000);
  r.event(live(1));
  await r.tick(7999);
  assert.equal(r.reads(), 2, 'the live feed works: the next look is 8 s after the event');
  await r.tick(1);
  assert.equal(r.reads(), 3);
  r.feed.stop();
});

test('a short turn from the Mac whose live events all dropped shows up on the heartbeat, once, with no rows twice', async () => {
  const before = counts();
  // the Mac's revision does not move: only the rows do, and they are what tells the phone it was behind
  const idle = (n: number) => grown(n, { rev: 1, feedSeq: 0, session: { turn: 'idle' } });
  const r = rig([idle(0), idle(2), idle(2)]);
  r.feed.start();
  await r.settle();
  assert.equal(r.shown.at(-1).thread.items.length, 1);
  await r.tick(8000);
  const rows = r.shown.at(-1).thread.items;
  assert.equal(rows.length, 3, 'the message and the answer the live feed never sent');
  assert.equal(new Set(rows.map((x: any) => x.id)).size, rows.length, 'no row twice');
  assert.deepEqual(since(before), { missed: 1, quiet: 0 });
  await r.tick(8000);
  assert.equal(r.shown.at(-1).thread.items.length, 3, 'a later read of the same chat changes nothing');
  r.feed.stop();
});

test('the heartbeat reads nothing while the app is in the background, and goes on at the next step when it is back', async () => {
  const r = rig([snap({ session: { turn: 'idle' } })]);
  r.feed.start();
  await r.settle();
  front.on = false;
  await r.tick(8000);
  assert.equal(r.reads(), 1, 'hidden: the due look reads nothing');
  front.on = true;
  await r.tick(11_999);
  assert.equal(r.reads(), 1);
  await r.tick(1);
  assert.equal(r.reads(), 2);
  r.feed.stop();
});

test('a turn that ends through a live event while the screen is catching up is read once at the end wait', async () => {
  const r = rig([snap(), snap({ session: { turn: 'idle' } })]);
  r.feed.start();
  await r.settle();
  startCatchUp(60_000); // live events are applied to the feed at once but shown later, with no read of the feed's own
  r.event({ ev: 'session.patch', rev: 2, patch: { turn: 'idle' } });
  await r.tick(4000);
  assert.equal(r.reads(), 2);
  startCatchUp(0);
  r.feed.stop();
});

test('a chat idle for ten minutes with every live event dropped shows what the Mac posts within 20 s, once', async () => {
  const before = counts();
  let mac = 0; // rows the Mac holds beyond the first
  const idle = () => grown(mac, { rev: 1, feedSeq: 0, session: { turn: 'idle' } });
  const r = rig(idle);
  r.feed.start();
  await r.settle();
  for (let i = 0; i < 600; i++) await r.tick(1000);
  assert.equal(r.shown.at(-1).thread.items.length, 1, 'ten quiet minutes: nothing to show');
  assert.ok(r.reads() > 20, 'the heartbeat kept looking');
  mac = 2; // the Mac posts a message and its answer; no live event reaches the phone
  let seconds = 0;
  while (r.shown.at(-1).thread.items.length === 1 && seconds < 40) {
    await r.tick(1000);
    seconds++;
  }
  assert.ok(seconds <= 20, `shown after ${seconds} s`);
  const rows = r.shown.at(-1).thread.items;
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((x: any) => x.id)).size, 3, 'no row twice');
  assert.equal(since(before).missed, 1);
  r.feed.stop();
});

test('a message sent from this phone is looked for at 3, 6 and 10 s, then at the heartbeat; a live event ends the quick looks', async () => {
  const idle = (n: number) => grown(n, { rev: 1, feedSeq: 0, session: { turn: 'idle' } });
  const r = rig([idle(0), idle(0), idle(0), idle(0), idle(0), idle(0), idle(0)]);
  r.feed.start();
  await r.settle();
  await r.tick(2000); // 2 s into the first idle wait (8 s)
  expectReply('c');
  await r.tick(2999);
  assert.equal(r.reads(), 1);
  await r.tick(1);
  assert.equal(r.reads(), 2, 'at 3 s');
  await r.tick(6000);
  assert.equal(r.reads(), 3, 'at 6 s after that');
  await r.tick(10_000);
  assert.equal(r.reads(), 4, 'at 10 s after that');
  await r.tick(7999);
  assert.equal(r.reads(), 4);
  await r.tick(1);
  assert.equal(r.reads(), 5, 'then the heartbeat starts again at 8 s');
  expectReply('c');
  r.event(live(1)); // the reply came by the live feed: no quick looks
  await r.tick(3000);
  assert.equal(r.reads(), 5);
  r.feed.stop();
  expectReply('c'); // after stop nothing is armed
  assert.equal(r.timers(), 0);
});

test('returning to the front looks again at 3 s as well as reading at once', async () => {
  const idle = { session: { turn: 'idle' } };
  const r = rig([snap(idle), snap(idle), snap(idle)]);
  r.feed.start();
  await r.settle();
  r.foreground();
  await r.settle();
  assert.equal(r.reads(), 2);
  await r.tick(2999);
  assert.equal(r.reads(), 2);
  await r.tick(1);
  assert.equal(r.reads(), 3);
  r.feed.stop();
});

test('a read that was already out is nobody’s credit, and nothing is asked before the first rows are shown', async () => {
  const before = counts();
  let release!: (v: unknown) => void;
  const first = new Promise((resolve) => (release = resolve));
  const r = rig([first, snap({ session: { turn: 'idle' } })]);
  r.feed.start();
  await r.tick(20_000);
  assert.equal(r.reads(), 1, 'the first read is still out: the net asks for nothing');
  release(snap({ session: { turn: 'idle' } }));
  await r.settle();
  // the person's own Refresh is out; the net's ask meets it and is answered by it
  let out!: (v: unknown) => void;
  const refreshing = new Promise((resolve) => (out = resolve));
  const again = rig([snap({ session: { turn: 'idle' } }), refreshing, grown(1, { session: { turn: 'idle' } })]);
  again.feed.start();
  await again.settle();
  again.feed.refresh();
  await again.settle();
  again.foreground();
  out(grown(1, { session: { turn: 'idle' } }));
  await again.settle();
  assert.equal(since(before).missed, 0, 'rows the Refresh brought are not the net’s');
  r.feed.stop();
  again.feed.stop();
});

test('a link that fails reads is asked 2, 4, then 8 times as slowly, and a read that gets through starts over', () => {
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const asks: number[] = [];
  let fails = true;
  const watch: ReturnType<typeof createLiveWatch> = createLiveWatch({
    running: () => false,
    signature: () => 's',
    size: () => 0,
    reread: () => {
      asks.push(now);
      if (fails) watch.failed(); // the read fails at once
      return true;
    },
    timers: { set: (fn: () => void, ms: number) => (timers.push({ at: now + ms, fn }), timers.length), clear: () => {} },
    options: { now: () => now },
  });
  const run = (to: number) => {
    while (timers.length && timers[0]!.at <= to) {
      const t = timers.shift()!;
      now = t.at;
      t.fn();
    }
  };
  watch.start();
  watch.shown();
  run(112_000);
  assert.deepEqual(asks, [8000, 32_000, 112_000], 'waits of 8 s, then 12 s twice as long, then 20 s four times as long');
  fails = false;
  run(272_000); // the wait set before the failure was told was 20 s eight times as long
  watch.shown(); // this read got through
  run(432_000);
  watch.shown();
  run(432_000 + 20_000);
  assert.deepEqual(
    asks.slice(3),
    [272_000, 432_000, 452_000],
    'the one wait set before the answer is still slow; then the heartbeat’s own 20 s',
  );
  watch.stop();
});

test('a message sent in one chat boosts that chat’s watch and no other', async () => {
  const a = rig([snap({ session: { turn: 'idle' } }), snap({ session: { turn: 'idle' } })]);
  a.feed.start();
  await a.settle();
  expectReply('another chat');
  await a.tick(3000);
  assert.equal(a.reads(), 1, 'not boosted');
  a.feed.stop();
});

test('starting a watch again lets go of the first foreground signal', () => {
  let let_go = 0;
  const watch = createLiveWatch({
    running: () => false,
    signature: () => 's',
    size: () => 0,
    reread: () => true,
    timers: { set: () => 1, clear: () => {} },
    options: { foreground: () => () => void let_go++ },
  });
  watch.start();
  watch.start();
  assert.equal(let_go, 1);
  watch.stop();
  assert.equal(let_go, 2);
});

test('coming to the front before the first rows are shown asks for nothing, and the first read still answers', async () => {
  let release!: (v: unknown) => void;
  const first = new Promise((resolve) => (release = resolve));
  const r = rig([first]);
  r.feed.start();
  r.foreground(); // the app returns while the chat is still being read for the first time
  await r.settle();
  assert.equal(r.reads(), 1, 'no second read is started');
  release(snap({ session: { turn: 'idle' } }));
  await r.settle();
  assert.equal(r.shown.length, 1);
  r.feed.stop();
});
