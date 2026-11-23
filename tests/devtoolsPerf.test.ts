// browser_perf_trace (devtools/perfTrace.cjs): tracing start/stop/cap/turn end and trace parsing into insights and their text.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PerfTraces, insights, insightText } = require('../electron/capabilities/browser/devtools/perfTrace.cjs');

const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-trace-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fileName = () => path.join(dir, `t${n++}.json`);

type Chunk = { data?: string; base64Encoded?: boolean; eof?: boolean };

/** A fake tab whose Tracing.end completes (or not) and whose IO.read hands out `chunks`. */
function makeTab(o: { chunks?: Chunk[]; complete?: unknown | 'none'; closeFails?: boolean } = {}) {
  const dbg = new EventEmitter();
  const calls: Array<[string, any]> = [];
  const chunks = [...(o.chunks ?? [])];
  const tab = {
    backend: { debugger: dbg },
    calls,
    send: async (method: string, params?: any) => {
      calls.push([method, params]);
      if (method === 'Tracing.end' && o.complete !== 'none') {
        dbg.emit('message', {}, 'Page.other', {}, '');
        dbg.emit('message', {}, 'Tracing.tracingComplete', { stream: 'sub' }, 'session-1');
        dbg.emit('message', {}, 'Tracing.tracingComplete', o.complete ?? { stream: 'h1' }, '');
      }
      if (method === 'IO.read') return chunks.shift() ?? { eof: true };
      if (method === 'IO.close' && o.closeFails) throw new Error('close failed');
      return {};
    },
  };
  return { tab, dbg };
}

function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t: { cleared: boolean }) => {
      if (t) t.cleared = true;
    },
    byMs: (ms: number) => timers.find((t) => t.ms === ms)!,
  };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const traceChunks = (): Chunk[] => [
  { data: b64('{"traceEvents":['), base64Encoded: true },
  { data: '{"ph":"M","name":"x"},' },
  { eof: false },
  { data: b64('{"ph":"M","name":"y"}]}'), base64Encoded: true, eof: true },
];

