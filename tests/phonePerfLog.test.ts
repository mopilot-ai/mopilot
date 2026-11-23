// The performance log (#4986): off until Settings › About turns it on; JS samples bucketed into slow frames and stalls, touch to first commit, renders per screen, UI-thread frames handed over in batches; and the About rows that drive it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

const logPath = '../mobile/src/perfLog';
const probePath = '../mobile/src/components/PerfProbe';
const pagePath = '../mobile/src/screens/SettingsPages';
const { createPerfLog, perf, realClock, usePerfRender } = await import(logPath);
const { PerfHost, PerfFrame } = await import(probePath);
const { AboutPage } = await import(pagePath);

afterEach(() => {
  perf.end();
  document.body.replaceChildren();
});

/** A clock the test moves; `tick` runs the JS sampler and `print` collects the console lines. */
function clock() {
  const state = { now: 0, timers: [] as { fn: () => void; ms: number }[], lines: [] as string[], stopped: 0, frames: [] as (() => void)[] };
  return {
    state,
    clock: {
      now: () => state.now,
      every: (fn: () => void, ms: number) => {
        state.timers.push({ fn, ms });
        return () => void (state.stopped += 1);
      },
      frame: (fn: () => void) => void state.frames.push(fn),
      print: (line: string) => state.lines.push(line),
    },
    /** Runs the frame callbacks due now (one frame). */
    nextFrame: () => state.frames.splice(0).forEach((fn) => fn()),
    sample: (ms: number) => {
      state.now += ms;
      state.timers.find((t) => t.ms === 16)!.fn();
    },
    printNow: () => state.timers.find((t) => t.ms !== 16)!.fn(),
  };
}

test('A: off by default, and nothing counts until it starts', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  assert.equal(log.enabled, false);
  log.touch();
  log.committed();
  log.render('Thread');
  log.uiFrames({ total: 5, over25: 1, over50: 0 });
  assert.equal(c.state.timers.length, 0, 'no timer runs while it is off');
  log.start();
  assert.equal(log.report().renders.Thread, undefined);
  assert.equal(log.report().touch.count, 0);
});

test('A: JS samples are bucketed: on time, a missed frame, and a stall', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  c.sample(16);
  c.sample(16);
  c.sample(40); // late by 24: a frame of 40 ms
  c.sample(120); // late by 104: a stall
  const r = log.report();
  assert.deepEqual(r.js, { total: 4, over25: 2, over50: 1 });
  assert.deepEqual(r.stalls, { count: 1, worst: 120 });
  c.sample(70);
  assert.deepEqual(log.report().stalls, { count: 2, worst: 120 }, 'the longest stays');
});

test('A: touch to first commit is the first commit after a touch, and a commit with no touch waiting counts nothing', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  log.committed();
  c.state.now = 100;
  log.touch();
  c.state.now = 130;
  log.committed();
  log.committed();
  c.state.now = 200;
  log.touch();
  c.state.now = 290;
  log.committed();
  c.state.now = 300;
  log.touch();
  c.state.now = 303;
  log.committed();
  const t = log.report().touch;
  assert.deepEqual([t.count, t.median, t.worst, t.recent], [3, 30, 90, [30, 90, 3]]);
});

test('A: renders count per screen, UI frames add up in batches, reset zeroes, and the report is printed on a timer and stops with the log', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  log.start();
  assert.equal(c.state.timers.length, 2, 'starting twice starts once');
  log.render('Thread');
  log.render('Thread');
  log.render('Home');
  log.uiFrames({ total: 60, over25: 2, over50: 1 });
  log.uiFrames({ total: 60, over25: 0, over50: 0 });
  c.state.now = 4000;
  const r = log.report();
  assert.deepEqual([r.renders, r.ui, r.seconds], [{ Thread: 2, Home: 1 }, { total: 120, over25: 2, over50: 1 }, 4]);
  c.printNow();
  assert.match(c.state.lines[0], /^\[perf\] \{.*"Thread":2/);
  let told = 0;
  const off = log.subscribe(() => (told += 1));
  log.reset();
  assert.deepEqual(log.report().renders, {});
  assert.equal(told, 1);
  log.end();
  log.end();
  assert.equal(c.state.stopped, 2);
  assert.equal(log.enabled, false);
  assert.equal(told, 2);
  off();
});

test('A: a screen that calls usePerfRender is counted and its commit ends a touch', async () => {
  perf.start();
  const Screen = () => (usePerfRender('Screen'), null);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  perf.touch();
  await act(async () => root.render(createElement(Screen)));
  await flush();
  assert.equal(perf.report().renders.Screen, 1);
  assert.equal(perf.report().touch.count, 1);
  await act(async () => root.unmount());
});

