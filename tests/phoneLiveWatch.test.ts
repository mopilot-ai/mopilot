// The phone's net under a followed chat's live events: a running turn that goes quiet is read again with a backoff, once on returning to the front, and the re-reads that brought rows are counted.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { snap, grown, live, rig, counts, since } from './support/liveWatchRig';

const require = createRequire(import.meta.url);
const lifecycle: { listeners: ((away: number) => void)[]; removed: number } = { listeners: [], removed: 0 };
mock.module(require.resolve('../mobile/src/platform/lifecycle.ts'), {
  namedExports: {
    isActive: () => true,
    onForeground: (fn: (away: number) => void) => {
      lifecycle.listeners.push(fn);
      return () => void lifecycle.removed++;
    },
  },
});
const { createLiveWatch, onLiveNetCounts, QUIET_MS, BACKOFF_MS } = await import('../mobile/src/presentation/liveWatch');
// a computed path: the device file imports react-native, whose types must not enter the tests' type check
const device = '../mobile/src/presentation/liveWatchDevice';
const { deviceWatch, watchFor } = await import(device);

test('a running chat whose live events never arrive shows the new rows after the net re-reads it, and counts them as missed', async () => {
  const before = counts();
  const r = rig([snap(), grown(2)]);
  r.feed.start();
  await r.settle();
  assert.equal(r.shown.length, 1);
  await r.tick(QUIET_MS - 1);
  assert.equal(r.reads(), 1, 'quiet for less than the wait: no re-read');
  await r.tick(1);
  assert.equal(r.reads(), 2);
  assert.equal(r.shown.at(-1).thread.items.length, 3, 'the Mac held rows the live feed never sent');
  assert.deepEqual(since(before), { missed: 1, quiet: 0 });
  r.feed.stop();
});

test('live events that keep arriving keep the net quiet', async () => {
  const before = counts();
  const r = rig([snap(), snap({ feedSeq: 6 })]);
  r.feed.start();
  await r.settle();
  for (let i = 1; i <= 6; i++) {
    await r.tick(3000);
    r.event(live(i));
  }
  assert.equal(r.reads(), 1, 'an event every 3 s: never 4 s of quiet');
  await r.tick(3999);
  assert.equal(r.reads(), 1);
  await r.tick(1);
  assert.equal(r.reads(), 2, 'the first quiet 4 s after the last event');
  assert.deepEqual(since(before), { missed: 0, quiet: 1 }, 'nothing new: counted apart');
  r.feed.stop();
});

test('while the chat stays quiet the re-reads back off 4, 8, 16, 30, 30 s, and an event starts over', async () => {
  const before = counts();
  const r = rig([...Array(6).fill(snap()), snap({ feedSeq: 1 })]);
  r.feed.start();
  await r.settle();
  assert.deepEqual(BACKOFF_MS, [4000, 8000, 16000, 30000]);
  let reads = 1;
  for (const wait of [4000, 8000, 16000, 30000, 30000]) {
    await r.tick(wait - 1);
    assert.equal(r.reads(), reads, `not before ${wait}`);
    await r.tick(1);
    assert.equal(r.reads(), ++reads, `at ${wait}`);
  }
  assert.deepEqual(since(before), { missed: 0, quiet: 5 });
  // an event while the wait is long: the next re-read is 4 s after it, not 30 s
  await r.tick(10_000);
  r.event(live(1));
  await r.tick(3999);
  assert.equal(r.reads(), reads);
  await r.tick(1);
  assert.equal(r.reads(), ++reads);
  // and the wait after that is 8 s again
  await r.tick(7999);
  assert.equal(r.reads(), reads);
  await r.tick(1);
  assert.equal(r.reads(), ++reads);
  r.feed.stop();
});

test('a re-read that brought rows starts the backoff over at 4 s', async () => {
  const r = rig([snap(), snap(), grown(1), grown(1), grown(1)]);
  r.feed.start();
  await r.settle();
  await r.tick(4000); // nothing new
  await r.tick(8000); // rows
  assert.equal(r.shown.at(-1).thread.items.length, 2);
  await r.tick(3999);
  assert.equal(r.reads(), 3);
  await r.tick(1);
  assert.equal(r.reads(), 4, 'the next wait is 4 s, not 16');
  r.feed.stop();
});

