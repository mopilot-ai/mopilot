// A followed chat keeps itself current: a re-read when the live feed cannot be trusted, one at a time with the newest winning, retried with backoff and told to the person only after the last try.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const feedPath = '../mobile/src/presentation/followFeed';
const catchUpPath = '../mobile/src/catchUp';
const { startCatchUp, catchingUp, CATCH_UP_MS } = await import(catchUpPath);
const { RESYNC_MS, RETRY_MS, QUIET_FAILURE, CATCH_UP_FLUSH_MS, FRAME_MS } = await import(feedPath);
import { live, rig, snap } from './support/followFeedRig.ts';

test('the first read is shown; a live event after it updates the rows and never leaves the feed stale', async () => {
  const r = rig([snap({ historyStale: true, liveUnavailable: true })]);
  r.feed.start();
  await r.settle();
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0].thread.historyStale, false, 'a snapshot is the cure for stale');
  assert.equal(r.shown[0].reread, false);
  r.event(live(1));
  assert.equal(r.shown.length, 2);
  assert.equal(r.reads(), 1, 'an event of the live turn costs no read');
  assert.equal(r.timers(), 1, 'only the frame window it opened');
  await r.tick(FRAME_MS);
  assert.equal(r.timers(), 0);
  assert.equal(r.shown.length, 2, 'nothing came in the window, so it shows nothing more');
  // an event that changes nothing (a patch for a rev already seen) shows nothing
  r.event({ ev: 'session.patch', rev: 0, patch: {} });
  assert.equal(r.shown.length, 2);
});

test('an event outside the live turn reads the chat again once, after the wait, keeping what is shown', async () => {
  const r = rig([
    snap(),
    snap({
      rev: 2,
      feedSeq: 5,
      items: [
        { id: 'a', role: 'user', text: 'hi' },
        { id: 'b', role: 'assistant', text: 'new' },
      ],
    }),
  ]);
  r.feed.start();
  await r.settle();
  r.event(live(1, { live: false }));
  r.event(live(2, { live: false }));
  r.event(live(3, { live: false }));
  assert.equal(r.timers(), 2, 'a burst is one read (and the frame window of the first event)');
  await r.tick(RESYNC_MS - 1);
  assert.equal(r.reads(), 1);
  await r.tick(1);
  assert.equal(r.reads(), 2);
  const last = r.shown.at(-1)!;
  assert.equal(last.reread, true);
  assert.equal(last.thread.items.length, 2);
  assert.deepEqual(r.failed, []);
});

test('events that arrive while a read is out are held and replayed on its snapshot, those it already holds dropped', async () => {
  let release!: (v: unknown) => void;
  const reads: any[] = [snap()];
  const r = rig(reads);
  r.feed.start();
  await r.settle();
  // the second read is held open
  const held = new Promise((resolve) => (release = resolve));
  reads.push(held);
  r.event(live(1, { live: false }));
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 2);
  r.event(live(7));
  r.event(live(9));
  const before = r.shown.length;
  release(snap({ feedSeq: 8, items: [{ id: 'a', role: 'user', text: 'hi' }] }));
  await r.settle();
  assert.equal(r.shown.length, before + 1);
  // feedSeq 7 is already in the snapshot; 9 is after it
  const items = r.shown.at(-1)!.thread.items;
  assert.ok(items.some((i: any) => i.id === 'i9'));
  assert.ok(!items.some((i: any) => i.id === 'i7'));
});

test('a reason that comes while a read is out asks for one more after it: the newest wins, they do not pile up', async () => {
  let release!: (v: unknown) => void;
  const reads: any[] = [snap()];
  const r = rig(reads);
  r.feed.start();
  await r.settle();
  reads.push(new Promise((resolve) => (release = resolve)), snap({ feedSeq: 20 }));
  r.event(live(1, { live: false }));
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 2);
  r.event(live(2, { live: false }));
  r.event(live(3, { live: false }));
  assert.equal(r.timers(), 0, 'nothing is scheduled while a read is out');
  assert.equal(r.reads(), 2);
  release(snap({ feedSeq: 1 }));
  await r.settle();
  assert.equal(r.timers(), 1);
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 3);
});

