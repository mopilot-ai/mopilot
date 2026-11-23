// The pane's frames of a tab on a Host (electron/capabilities/browser/remoteFrames.cjs, package 2.6): screenshot polling at about one a second during a takeover, slower while only watching, none while hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createFramePoller, TAKEOVER_MS, WATCH_MS, FETCH_MS } = require('../electron/capabilities/browser/remoteFrames.cjs');

/** Timers the test advances by hand, in order of time. */
function clock() {
  let now = 0;
  const live = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  return {
    setTimer: ((fn: () => void, ms: number) => {
      const id = ++n;
      live.set(id, { at: now + ms, fn });
      return { id, unref() {} };
    }) as any,
    clearTimer: ((t: any) => void live.delete(t?.id)) as any,
    count: () => live.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...live].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        live.delete(next[0]);
        next[1].fn();
        await tick();
      }
      now = end;
    },
  };
}

function world(fetchImpl?: (c: string, k: string | null) => Promise<any>, options: { activeMs?: number } = {}) {
  const c = clock();
  const calls: any[] = [];
  const frames: any[] = [];
  const errors: any[] = [];
  const poller = createFramePoller({
    fetch: (chat: string, key: string | null) => (
      calls.push([chat, key]),
      fetchImpl ? fetchImpl(chat, key) : Promise.resolve({ data: Buffer.from(`f${calls.length}`), mime: 'image/jpeg' })
    ),
    ...c,
    ...options,
  });
  const watch = poller.watch({
    chatId: 'c',
    tabKey: 'tab_1',
    onFrame: (f: any) => frames.push(f.data.toString()),
    onError: (e: any) => errors.push(String(e.message ?? e)),
  });
  return { c, calls, frames, errors, watch };
}

test('nothing is fetched while the pane is hidden; showing it takes a frame at once, then one every few seconds while only watching', async () => {
  const w = world();
  await w.c.advance(10_000);
  assert.equal(w.calls.length, 0);
  w.watch.setVisible(true);
  await tick();
  assert.deepEqual(w.calls, [['c', 'tab_1']]);
  assert.deepEqual(w.frames, ['f1']);
  await w.c.advance(WATCH_MS - 1);
  assert.equal(w.calls.length, 1);
  await w.c.advance(1);
  assert.equal(w.calls.length, 2);
  // showing it again changes nothing
  w.watch.setVisible(true);
  assert.equal(w.calls.length, 2);
  assert.ok(TAKEOVER_MS < WATCH_MS);
});

test('during a takeover the frames come about once a second; handing back slows them again', async () => {
  const w = world();
  w.watch.setVisible(true);
  await tick();
  w.watch.setTakeover(true);
  w.watch.setTakeover(true);
  await w.c.advance(TAKEOVER_MS);
  assert.equal(w.calls.length, 2);
  await w.c.advance(TAKEOVER_MS);
  assert.equal(w.calls.length, 3);
  w.watch.setTakeover(false);
  await w.c.advance(TAKEOVER_MS);
  assert.equal(w.calls.length, 3);
  await w.c.advance(WATCH_MS);
  assert.equal(w.calls.length, 4);
  // a takeover begun while hidden waits for the pane
  const h = world();
  h.watch.setTakeover(true);
  await h.c.advance(5000);
  assert.equal(h.calls.length, 0);
});

test('A1/A2: one fetch at a time; hiding drops a frame still on its way and stops the polling (A3)', async () => {
  const pending = deferred<any>();
  const w = world(() => pending.promise);
  w.watch.setVisible(true);
  await tick();
  w.watch.setTakeover(true);
  await w.c.advance(5000);
  assert.equal(w.calls.length, 1);
  w.watch.setVisible(false);
  pending.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  assert.deepEqual(w.frames, []);
  await w.c.advance(60_000);
  assert.equal(w.calls.length, 1);
  assert.equal(w.c.count(), 0);
  // shown again: polling resumes
  w.watch.setVisible(true);
  await tick();
  assert.equal(w.calls.length, 2);
});