test('stop() ends the net: no timers, the foreground signal let go, an answer on the wire is dropped and not counted', async () => {
  const before = counts();
  let release!: (v: unknown) => void;
  const late = new Promise((resolve) => (release = resolve));
  const r = rig([snap(), late]);
  r.feed.start();
  await r.settle();
  await r.tick(4000);
  assert.equal(r.reads(), 2, 'the re-read is out');
  r.feed.stop();
  assert.equal(r.timers(), 0);
  assert.equal(r.offCount(), 1);
  release(grown(3));
  await r.settle();
  assert.equal(r.shown.length, 1, 'the late answer is not shown');
  assert.deepEqual(since(before), { missed: 0, quiet: 0 });
  r.foreground();
  assert.equal(r.reads(), 2, 'a foreground signal after stop reads nothing');
});

test('returning to the front re-reads once, even when no turn is running, and counts what it found', async () => {
  const before = counts();
  let release!: (v: unknown) => void;
  const out = new Promise((resolve) => (release = resolve));
  const r = rig([snap({ session: { turn: 'idle' } }), out]);
  r.feed.start();
  await r.settle();
  r.foreground();
  r.foreground(); // one at a time
  assert.equal(r.reads(), 2);
  release(grown(1, { session: { turn: 'idle' } }));
  await r.settle();
  assert.equal(r.shown.at(-1).thread.items.length, 2);
  assert.deepEqual(since(before), { missed: 1, quiet: 0 });
  assert.equal(r.timers(), 1, 'and the heartbeat is on');
  r.feed.stop();
});

test("a re-read that fails is not counted, and the next answer is not taken for the net's", async () => {
  const before = counts();
  const r = rig([snap(), new Error('offline'), grown(1)]);
  r.feed.start();
  await r.settle();
  await r.tick(4000); // the net's re-read fails
  assert.equal(r.reads(), 2);
  await r.tick(1000); // the feed's own retry brings the rows
  assert.equal(r.reads(), 3);
  assert.equal(r.shown.at(-1).thread.items.length, 2);
  assert.deepEqual(since(before), { missed: 0, quiet: 0 });
  r.feed.stop();
});

test('rows that came by live events while a re-read was out are not credited to the net', async () => {
  const before = counts();
  let release!: (v: unknown) => void;
  const out = new Promise((resolve) => (release = resolve));
  const r = rig([snap(), out]);
  r.feed.start();
  await r.settle();
  await r.tick(4000);
  r.event(live(1)); // held while the read is out, replayed on its snapshot
  release(snap());
  await r.settle();
  assert.equal(r.shown.at(-1).thread.feedSeq, 1);
  assert.deepEqual(since(before), { missed: 0, quiet: 0 });
  r.feed.stop();
});

test("the counts are told to a listener that can let go, and the clock and the foreground default to the device's", async () => {
  let told = 0;
  const off = onLiveNetCounts(() => told++);
  const r = rig([snap(), snap()], { watch: {} }); // the default clock: real time barely moves, so the timer only waits again
  r.feed.start();
  await r.settle();
  await r.tick(QUIET_MS);
  assert.equal(r.reads(), 1);
  r.feed.stop();
  const w = createLiveWatch({
    running: () => true,
    signature: () => 's',
    size: () => 0,
    reread: () => true,
    timers: { set: () => 1, clear: () => {} },
    options: {},
  });
  w.start();
  w.shown(); // no re-read on the wire: nothing counted
  w.stop();
  w.event(); // after stop everything is ignored
  w.shown();
  off();
  assert.equal(told, 0);
  const r2 = rig([snap(), snap()]);
  r2.feed.start();
  await r2.settle();
  await r2.tick(4000);
  assert.equal(told, 0, 'the removed listener is not told');
  r2.feed.stop();
  // the device's signal is the app's foreground, passed without its argument
  const seen: number[] = [];
  const stop = deviceWatch.foreground!(() => void seen.push(1));
  lifecycle.listeners.at(-1)!(5000);
  assert.deepEqual(seen, [1]);
  stop();
  assert.equal(lifecycle.removed, 1);
});