test('too many events while a read is out are dropped and the chat is read again from a newer snapshot', async () => {
  let release!: (v: unknown) => void;
  const r = rig([new Promise((resolve) => (release = resolve)), snap({ feedSeq: 50 })]);
  r.feed.start();
  for (let i = 1; i <= 1001; i++) r.event(live(i));
  assert.deepEqual(r.failed, [], 'no error is shown');
  release(snap());
  await r.settle();
  assert.equal(r.shown.length, 1);
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 2);
  assert.equal(r.shown.at(-1)!.reread, true);
  // the same by size: one event over a megabyte
  const big = rig([new Promise(() => {}), snap()]);
  big.feed.start();
  big.event({ ev: 'items.delta', text: 'x'.repeat(1_000_001) });
  assert.deepEqual(big.failed, []);
});

test('an event this phone cannot read reads the chat again instead of failing it, also from the replay after a read', async () => {
  const r = rig([snap(), snap({ feedSeq: 4 })]);
  r.feed.start();
  await r.settle();
  // no feedSeq: update() throws
  r.event({ ev: 'items.delta', itemId: 'a', field: 'text', text: 'x' });
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 2);
  assert.deepEqual(r.failed, []);

  let release!: (v: unknown) => void;
  const held = rig([new Promise((resolve) => (release = resolve)), snap()]);
  held.feed.start();
  held.event({ ev: 'items.delta', itemId: 'a', field: 'text', text: 'x' });
  release(snap());
  await held.settle();
  assert.equal(held.shown.length, 1, 'the snapshot is shown');
  await held.tick(RESYNC_MS);
  assert.equal(held.reads(), 2);
});

test('a quiet read that fails is tried again after 1, 2 and 4 seconds, then the person is told, and the rows stay', async () => {
  const boom = new Error('offline');
  const r = rig([snap(), boom, boom, boom, boom, snap({ feedSeq: 9 })]);
  r.feed.start();
  await r.settle();
  r.event(live(1, { live: false }));
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 2);
  await r.tick(RETRY_MS[0] - 1);
  assert.equal(r.reads(), 2);
  await r.tick(1);
  assert.equal(r.reads(), 3);
  await r.tick(RETRY_MS[1]);
  assert.equal(r.reads(), 4);
  assert.deepEqual(r.failed, []);
  await r.tick(RETRY_MS[2]);
  assert.equal(r.reads(), 5);
  assert.deepEqual(r.failed, [{ message: QUIET_FAILURE, quiet: true }]);
  // the person's own refresh starts over, and a good read ends the matter
  r.feed.refresh();
  await r.settle();
  assert.equal(r.reads(), 6);
  assert.equal(r.shown.at(-1)!.reread, true);
});

test('a first read that fails says so at once, and a refresh then reads the chat', async () => {
  const r = rig([new Error('No such chat'), snap()]);
  r.feed.start();
  await r.settle();
  assert.deepEqual(r.failed, [{ message: 'No such chat', quiet: false }]);
  assert.equal(r.timers(), 0, 'nothing is retried behind the message');
  r.feed.refresh();
  await r.settle();
  assert.equal(r.shown.length, 1);
  // a failure that is not an Error is shown by its text
  const odd = rig([Promise.reject('plain')]);
  odd.feed.start();
  await odd.settle();
});

test('a refresh while a read is out asks for one more; one while a wait is pending reads now', async () => {
  let release!: (v: unknown) => void;
  const reads: any[] = [snap(), snap()];
  const r = rig(reads);
  r.feed.start();
  await r.settle();
  r.event(live(1, { live: false }));
  assert.equal(r.timers(), 2, 'the wait and the frame window');
  r.feed.refresh();
  await r.settle();
  assert.equal(r.timers(), 0, 'the wait was cancelled');
  assert.equal(r.reads(), 2);
  reads.push(new Promise((resolve) => (release = resolve)), snap());
  r.feed.refresh();
  await r.settle();
  assert.equal(r.reads(), 3);
  r.feed.refresh();
  release(snap());
  await r.settle();
  await r.tick(RESYNC_MS);
  assert.equal(r.reads(), 4);
});