test('B5: a fetch that never answers is given up on, the error is reported and the polling goes on; its late frame is not shown', async () => {
  let n = 0;
  const first = deferred<any>();
  const w = world(() => (n++ === 0 ? first.promise : Promise.resolve({ data: Buffer.from('ok'), mime: 'image/jpeg' })));
  w.watch.setVisible(true);
  await tick();
  await w.c.advance(FETCH_MS);
  assert.deepEqual(w.errors, ['The page did not answer.']);
  first.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  assert.deepEqual(w.frames, []);
  await w.c.advance(WATCH_MS);
  assert.deepEqual(w.frames, ['ok']);
  // a timeout with nobody listening for errors
  const quiet = createFramePoller({ fetch: () => new Promise(() => undefined), ...clock() });
  const q = quiet.watch({ chatId: 'c', tabKey: null, onFrame: () => undefined });
  q.setVisible(true);
});

test("a failing fetch is reported and tried again at the slow rate; a failure after the pane hid is nobody's", async () => {
  let fail = true;
  const w = world(() =>
    fail ? Promise.reject(new Error('tab_closed')) : Promise.resolve({ data: Buffer.from('back'), mime: 'image/jpeg' }),
  );
  w.watch.setVisible(true);
  await tick();
  assert.deepEqual(w.errors, ['tab_closed']);
  fail = false;
  await w.c.advance(WATCH_MS);
  assert.deepEqual(w.frames, ['back']);
  const late = deferred<any>();
  const h = world(() => late.promise);
  h.watch.setVisible(true);
  await tick();
  h.watch.setVisible(false);
  late.reject(new Error('gone'));
  await tick();
  assert.deepEqual(h.errors, []);
  // a failure with no error listener is dropped; a synchronous throw is a failure too
  const noisy = createFramePoller({ fetch: () => Promise.reject(new Error('x')), ...clock() });
  noisy.watch({ chatId: 'c', tabKey: null, onFrame: () => undefined }).setVisible(true);
  const sync = world(() => {
    throw new Error('sync');
  });
  sync.watch.setVisible(true);
  await tick();
  assert.deepEqual(sync.errors, ['sync']);
});

test('hiding and showing the pane while a fetch is out waits for that fetch instead of starting another', async () => {
  const pending = deferred<any>();
  const w = world(() => pending.promise);
  w.watch.setVisible(true);
  await tick();
  w.watch.setVisible(false);
  w.watch.setVisible(true);
  assert.equal(w.calls.length, 1);
  pending.resolve({ data: Buffer.from('one'), mime: 'image/jpeg' });
  await tick();
  assert.deepEqual(w.frames, ['one']);
});

test('a fetch that failed after it was given up on is not reported again', async () => {
  const late = deferred<any>();
  let n = 0;
  const w = world(() => (n++ === 0 ? late.promise : Promise.resolve({ data: Buffer.from('ok'), mime: 'image/jpeg' })));
  w.watch.setVisible(true);
  await tick();
  await w.c.advance(FETCH_MS);
  late.reject(new Error('very late'));
  await tick();
  assert.deepEqual(w.errors, ['The page did not answer.']);
});

test('A3: a stopped watch fetches nothing and shows nothing more, however it is poked', async () => {
  const pending = deferred<any>();
  const w = world(() => pending.promise);
  w.watch.setVisible(true);
  await tick();
  w.watch.stop();
  w.watch.setVisible(false);
  w.watch.setVisible(true);
  w.watch.setTakeover(true);
  pending.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  assert.deepEqual(w.frames, []);
  await w.c.advance(60_000);
  assert.equal(w.calls.length, 1);
  assert.equal(w.c.count(), 0);
});

test('B5: no new capture is started while the last one is still outstanding on a hung page', async () => {
  const stuck = deferred<any>();
  let n = 0;
  const w = world(() => (n++ === 0 ? stuck.promise : Promise.resolve({ data: Buffer.from('ok'), mime: 'image/jpeg' })));
  w.watch.setVisible(true);
  await tick();
  await w.c.advance(FETCH_MS);
  await w.c.advance(WATCH_MS * 3);
  assert.equal(w.calls.length, 1);
  stuck.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  await w.c.advance(WATCH_MS);
  assert.deepEqual(w.frames, ['ok']);
});