test('a listener is told of each counted re-read', async () => {
  let told = 0;
  const off = onLiveNetCounts(() => told++);
  const r = rig([snap(), grown(1)]);
  r.feed.start();
  await r.settle();
  await r.tick(4000);
  assert.equal(told, 1);
  off();
  r.feed.stop();
});

test('the net never keeps a process alive: its timer is let go of when the timer has an unref', () => {
  let unrefs = 0;
  const watch = createLiveWatch({
    running: () => true,
    signature: () => '',
    size: () => 0,
    reread: () => true,
    timers: { set: () => ({ unref: () => void unrefs++ }), clear: () => {} },
    options: {},
  });
  watch.start();
  watch.shown();
  assert.equal(unrefs, 1);
  watch.stop();
});

test('the relay connection coming back re-reads the open chat once, whatever the app was doing; staying online or going offline reads nothing', async () => {
  const before = counts();
  let phase = 'online';
  let tell: () => void = () => {};
  let stopped = 0;
  const runtime = {
    snapshot: () => ({ phase }),
    subscribe: (fn: () => void) => {
      tell = fn;
      return () => void stopped++;
    },
  };
  const w = watchFor(runtime, 'c');
  assert.equal(w.visible, deviceWatch.visible);
  let reads = 0;
  const stop = w.foreground!(() => void reads++);
  tell(); // still online
  phase = 'offline';
  tell(); // gone
  assert.equal(reads, 0);
  phase = 'online';
  tell(); // back
  assert.equal(reads, 1);
  tell();
  assert.equal(reads, 1, 'online again is not a change');
  lifecycle.listeners.at(-1)!(0); // the app's own foreground goes through as well
  assert.equal(reads, 2);
  const removed = lifecycle.removed;
  stop();
  assert.equal(stopped, 1);
  assert.equal(lifecycle.removed, removed + 1);
  assert.deepEqual(since(before), { missed: 0, quiet: 0 });
  // a runtime that starts offline reads when it first comes online
  phase = 'offline';
  const w2 = watchFor(runtime, 'c');
  let reads2 = 0;
  w2.foreground!(() => void reads2++);
  phase = 'online';
  tell();
  assert.equal(reads2, 1);
});

test('a runtime that cannot say its connection changed is watched by the device’s signals alone', () => {
  const w = watchFor({}, 'c');
  let reads = 0;
  const stop = w.foreground!(() => void reads++);
  lifecycle.listeners.at(-1)!(0);
  assert.equal(reads, 1);
  stop();
});

/** The record's rows and a reply still streaming (one live item): what a chat whose turn is pending answers with. */
const pending = (rows: number) =>
  snap({
    itemsShape: 'items',
    history: Array.from({ length: rows }, (_, i) => ({ id: `h${i}`, role: i % 2 ? 'assistant' : 'user', text: `row ${i}` })),
    items: [{ id: 'live-1', type: 'agentMessage', text: 'waiting for you' }],
  });

test('a re-read that returns the same record and the same live row brings nothing new: the net backs off 4, 8, 16, 30 s (#5686)', async () => {
  const before = counts();
  const r = rig([...Array(7).fill(pending(30))]);
  r.feed.start();
  await r.settle();
  let reads = 1;
  for (const wait of [4000, 8000, 16000, 30000]) {
    await r.tick(wait - 1);
    assert.equal(r.reads(), reads, `not before ${wait}`);
    await r.tick(1);
    assert.equal(r.reads(), ++reads, `at ${wait}`);
  }
  assert.deepEqual(since(before), { missed: 0, quiet: 4 }, 'every one of them found nothing');
  r.feed.stop();
});

test('a re-read that holds one more row than the last is rows the live events missed, and starts the net over at 4 s: so a read that asks for one more row each time never lets it back off', async () => {
  const before = counts();
  const r = rig([pending(30), pending(31), pending(32), pending(33), pending(34)]);
  r.feed.start();
  await r.settle();
  for (let again = 0; again < 4; again++) {
    await r.tick(QUIET_MS);
    assert.equal(r.reads(), again + 2, `read ${again + 2} came 4 s after the last: the net did not back off`);
  }
  assert.deepEqual(since(before), { missed: 4, quiet: 0 });
  r.feed.stop();
});