test('A: the UI-thread probe is mounted only while the log is on, buckets every frame, and hands the sums over once a second', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const g = globalThis as any;
  g.__phoneFrame = undefined;
  await act(async () => root.render(createElement(PerfHost)));
  assert.equal(g.__phoneFrame, undefined, 'off: no probe, no frame callback');
  await act(async () => perf.start());
  assert.ok(g.__phoneFrame, 'on: the probe is there');
  const frame = (ms: number | null) => g.__phoneFrame({ timeSincePreviousFrame: ms });
  frame(null);
  frame(8);
  frame(30);
  frame(60);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(perf.report().ui, { total: 3, over25: 2, over50: 1 });
  await act(async () => perf.end());
  assert.ok(!host.querySelector('*'), 'off again: nothing drawn');
  await act(async () => root.unmount());
});

test('A: About has a Record row that turns the log on and off, shows the numbers while it is on, and Reset zeroes them', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AboutPage, { version: '1.0.0', back: () => undefined })));
  assert.match(host.textContent!, /Performance logRecordCounts and timings only\. Off each time MoPilot starts\.Off/);
  assert.doesNotMatch(host.textContent!, /JS frames/);
  await click('Record');
  assert.equal(perf.enabled, true);
  assert.match(host.textContent!, /starts\.On/);
  assert.match(host.textContent!, /JS frames0 frames · 0 over 25 ms · 0 over 50 ms/);
  assert.match(host.textContent!, /Touch to first commit0 touches · median 0 ms · worst 0 ms/);
  perf.render('Thread');
  await new Promise((r) => setTimeout(r, 1100));
  await flush();
  assert.match(host.textContent!, /Thread1 renders/);
  await click('Reset numbers');
  assert.deepEqual(perf.report().renders, {});
  await click('Record');
  assert.equal(perf.enabled, false);
  assert.doesNotMatch(host.textContent!, /Reset numbers/);
  await act(async () => root.unmount());
});

test('A: the device clock prints to the console, and its timers work where a timer is a plain number (React Native) as well as an object (node)', () => {
  const g = globalThis as any;
  const lines: unknown[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a[0]);
  realClock.print('hello');
  console.log = log;
  assert.deepEqual(lines, ['hello']);
  const [set, clear] = [g.setInterval, g.clearInterval];
  const cleared: unknown[] = [];
  g.setInterval = () => 7;
  g.clearInterval = (id: unknown) => cleared.push(id);
  try {
    realClock.every(() => undefined, 10)();
  } finally {
    [g.setInterval, g.clearInterval] = [set, clear];
  }
  assert.deepEqual(cleared, [7]);
  const ran: string[] = [];
  const raf = g.requestAnimationFrame;
  g.requestAnimationFrame = (fn: () => void) => (ran.push('asked'), fn());
  try {
    realClock.frame(() => ran.push('ran'));
  } finally {
    g.requestAnimationFrame = raf;
  }
  assert.deepEqual(ran, ['asked', 'ran']);
  assert.equal(typeof realClock.now(), 'number');
});

test('A: the frame notes a finger going down and hands its children through', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  perf.start();
  const Inner = () => (usePerfRender('Inner'), createElement('span', null, 'inside'));
  await act(async () => root.render(createElement(PerfFrame, null, createElement(Inner))));
  assert.match(host.textContent!, /inside/);
  const frame = [...host.querySelectorAll('div')].find((d: any) => d.__touchStartCapture) as any;
  assert.ok(frame, 'the frame listens for a touch');
  frame.__touchStartCapture({ nativeEvent: { timestamp: 5 } });
  await act(async () => root.render(createElement(PerfFrame, null, createElement(Inner, { key: 'again' }))));
  assert.equal(perf.report().touch.count, 1, 'the next commit ended the touch');
  await act(async () => root.unmount());
});

test('A: a touch is dated from the system’s own time: a JS thread that got it late counts as late, against the fastest hand-over seen', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  // the system's clock is another origin (7000 ahead): only the gap between the two matters, and the least gap is the floor
  c.state.now = 1005;
  log.touch(-5995); // gap 7000: the floor
  c.state.now = 1040;
  log.committed();
  c.state.now = 2030;
  log.touch(-5000 + 0); // gap 7030: JS got it 30 ms later than the fastest
  c.state.now = 2050;
  log.committed();
  c.state.now = 3000;
  log.touch(undefined); // no system time: dated at the JS handler
  c.state.now = 3010;
  log.committed();
  c.state.now = 4000;
  log.touch(Number.NaN); // an unreadable time is no time
  c.state.now = 4020;
  log.committed();
  const r = log.report().touch;
  assert.deepEqual(r.queue, { count: 2, median: 30, worst: 30 }, 'only touches with a system time have a queue');
  assert.deepEqual([r.count, r.worst], [4, 50], 'the late touch waited 20 ms for the commit plus the 30 ms it was late');
});