test('action refresh preempts idle polling, runs at its bounded active cadence and returns to idle', async () => {
  const w = world(undefined, { activeMs: 250 });
  w.watch.setVisible(true);
  await tick();
  w.watch.setActive(true);
  w.watch.refresh();
  w.watch.refresh();
  await w.c.advance(0);
  assert.equal(w.calls.length, 2);
  await w.c.advance(249);
  assert.equal(w.calls.length, 2);
  await w.c.advance(1);
  assert.equal(w.calls.length, 3);
  w.watch.setActive(false);
  w.watch.refresh();
  await w.c.advance(0);
  assert.equal(w.calls.length, 4, 'a settled action gets its own next capture');
  await w.c.advance(WATCH_MS - 1);
  assert.equal(w.calls.length, 4);
  await w.c.advance(1);
  assert.equal(w.calls.length, 5);
  w.watch.setVisible(false);
  w.watch.refresh();
  w.watch.setActive(true);
  await w.c.advance(5000);
  assert.equal(w.calls.length, 5);
  w.watch.setVisible(true);
  await tick();
  assert.equal(w.calls.length, 6);
  w.watch.stop();
  w.watch.refresh();
  w.watch.setActive(false);
  await w.c.advance(5000);
  assert.equal(w.calls.length, 6);
});

test('an action finishing during an unresolved capture coalesces one post-action refresh', async () => {
  const pending = deferred<any>();
  let first = true;
  const w = world(
    async () => {
      if (first) {
        first = false;
        return pending.promise;
      }
      return { data: Buffer.from('next'), mime: 'image/jpeg' };
    },
    { activeMs: 250 },
  );
  w.watch.setVisible(true);
  await tick();
  w.watch.setActive(true);
  w.watch.setTakeover(true);
  w.watch.setActive(false);
  w.watch.refresh();
  w.watch.refresh();
  await w.c.advance(1000);
  assert.equal(w.calls.length, 1);
  pending.resolve({ data: Buffer.from('initial'), mime: 'image/jpeg' });
  await tick();
  await w.c.advance(0);
  assert.equal(w.calls.length, 2);
  w.watch.stop();
});

test('frame/error publication exceptions cannot kill polling, and a hidden timeout is not published', async () => {
  const c = clock();
  let calls = 0;
  let errors = 0;
  const w = createFramePoller({
    ...c,
    fetch: async () => {
      calls++;
      if (calls > 1) throw new Error('offline');
      return { data: Buffer.from('x'), mime: 'image/png' };
    },
  }).watch({
    chatId: 'c',
    tabKey: null,
    onFrame: () => {
      throw new Error('window closed');
    },
    onError: () => {
      errors++;
      throw new Error('error window closed');
    },
  });
  w.setVisible(true);
  await tick();
  await c.advance(WATCH_MS);
  assert.equal(errors, 1);
  await c.advance(WATCH_MS);
  assert.equal(calls, 3);
  w.stop();
  const pending = deferred<any>();
  const h = world(() => pending.promise);
  h.watch.setVisible(true);
  await tick();
  h.watch.setVisible(false);
  await h.c.advance(FETCH_MS);
  assert.deepEqual(h.errors, []);
  pending.resolve({ data: Buffer.from('late'), mime: 'image/png' });
  await tick();
  h.watch.stop();
});

test('an optional error listener is not required for retry after failure', async () => {
  const c = clock();
  let calls = 0;
  const watch = createFramePoller({
    ...c,
    fetch: async () => {
      calls++;
      throw new Error('offline');
    },
  }).watch({ chatId: 'c', tabKey: null, onFrame: () => undefined });
  watch.setVisible(true);
  await tick();
  await c.advance(WATCH_MS);
  assert.equal(calls, 2);
  watch.stop();
});