test('start sends Tracing.start as a stream with the categories and refuses a second trace', async () => {
  const t = fakeTimers();
  const traces = new PerfTraces({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { tab } = makeTab();
  await traces.start('c', tab, fileName());
  const [method, params] = tab.calls[0];
  assert.equal(method, 'Tracing.start');
  assert.equal(params.transferMode, 'ReturnAsStream');
  assert.ok(params.traceConfig.includedCategories.includes('devtools.timeline'));
  assert.equal(t.timers[0].ms, 60_000);
  await assert.rejects(traces.start('c', tab, fileName()), (e: any) => e instanceof ToolError && /already running/.test(e.message));
});

test('stop returns null when nothing traced and the saved trace otherwise (object form)', async () => {
  const traces = new PerfTraces();
  assert.equal(traces.stop('none'), null);
  const t = fakeTimers();
  let clock = 1000;
  const tr = new PerfTraces({ now: () => (clock += 500), setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { tab } = makeTab({ chunks: traceChunks() });
  const file = fileName();
  await tr.start('c', tab, file);
  const r = await tr.stop('c');
  assert.equal(r.file, file);
  assert.equal(r.events, 2);
  assert.equal(r.why, null);
  assert.equal(r.lost, false);
  assert.equal(r.ms, 500);
  assert.equal(r.insights.navigated, false);
  assert.equal(r.bytes, fs.statSync(file).size);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents.length, 2);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.ok(t.timers[0].cleared);
  assert.ok(tab.calls.some(([m]) => m === 'IO.close'));
});

test('stop reads an array-form trace, notes data loss and survives a failing IO.close', async () => {
  const tr = new PerfTraces();
  const { tab } = makeTab({
    complete: { stream: 'h1', dataLossOccurred: true },
    closeFails: true,
    chunks: [{ data: '[{"ph":"X"}]', eof: true }],
  });
  const file = fileName();
  await tr.start('c', tab, file);
  const r = await tr.stop('c');
  assert.equal(r.events, 1);
  assert.equal(r.lost, true);
  await new Promise((res) => setImmediate(res));
});

test('an object trace without traceEvents counts as no events', async () => {
  const tr = new PerfTraces();
  const { tab } = makeTab({ chunks: [{ data: '{}', eof: true }] });
  await tr.start('c', tab, fileName());
  assert.equal((await tr.stop('c')).events, 0);
});

test('the cap timer ends the trace into ended, which takeEnded returns once', async () => {
  const t = fakeTimers();
  const tr = new PerfTraces({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { tab } = makeTab({ chunks: traceChunks() });
  await tr.start('c', tab, fileName());
  t.byMs(60_000).fn();
  const again = tr.stop('c');
  const r = await tr.takeEnded('c');
  assert.equal(r.why, 'it reached 60 seconds');
  assert.equal((await again).why, 'it reached 60 seconds');
  assert.equal(tr.takeEnded('c'), null);
  // a new trace forgets an ended one
  tr.ended.set('c', Promise.resolve({}));
  await tr.start('c', makeTab().tab, fileName());
  assert.equal(tr.takeEnded('c'), null);
  // a capped trace whose collection fails is noted, and the next call hears of it (no unhandled rejection meanwhile)
  const t2 = fakeTimers();
  const capped = new PerfTraces({ setTimer: t2.setTimer, clearTimer: t2.clearTimer });
  await capped.start('d', makeTab({ complete: {} }).tab, fileName());
  t2.byMs(60_000).fn();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(capped.takeEnded('d'), /Chrome kept no trace/);
});

test('endTurn ends the trace as "the turn ended"; without a trace it does nothing', async () => {
  const tr = new PerfTraces();
  tr.endTurn('c');
  assert.equal(tr.takeEnded('c'), null);
  const { tab } = makeTab({ chunks: traceChunks() });
  await tr.start('c', tab, fileName());
  tr.endTurn('c');
  const r = await tr.takeEnded('c');
  assert.equal(r.why, 'the turn ended');
  assert.equal(r.events, 2);
});

test('endTurn notes a failure instead of throwing', async () => {
  const tr = new PerfTraces();
  const { tab } = makeTab({ complete: {} });
  await tr.start('c', tab, fileName());
  tr.endTurn('c');
  await assert.rejects(tr.takeEnded('c'), /kept no trace/);
  await new Promise((res) => setImmediate(res));
});

test('Chrome keeping no trace is a ToolError, with and without data loss', async () => {
  for (const [complete, overflow] of [
    [{ dataLossOccurred: true }, true],
    [{}, false],
    [undefined, false],
  ] as const) {
    const tr = new PerfTraces();
    const { tab, dbg } = makeTab({ complete: 'none' });
    await tr.start('c', tab, fileName());
    const p = tr.stop('c');
    await new Promise((res) => setImmediate(res));
    dbg.emit('message', {}, 'Tracing.tracingComplete', complete, '');
    await assert.rejects(
      p,
      (e: any) => e instanceof ToolError && /kept no trace/.test(e.message) && /overflowed/.test(e.message) === overflow,
    );
    assert.equal(dbg.listenerCount('message'), 0);
  }
});

test('a trace that never completes times out after 30 seconds', async () => {
  const t = fakeTimers();
  const tr = new PerfTraces({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const { tab } = makeTab({ complete: 'none' });
  tab.backend.debugger = Object.assign(tab.backend.debugger, { removeListener: undefined });
  await tr.start('c', tab, fileName());
  const p = tr.stop('c');
  t.byMs(30_000).fn();
  await assert.rejects(p, (e: any) => e instanceof ToolError && /did not finish/.test(e.message));
});

test('a debugger without on(), or no debugger at all, is a ToolError', async () => {
  for (const tab of [{ backend: { debugger: {} }, send: async () => ({}) }, { send: async () => ({}) }]) {
    const tr = new PerfTraces();
    await tr.start('c', tab, fileName());
    await assert.rejects(tr.stop('c'), (e: any) => e instanceof ToolError && /no debugger/.test(e.message));
  }
});

test('an oversized trace is a ToolError and neither file stays', async () => {
  const tr = new PerfTraces({ maxBytes: 5 });
  const { tab } = makeTab({ chunks: [{ data: 'x'.repeat(10) }] });
  const file = fileName();
  fs.writeFileSync(file, 'old');
  await tr.start('c', tab, file);
  await assert.rejects(tr.stop('c'), (e: any) => e instanceof ToolError && /larger than 256 MB/.test(e.message));
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.ok(tab.calls.some(([m]) => m === 'IO.close'));
});

// ---- insights

const meta = (pid: number, tid: number, name: string) => ({ ph: 'M', name: 'thread_name', pid, tid, args: { name } });
const rt = (ts: number, dur: number, pid = 1, tid = 10, ph = 'X') => ({ ph, name: 'RunTask', ts, dur, pid, tid });

test('insights picks the latest main-frame navigation of the renderer and measures after it', () => {
  const events: any[] = [
    meta(1, 10, 'CrRendererMain'),
    meta(2, 20, 'Other'),
    { ph: 'M', name: 'thread_name', pid: 3, tid: 30 },
    { ph: 'M', name: 'process_name', pid: 3, tid: 30, args: { name: 'CrRendererMain' } },
    { name: 'navigationStart', pid: 1, ts: 3_000_000, args: { data: { isLoadingMainFrame: true } } },
    { name: 'navigationStart', pid: 1, ts: 1_000_000 },
    { name: 'navigationStart', pid: 1, ts: 5_000_000, args: { data: { isLoadingMainFrame: false } } },
    { name: 'navigationStart', pid: 2, ts: 9_000_000 },
    { name: 'largestContentfulPaint::Candidate', ts: 2_000_000 },
    { name: 'largestContentfulPaint::Candidate', ts: 4_000_000, args: { data: { size: 1 } } },
    { name: 'largestContentfulPaint::Candidate', ts: 6_000_000, args: { data: { size: 2 } } },
    { name: 'largestContentfulPaint::Candidate', ts: 5_000_000, args: { data: { size: 3 } } },
    { name: 'largestContentfulPaint::Candidate', ts: 6_500_000 },
    { name: 'firstContentfulPaint', ts: 2_000_000 },
    { name: 'firstContentfulPaint', ts: 3_800_000 },
    { name: 'firstContentfulPaint', ts: 4_000_000 },
    // layout shifts: out of order, one with input, one with score only, one with nothing
    { name: 'LayoutShift', ts: 12e6, args: { data: { weighted_score_delta: 0.03 } } },
    { name: 'LayoutShift', ts: 10e6, args: { data: { weighted_score_delta: 0.05, score: 9 } } },
    { name: 'LayoutShift', ts: 10.5e6, args: { data: { score: 0.04 } } },
    { name: 'LayoutShift', ts: 10.7e6, args: { data: { weighted_score_delta: 5, had_recent_input: true } } },
    { name: 'LayoutShift', ts: 10.9e6 },
    ...[20, 20.9, 21.8, 22.7, 23.6, 24.5, 25.4].map((s) => ({
      name: 'LayoutShift',
      ts: s * 1e6,
      args: { data: { weighted_score_delta: 0.02 } },
    })),
    // interactions
    { name: 'EventTiming', ph: 'b', args: { data: { interactionId: 1, duration: 100 } } },
    { name: 'EventTiming', ph: 'b', args: { data: { interactionId: 1, duration: 50 } } },
    { name: 'EventTiming', ph: 'b', args: { data: { interactionId: 1, duration: 150 } } },
    { name: 'EventTiming', ph: 'b', args: { data: { interactionId: 2, duration: 80 } } },
    { name: 'EventTiming', ph: 'b', args: { data: { interactionId: 3 } } },
    { name: 'EventTiming', ph: 'e', args: { data: { interactionId: 4, duration: 999 } } },
    { name: 'EventTiming', ph: 'b', args: { data: { duration: 999 } } },
    // tasks
    rt(1, 60_000),
    rt(2, 40_000),
    rt(3, 120_000),
    rt(4, 70_000, 2, 20),
    rt(5, 90_000, 1, 10, 'B'),
  ];
  assert.deepEqual(insights(events), {
    lcp: 3500,
    fcp: 800,
    cls: 0.12,
    inp: 150,
    interactions: 3,
    longTasks: { count: 2, totalMs: 180, longestMs: 120 },
    navigated: true,
  });
});

test('insights takes the 98th percentile with many interactions', () => {
  const events = Array.from({ length: 100 }, (_v, i) => ({
    name: 'EventTiming',
    ph: 'b',
    args: { data: { interactionId: i + 1, duration: i + 1 } },
  }));
  const r = insights(events);
  assert.equal(r.inp, 98);
  assert.equal(r.interactions, 100);
});

test('insights without thread names or navigation falls back to every thread and leaves LCP and FCP unmeasured', () => {
  const r = insights([
    { name: 'largestContentfulPaint::Candidate', ts: 5, args: { data: { size: 1 } } },
    { name: 'firstContentfulPaint', ts: 6 },
    rt(7, 70_000, 9, 9),
  ]);
  assert.equal(r.navigated, false);
  assert.equal(r.lcp, null);
  assert.equal(r.fcp, null);
  assert.equal(r.inp, null);
  assert.equal(r.longTasks.count, 1);
  const withNav = insights([
    { name: 'navigationStart', pid: 4, ts: 1000 },
    { name: 'firstContentfulPaint', ts: 3000 },
  ]);
  assert.equal(withNav.fcp, 2);
  assert.equal(withNav.lcp, null);
  assert.equal(insights([]).cls, 0);
});

test('insightText rates the values and says what was not measured', () => {
  assert.equal(
    insightText({
      lcp: 2000,
      fcp: 3500,
      cls: 0.3,
      inp: 100,
      interactions: 4,
      longTasks: { count: 2, totalMs: 180, longestMs: 120 },
      navigated: true,
    }),
    'LCP 2000 ms (good), FCP 3500 ms (poor), CLS 0.3 (poor), INP 100 ms (good) over 4 interactions. Long tasks on the main thread: 2 (180 ms in all, longest 120 ms).',
  );
  assert.equal(
    insightText({
      lcp: null,
      fcp: null,
      cls: 0,
      inp: null,
      interactions: 0,
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      navigated: false,
    }),
    'LCP not measured, FCP not measured, CLS 0 (good), INP not measured (no interaction). Long tasks on the main thread: 0. No navigation was traced: LCP and FCP need a reload or navigation while tracing.',
  );
});