test('A: each screen’s render is timed from its start to its commit, and named events are counted', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  assert.equal(log.render('Thread'), -1, 'off: nothing is timed');
  log.start();
  c.state.now = 100;
  const a = log.render('Thread');
  c.state.now = 108;
  log.committed('Thread', a);
  c.state.now = 200;
  const b = log.render('Thread');
  c.state.now = 220;
  log.committed('Thread', b);
  log.committed('Thread', -1);
  log.committed();
  log.event('delta');
  log.event('delta');
  log.event('thread-update');
  const r = log.report();
  assert.deepEqual(r.renderMs, { Thread: { mean: 14, worst: 20 } });
  assert.deepEqual(r.events, { delta: 2, 'thread-update': 1 });
  log.end();
  log.event('delta');
  log.committed('Thread', 1);
  assert.deepEqual(log.report().events, { delta: 2, 'thread-update': 1 }, 'off: nothing counts');
});

test('A: a live event reaching a chat counts as a delta and a thread update', async () => {
  const feedPath = '../mobile/src/presentation/followFeed';
  const { createFollowFeed } = await import(feedPath);
  perf.start();
  let handle: (e: unknown) => void = () => undefined;
  const feed = createFollowFeed({
    read: () => Promise.resolve({ rev: 1, feedSeq: 0, session: { turn: 'idle' }, itemsShape: 'rows', items: [] }),
    subscribe: (h: (e: unknown) => void) => ((handle = h), () => undefined),
    on: { thread: () => undefined, failed: () => undefined },
  });
  feed.start();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const before = perf.report().events;
  handle({ ev: 'items.append', feedSeq: 1, live: true, items: [{ id: 'i1', type: 'agentMessage', text: 'x' }] });
  const after = perf.report().events;
  assert.equal((after.delta ?? 0) - (before.delta ?? 0), 1);
  assert.equal((after['thread-update'] ?? 0) - (before['thread-update'] ?? 0), 1);
  feed.stop();
});

test('A: About shows the touch queue, a row per screen with its render time, the events, and Share numbers hands the report to the share sheet', async () => {
  const g = globalThis as any;
  g.__phoneShared = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AboutPage, { version: '1.0.0', back: () => undefined })));
  await click('Record');
  perf.event('delta');
  const t = perf.render('Thread');
  perf.committed('Thread', t);
  await new Promise((r) => setTimeout(r, 1100));
  await flush();
  // the Record tap itself can be counted as a touch when the suite runs under load, so the count is not pinned
  assert.match(host.textContent!, /Touch to next frame\d+ touches · median \d+ ms · worst \d+ ms · 0 without a commit/);
  assert.match(host.textContent!, /Touch reaching JSmedian 0 ms late · worst 0 ms late/);
  assert.match(host.textContent!, /Thread1 renders · \d+ ms avg · \d+ ms worst/);
  assert.match(host.textContent!, /Eventsdelta 1/);
  await click('Share numbers');
  assert.equal(g.__phoneShared.length, 1);
  assert.equal(JSON.parse(g.__phoneShared[0]).events.delta, 1);
  g.__phoneShareFails = true;
  await click('Share numbers');
  g.__phoneShareFails = false;
  await act(async () => root.unmount());
});

test('A: the report keeps the last touches in order, so one interaction can be read on its own', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  for (let i = 1; i <= 25; i += 1) {
    c.state.now += 100;
    log.touch();
    c.state.now += i;
    log.committed();
  }
  const r = log.report().touch;
  assert.equal(r.count, 25);
  assert.deepEqual(
    r.recent,
    Array.from({ length: 20 }, (_, i) => i + 6),
  );
});

test('A: a touch that commits nothing is counted as such, not answered by a later commit; a late commit is another piece of work’s', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  // a tap that commits nothing (focusing the field): the next tap finds it still waiting
  c.state.now = 100;
  log.touch();
  c.state.now = 500;
  log.touch();
  c.state.now = 530;
  log.committed();
  // a commit seconds later belongs to other work
  c.state.now = 1000;
  log.touch();
  c.state.now = 4000;
  log.committed();
  const r = log.report().touch;
  assert.deepEqual([r.count, r.recent, r.noCommit], [1, [30], 2]);
});

test('A: every touch is also timed to the second frame after it, whether or not anything committed', () => {
  const c = clock();
  const log = createPerfLog(c.clock);
  log.start();
  c.state.now = 100;
  log.touch();
  c.state.now = 116;
  c.nextFrame();
  c.state.now = 133;
  c.nextFrame();
  c.state.now = 200;
  log.touch();
  c.state.now = 217;
  c.nextFrame();
  c.state.now = 233;
  c.nextFrame();
  assert.deepEqual(log.report().touch.frame, { count: 2, median: 33, worst: 33 });
  // a touch whose frames come after the log was turned off adds nothing
  c.state.now = 300;
  log.touch();
  log.end();
  c.state.now = 333;
  c.nextFrame();
  c.nextFrame();
  assert.equal(log.report().touch.frame.count, 2);
});
