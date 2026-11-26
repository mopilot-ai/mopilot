// Settings › About's performance log shows the last picked videos and picks as plain lines of numbers and fixed words, readable on the screen itself (#5638): no name, no path, no new way out.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const screenPath = '../mobile/src/screens/AboutPerf';
const logPath = '../mobile/src/perfLog';
const linesPath = '../mobile/src/presentation/perfLines';
const { AboutPerf } = await import(screenPath);
const { perf } = await import(logPath);
const { videoLine, pickLine, uploadLine } = await import(linesPath);

afterEach(() => perf.end());

const MB = 1024 * 1024;
const video = (extra = {}) => ({
  durationMs: 60_000,
  sourceBytes: 80 * MB,
  width: 3840,
  height: 2160,
  rungs: [
    { size: '540p', estimate: 22 * MB, bytes: 20 * MB, seconds: 9.54, outcome: 'cut' },
    { size: '480p', estimate: 15 * MB, bytes: 18 * MB, seconds: 7.25, outcome: 'kept' },
  ],
  kept: '480p',
  result: 'smaller',
  seconds: 17.1,
  ...extra,
});

async function show() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AboutPerf)));
  await flush();
  return { host, done: () => act(async () => root.unmount()) };
}

test('a video and a pick read as one line each: its length, size, dimensions, each size tried, and how it ended', () => {
  assert.equal(
    videoLine(video()),
    '60 s · 80.0 MB · 3840×2160 · 540p cut est 22.0 MB got 20.0 MB 9.5 s · 480p kept est 15.0 MB got 18.0 MB 7.3 s · → smaller 480p in 17.1 s',
  );
  assert.equal(
    videoLine(video({ durationMs: null, sourceBytes: null, width: null, rungs: [], kept: null, result: 'unreadable', seconds: 0.1 })),
    '? · ? · ? · → unreadable in 0.1 s',
  );
  assert.equal(pickLine({ seconds: 43.8, count: 2, videos: 2, readSeconds: 5.1 }), '2 items · 2 videos · picker 43.8 s · ready 5.1 s');
});

test('while recording, About lists the newest picks and videos, numbered, and nothing before the log is on', async () => {
  const off = await show();
  assert.doesNotMatch(off.host.textContent!, /Video 1|Pick 1/);
  await off.done();
  await act(async () => perf.start());
  perf.pick({ seconds: 43.8, count: 2, videos: 2, readSeconds: 5.1 });
  for (let i = 0; i < 8; i++) perf.video(video({ seconds: i }));
  const on = await show();
  const text = on.host.textContent!;
  assert.match(text, /Pick 1.*2 items · 2 videos · picker 43\.8 s · ready 5\.1 s/);
  assert.match(text, /Video 8.*→ smaller 480p in 7 s/);
  assert.match(text, /Video 3/, 'the newest six are shown');
  assert.doesNotMatch(text, /Video 2(?!\d)/, 'and not the ones before');
  assert.doesNotMatch(text, /file:|\.mov|IMG_/, 'numbers and fixed words only');
  await on.done();
});

const upload = (over: object = {}) => ({
  restarted: false,
  computer: 'named',
  parts: 4,
  events: [{ index: 0, to: 3, gen: 4, computer: 'same', outcome: 'ok' }],
  waits: [],
  result: 'done',
  reason: null,
  seconds: 12.3,
  ...over,
});

test('an upload reads as one line: parts that went in a row on one connection as a range, every other part where it happened, the waits, and how it ended', () => {
  assert.equal(uploadLine(upload()), 'computer named · 4 parts · 0–3 ok g4 · → done in 12.3 s');
  assert.equal(
    uploadLine(
      upload({
        restarted: true,
        computer: 'none',
        events: [
          { index: 0, gen: 4, computer: 'same', outcome: 'ok' },
          { index: 1, gen: 4, computer: 'same', outcome: 'lost' },
          { index: 1, gen: 5, computer: 'other', outcome: 'other-computer' },
          { index: 1, gen: null, computer: 'none', outcome: 'refused', code: 'STREAM_UNKNOWN' },
          { index: 2, gen: 5, computer: 'same', outcome: 'ok' },
          { index: 3, to: 9, gen: 6, computer: 'same', outcome: 'ok' },
        ],
        waits: [1000, 2000],
        result: 'retry',
        reason: 'other-computer',
        seconds: 3.2,
      }),
    ),
    'restarted · computer none · 4 parts · 0 ok g4 · 1 lost g4 · 1 other-computer g5 other · 1 refused STREAM_UNKNOWN g? none · 2 ok g5 · 3–9 ok g6 · waits 1 s 2 s · → retry other-computer in 3.2 s',
  );
});

test('while recording, About lists the newest uploads, numbered, with numbers and fixed words only', async () => {
  await act(async () => perf.start());
  perf.upload(upload({ result: 'cut-off', seconds: 2 }));
  const on = await show();
  assert.match(on.host.textContent!, /Upload 1.*computer named · 4 parts · 0–3 ok g4 · → cut-off in 2 s/);
  await on.done();
});