test('ending an active action during takeover restores the takeover cadence', async () => {
  const w = world(undefined, { activeMs: 250 });
  w.watch.setVisible(true);
  await tick();
  w.watch.setTakeover(true);
  w.watch.setActive(true);
  await w.c.advance(0);
  assert.equal(w.calls.length, 2);
  w.watch.setActive(false);
  await w.c.advance(TAKEOVER_MS - 1);
  assert.equal(w.calls.length, 2);
  await w.c.advance(1);
  assert.equal(w.calls.length, 3);
  w.watch.stop();
});

test('an action that settles while a capture fails (no lease yet, or one transient error) still gets its frame at the active cadence, not a watch tick later', async () => {
  const first = deferred<any>();
  let n = 0;
  const w = world(
    async () => {
      n++;
      if (n === 1) return first.promise;
      return { data: Buffer.from(`ok${n}`), mime: 'image/jpeg' };
    },
    { activeMs: 250 },
  );
  w.watch.setVisible(true);
  await tick();
  // the action's refresh arrives while the first capture is out; that capture then fails with no_lease
  w.watch.refresh();
  first.reject(Object.assign(new Error('no lease'), { code: 'no_lease' }));
  await tick();
  assert.equal(w.errors.length, 1);
  await w.c.advance(250);
  assert.deepEqual(w.frames, ['ok2'], 'the owed frame came at the active cadence');
  // and a later refresh is not swallowed by the earlier one
  w.watch.refresh();
  await w.c.advance(0);
  assert.deepEqual(w.frames, ['ok2', 'ok3']);
  w.watch.stop();
});

test('an action that settles while a capture times out is owed its frame soon too; with no action the watch cadence stands', async () => {
  const hung = deferred<any>();
  let n = 0;
  const w = world(async () => (++n === 1 ? hung.promise : { data: Buffer.from(`ok${n}`), mime: 'image/jpeg' }), { activeMs: 250 });
  w.watch.setVisible(true);
  await tick();
  w.watch.refresh();
  await w.c.advance(FETCH_MS);
  assert.equal(w.errors.length, 1);
  hung.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  await w.c.advance(250);
  assert.ok(w.calls.length >= 2, 'retried at the active cadence');
  w.watch.stop();
  const quiet = world(async () => Promise.reject(new Error('boom')), { activeMs: 250 });
  quiet.watch.setVisible(true);
  await tick();
  await quiet.c.advance(WATCH_MS - 1);
  assert.equal(quiet.calls.length, 1, 'no action: the watch cadence');
  await quiet.c.advance(1);
  assert.equal(quiet.calls.length, 2);
  quiet.watch.stop();
});

test('a capture overtaken (stale_frame) is retried soon', async () => {
  let n = 0;
  const w = world(
    async () => {
      if (++n === 1) throw Object.assign(new Error('stale'), { code: 'stale_frame' });
      return { data: Buffer.from('fresh'), mime: 'image/jpeg' };
    },
    { activeMs: 250 },
  );
  w.watch.setVisible(true);
  await tick();
  await w.c.advance(250);
  assert.deepEqual(w.frames, ['fresh']);
  w.watch.stop();
});

test('a long action whose capture is still out past the fetch timeout still gets its post-action frame promptly once it answers', async () => {
  const hung = deferred<any>();
  let n = 0;
  const w = world(async () => (++n === 1 ? hung.promise : { data: Buffer.from(`ok${n}`), mime: 'image/jpeg' }), { activeMs: 250 });
  w.watch.setVisible(true);
  await tick();
  w.watch.refresh();
  await w.c.advance(FETCH_MS);
  assert.equal(w.errors.length, 1);
  await w.c.advance(250);
  assert.equal(w.calls.length, 1, 'the hung capture is still the only one out');
  hung.resolve({ data: Buffer.from('late'), mime: 'image/jpeg' });
  await tick();
  await w.c.advance(250);
  assert.deepEqual(w.frames.at(-1), 'ok2', 'the owed frame came at the active cadence, not 3 s later');
  w.watch.stop();
});