test('a stopped feed shows nothing more, drops a read on the wire and ignores events and refreshes', async () => {
  let release!: (v: unknown) => void;
  const reads: any[] = [snap()];
  const r = rig(reads);
  r.feed.start();
  await r.settle();
  reads.push(new Promise((resolve) => (release = resolve)));
  r.event(live(1, { live: false }));
  await r.tick(RESYNC_MS);
  r.event(live(2, { live: false }));
  r.feed.stop();
  assert.equal(r.unsubscribed(), 1);
  const shown = r.shown.length;
  release(snap({ feedSeq: 30 }));
  await r.settle();
  r.event(live(3));
  r.feed.refresh();
  await r.tick(RETRY_MS[2]);
  assert.equal(r.shown.length, shown);
  assert.equal(r.reads(), 2);
  // stopping with a wait pending clears it; a failed read after a stop says nothing
  const w = rig([snap(), new Error('late')]);
  w.feed.start();
  await w.settle();
  w.event(live(1, { live: false }));
  assert.equal(w.timers(), 2);
  w.feed.stop();
  assert.equal(w.timers(), 0);
  const f = rig([new Error('late')]);
  f.feed.start();
  f.feed.stop();
  await f.settle();
  assert.deepEqual(f.failed, []);
  // start again: it follows from the start
  r.feed.start();
  assert.equal(r.subscribed(), 2);
});

test('a feed that learns the chat from the snapshot holds every event until then and keeps only that chat’s after', async () => {
  let chat: string | null = null;
  const r = rig([snap({ chatId: 'main' }), snap()], { accepts: (e: any) => chat === null || e.chatId === chat });
  r.feed.start();
  r.event({ ...live(1), chatId: 'other' });
  chat = 'main';
  await r.settle();
  assert.equal(r.shown.length, 1, 'the held event of another chat was not replayed');
  r.event({ ...live(1), chatId: 'other' });
  assert.equal(r.shown.length, 1, 'an event of another chat is dropped');
  r.event({ ...live(1), chatId: 'main' });
  assert.equal(r.shown.length, 2);
});

test('while the app catches up the live events of the backlog are applied at once but shown a few times, then it is live again', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    startCatchUp(0);
    const r = rig([snap()]);
    r.feed.start();
    await r.settle();
    r.event(live(1));
    assert.equal(r.shown.length, 2, 'outside the catch-up every event is shown');
    await r.tick(FRAME_MS);
    startCatchUp();
    assert.equal(catchingUp(), true);
    for (let i = 2; i < 8; i++) r.event(live(i));
    assert.equal(r.shown.length, 2, 'the backlog is held for the next flush');
    assert.equal(r.timers(), 1, 'one flush however many events');
    await r.tick(CATCH_UP_FLUSH_MS);
    assert.equal(r.shown.length, 3);
    assert.equal(r.shown.at(-1)!.thread.items.at(-1).id, 'i7', 'what is shown holds every event applied meanwhile');
    assert.equal(r.shown.at(-1)!.reread, false);
    r.event(live(8));
    assert.equal(r.shown.length, 3);
    await r.tick(CATCH_UP_FLUSH_MS);
    assert.equal(r.shown.length, 4);
    clock += CATCH_UP_MS + 1;
    r.event(live(9));
    assert.equal(r.shown.length, 5, 'after the window every event is shown at once');
  } finally {
    Date.now = realNow;
  }
});

test('a live event after the catch-up window ends takes the flush the window left waiting and shows the newest rows once', async () => {
  const realNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;
  try {
    startCatchUp(0);
    const r = rig([snap()]);
    r.feed.start();
    await r.settle();
    startCatchUp();
    r.event(live(1));
    assert.equal(r.timers(), 1, 'the backlog waits for its flush');
    const before = r.shown.length;
    clock += CATCH_UP_MS + 1;
    r.event(live(2));
    assert.equal(r.shown.length, before + 1, 'shown at once, not at the flush');
    assert.equal(r.shown.at(-1)!.thread.items.at(-1).id, 'i2');
    assert.equal(r.timers(), 1, 'only the frame window is left, the flush is gone');
    await r.tick(CATCH_UP_FLUSH_MS);
    assert.equal(r.shown.length, before + 1, 'the cleared flush never shows again');
  } finally {
    Date.now = realNow;
  }
});

test('a read that lands while a flush waits, and stopping, take the flush away', async () => {
  const r = rig([snap(), snap({ rev: 2, items: [{ id: 'z', role: 'user', text: 'full' }] })]);
  r.feed.start();
  await r.settle();
  startCatchUp();
  r.event(live(1));
  assert.equal(r.timers(), 1);
  r.feed.refresh();
  await r.settle();
  assert.equal(r.timers(), 0, 'the fresh snapshot supersedes the held flush');
  assert.equal(r.shown.at(-1)!.thread.items[0].text, 'full');
  r.event(live(2));
  assert.equal(r.timers(), 1);
  r.feed.stop();
  assert.equal(r.timers(), 0, 'stopping drops it');
  startCatchUp(0);
});

test('a live event is shown at once and the ones right after it are shown together when the frame ends, always the newest rows', async () => {
  const r = rig([snap()]);
  r.feed.start();
  await r.settle();
  r.event(live(1));
  assert.equal(r.shown.length, 2, 'the first event is not delayed');
  for (let i = 2; i < 7; i++) r.event(live(i));
  assert.equal(r.shown.length, 2, 'the rest wait for the frame');
  assert.equal(r.timers(), 1);
  await r.tick(FRAME_MS - 1);
  assert.equal(r.shown.length, 2);
  await r.tick(1);
  assert.equal(r.shown.length, 3, 'six events, two renders');
  assert.equal(r.shown.at(-1)!.thread.items.at(-1).id, 'i6', 'what is shown holds every event');
  assert.equal(r.timers(), 1, 'the window stays shut for a frame after a show, so a steady stream is one render a frame');
  r.event(live(7));
  assert.equal(r.shown.length, 3);
  await r.tick(FRAME_MS);
  assert.equal(r.shown.length, 4);
  assert.equal(r.shown.at(-1)!.thread.items.at(-1).id, 'i7');
  await r.tick(FRAME_MS);
  assert.equal(r.timers(), 0, 'a quiet frame ends the window');
  r.event(live(8));
  assert.equal(r.shown.length, 5, 'after a quiet frame the next event is shown at once');
});

test('a snapshot, a re-read or stopping takes the frame window and what waits in it away', async () => {
  const r = rig([snap(), snap({ rev: 2, items: [{ id: 'z', role: 'user', text: 'full' }] })]);
  r.feed.start();
  await r.settle();
  r.event(live(1));
  r.event(live(2));
  r.feed.refresh();
  await r.settle();
  assert.equal(r.timers(), 0, 'the fresh snapshot supersedes the waiting rows');
  assert.equal(r.shown.at(-1)!.thread.items[0].text, 'full');
  const count = r.shown.length;
  await r.tick(FRAME_MS);
  assert.equal(r.shown.length, count, 'the older rows are never shown after it');
  r.event(live(3));
  r.event(live(4));
  r.feed.stop();
  assert.equal(r.timers(), 0, 'stopping drops the window');
  await r.tick(FRAME_MS);
  assert.equal(r.shown.length, count + 1);
});

test('a quiet re-read that comes back with no rows keeps the rows shown and takes the session and revision of the answer', async () => {
  const empty = snap({ rev: 5, feedSeq: 3, session: { turn: 'idle', title: 'later' }, items: [] });
  const r = rig([snap({ items: [{ id: 'a', role: 'user', text: 'hi' }] }), empty, empty]);
  r.feed.start();
  await r.settle();
  r.feed.refresh();
  await r.settle();
  const last = r.shown.at(-1)!.thread;
  assert.equal(last.items.length, 1, 'the row stays');
  assert.equal(last.rev, 5);
  assert.equal(last.session.title, 'later');
  r.feed.stop();
});

test('the first read, and a chat that shows nothing, are shown as they come back, empty or not', async () => {
  const r = rig([snap({ items: [] }), snap({ items: [], rev: 2 }), snap({ rev: 3 })]);
  r.feed.start();
  await r.settle();
  assert.equal(r.shown.at(-1)!.thread.items.length, 0);
  r.feed.refresh();
  await r.settle();
  assert.equal(r.shown.at(-1)!.thread.rev, 2);
  r.feed.refresh();
  await r.settle();
  assert.equal(r.shown.at(-1)!.thread.items.length, 1, 'rows that come back are shown');
  r.feed.stop();
});

test('rows held only as saved history are kept the same way when a quiet re-read comes back empty', async () => {
  const withHistory = snap({ itemsShape: 'items', items: [], history: [{ id: 'h', role: 'user', text: 'saved' }] });
  const r = rig([withHistory, snap({ itemsShape: 'items', items: [], history: [], rev: 4 })]);
  r.feed.start();
  await r.settle();
  r.feed.refresh();
  await r.settle();
  const last = r.shown.at(-1)!.thread;
  assert.equal(last.history.length, 1);
  assert.equal(last.rev, 4);
  r.feed.stop();
});
