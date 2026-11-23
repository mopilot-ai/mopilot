// The main process's streaming performance probe (electron/perf/probe.cjs): its bounded asynchronous writer, the per-second
// samples on a fake clock and loop monitor, the counters the window and adapter sends feed, transcript write timing, the
// windows' batches, and following the shared.perf.probe switch.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';

const require = createRequire(import.meta.url);
const probe = require('../electron/perf/probe.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perf-probe-'));
const lines = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/** perf_hooks' loop delay histogram, in nanoseconds, as the probe reads it. */
function fakeMonitor() {
  const m = {
    enabled: false,
    resets: 0,
    max: 42_000_000,
    enable: () => void (m.enabled = true),
    disable: () => void (m.enabled = false),
    reset: () => void m.resets++,
    // the timer's 10 ms interval plus p/10 ms
    percentile: (p: number) => 10_000_000 + p * 100_000,
  };
  return m;
}

/** setInterval/clearInterval that run only when told. */
function fakeTimers() {
  const t = {
    cb: null as null | (() => void),
    ms: 0,
    cleared: false,
    setInterval: ((cb: () => void, ms: number) => ((t.cb = cb), (t.ms = ms), { unref: () => undefined })) as any,
    clearInterval: (() => void (t.cleared = true)) as any,
  };
  return t;
}

test('the writer appends queued lines in one write at a time, and drops past its bound', async () => {
  const writes: string[] = [];
  const dirs: string[] = [];
  let release!: () => void;
  const w = probe.createWriter('/x/perf/run.jsonl', {
    max: 2,
    mkdir: async (d: string) => void dirs.push(d),
    append: (_f: string, text: string) => new Promise<void>((r) => ((release = r), writes.push(text))),
  });
  assert.equal(await w.flush(), undefined, 'nothing queued');
  assert.equal(w.push('a'), true);
  assert.equal(w.push('b'), true);
  assert.equal(w.push('c'), false);
  assert.equal(w.takeDropped(), 1);
  assert.equal(w.takeDropped(), 0);
  const first = w.flush();
  await new Promise((r) => setImmediate(r));
  w.push('d');
  // one append in flight: a second flush waits for it rather than writing alongside
  assert.equal(w.flush(), first);
  release();
  await first;
  const drained = w.drain();
  await new Promise((r) => setImmediate(r));
  release();
  await drained;
  assert.deepEqual(writes, ['a\nb\n', 'd\n']);
  assert.deepEqual(dirs, ['/x/perf'], 'the folder is made once');
});

test('a failed write loses that batch, is recorded, and the next batch makes the folder again', async () => {
  clearIgnored();
  let fail = true;
  const dirs: string[] = [];
  const writes: string[] = [];
  const w = probe.createWriter('/x/perf/run.jsonl', {
    mkdir: async (d: string) => void dirs.push(d),
    append: async (_f: string, text: string) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      writes.push(text);
    },
  });
  w.push('a');
  await w.flush();
  assert.equal(recentIgnored().at(-1).context, 'write performance samples');
  fail = false;
  w.push('b');
  await w.drain();
  assert.deepEqual(writes, ['b\n']);
  assert.equal(dirs.length, 2);
});

test('each second the probe writes the loop delay, the IPC and raw counts it took, and what it dropped', async () => {
  const pushed: string[] = [];
  let dropped = 3;
  let flushes = 0;
  const writer = {
    push: (l: string) => (pushed.push(l), true),
    takeDropped: () => {
      const n = dropped;
      dropped = 0;
      return n;
    },
    flush: async () => void flushes++,
    drain: async () => undefined,
  };
  const timers = fakeTimers();
  const monitor = fakeMonitor();
  const p = probe.createProbe({ file: '/x.jsonl', now: () => 1000, monitor: () => monitor, writer, ...timers });
  assert.equal(monitor.enabled, true);
  assert.equal(timers.ms, probe.TICK_MS);
  p.ipc('codex:item', 1);
  p.ipc('codex:item', 1);
  p.ipc('acp:event', 2);
  p.raw('codex', 'chat-a');
  p.raw('acp', null);
  timers.cb!();
  const samples = pushed.map((l) => JSON.parse(l));
  assert.deepEqual(samples, [
    { t: 1000, kind: 'loop', p50: 5, p95: 9.5, p99: 9.9, max: 32 },
    { t: 1000, kind: 'ipc', channel: 'codex:item', window: 1, count: 2 },
    { t: 1000, kind: 'ipc', channel: 'acp:event', window: 2, count: 1 },
    { t: 1000, kind: 'raw', harness: 'codex', chat: 'chat-a', count: 1 },
    { t: 1000, kind: 'raw', harness: 'acp', chat: null, count: 1 },
    { t: 1000, kind: 'dropped', count: 3 },
  ]);
  assert.equal(monitor.resets, 1);
  assert.equal(flushes, 1);
  // counters start again each second
  pushed.length = 0;
  timers.cb!();
  assert.deepEqual(
    pushed.map((l) => JSON.parse(l).kind),
    ['loop'],
  );
  await p.stop();
  assert.equal(timers.cleared, true);
  assert.equal(monitor.enabled, false);
});

test('the probe writes to <userData>/perf/<run id>.jsonl while on, and the counters are free while off', async () => {
  const dir = tmp();
  assert.match(probe.runId(new Date('2026-10-15T01:02:03.456Z'), 7), /^2026-10-15T01-02-03-456Z-7$/);
  probe.countIpc('codex:item', 1);
  probe.countRaw('codex', { chatId: 'x' });
  probe.recordWindowSamples(1, [{ kind: 'frame' }]);
  assert.equal(probe.probing(), false);
  probe.recordWrite({ chat: 'c', records: 1, bytes: 2, ms: 1, reason: 'tick' });
  const timers = fakeTimers();
  const file = probe.startProbe({ dir, id: 'run1', now: () => 5, ...timers });
  assert.equal(file, path.join(dir, 'perf', 'run1.jsonl'));
  assert.equal(probe.startProbe({ dir, id: 'run2' }), file, 'one run at a time');
  probe.countIpc('claude:event', 3);
  probe.countRaw('claude', { key: 'k' });
  probe.countRaw('codex', { chatId: 'c' });
  probe.countRaw('acp', undefined);
  // a broadcast counts as an adapter event only on an adapter's channel
  probe.countBroadcast('claude:event', { key: 'b' });
  probe.countBroadcast('acp:event', { key: 'b' });
  probe.countBroadcast('projects:changed', { key: 'b' });
  await probe.stopProbe();
  await probe.stopProbe();
  const got = lines(file);
  assert.equal(got[0].kind, 'loop');
  assert.deepEqual(got.slice(1), [
    { t: 5, kind: 'ipc', channel: 'claude:event', window: 3, count: 1 },
    { t: 5, kind: 'raw', harness: 'claude', chat: 'k', count: 1 },
    { t: 5, kind: 'raw', harness: 'codex', chat: 'c', count: 1 },
    { t: 5, kind: 'raw', harness: 'acp', chat: null, count: 1 },
    { t: 5, kind: 'raw', harness: 'claude', chat: 'b', count: 1 },
    { t: 5, kind: 'raw', harness: 'acp', chat: 'b', count: 1 },
  ]);
});

test('a write the transcript crate reports is sampled while the probe runs', async () => {
  const dir = tmp();
  const file = probe.startProbe({ dir, id: 'w', now: () => 9, ...fakeTimers() });
  assert.equal(probe.probing(), true);
  probe.recordWrite({ chat: 'chat', records: 3, bytes: 120, ms: 1.23, reason: 'tick' });
  await probe.stopProbe();
  assert.deepEqual(
    lines(file).filter((s) => s.kind === 'write'),
    [{ t: 9, kind: 'write', chat: 'chat', records: 3, bytes: 120, ms: 1.23, reason: 'tick' }],
  );
});

test('a window’s samples are stamped with its id; malformed ones and a batch past the bound are counted as dropped', async () => {
  const dir = tmp();
  const file = probe.startProbe({ dir, id: 'r', now: () => 1, ...fakeTimers() });
  probe.recordWindowSamples(4, 'not a batch');
  probe.recordWindowSamples(4, [{ t: 50, kind: 'frame', ms: 16.7, visible: true, window: 99 }, null, [], { kind: 7 }, 'x']);
  probe.recordWindowSamples(
    5,
    Array.from({ length: probe.MAX_BATCH + 2 }, () => ({ kind: 'longtask', ms: 60 })),
  );
  await probe.stopProbe();
  const got = lines(file).filter((s) => s.kind !== 'loop');
  assert.deepEqual(got[0], { t: 50, kind: 'frame', ms: 16.7, visible: true, window: 4 });
  assert.deepEqual(got[1], { t: 1, kind: 'dropped', window: 4, count: 4 });
  assert.equal(got.filter((s) => s.kind === 'longtask' && s.window === 5).length, probe.MAX_BATCH);
  assert.deepEqual(got.at(-1), { t: 1, kind: 'dropped', window: 5, count: 2 });
});

test('every line of a run says whether it has the core, asked once, and a window cannot say otherwise', async () => {
  for (const onCore of [true, false]) {
    const pushed: string[] = [];
    const writer: any = {
      push: (l: string) => pushed.push(l) > 0,
      takeDropped: () => 2,
      flush: async () => undefined,
      drain: async () => undefined,
    };
    const timers = fakeTimers();
    let asked = 0;
    const p = probe.createProbe({
      file: '/x.jsonl',
      now: () => 1,
      monitor: () => fakeMonitor(),
      writer,
      ...timers,
      metrics: () => [],
      marks: () => [{ name: 'boot', ms: 1 }],
      coreLoaded: () => (asked++, onCore),
    });
    p.sample({ kind: 'frame', ms: 16, coreLoaded: !onCore });
    timers.cb!();
    await p.stop();
    const got = pushed.map((l) => JSON.parse(l));
    assert.equal(asked, 1);
    assert.deepEqual([...new Set(got.map((s) => s.kind))], ['mark', 'frame', 'loop', 'dropped']);
    assert.deepEqual([...new Set(got.map((s) => s.coreLoaded))], [onCore]);
  }
});

test('the switch hands on how to ask about the core', async () => {
  const dir = tmp();
  let asked = 0;
  probe.syncProbe(true, dir, () => (asked++, true));
  await probe.stopProbe();
  assert.equal(asked, 1);
});

test('the probe follows its switch: on starts it once, off stops it and writes what it held', async () => {
  const dir = tmp();
  probe.syncProbe(false, dir);
  assert.equal(fs.existsSync(path.join(dir, 'perf')), false);
  probe.syncProbe(true, dir);
  probe.syncProbe(true, dir);
  probe.countIpc('acp:event', 1);
  probe.syncProbe(false, dir);
  // stopping writes asynchronously; wait for the file
  await waitFor(() => fs.existsSync(path.join(dir, 'perf')), 'the perf folder');
  await waitFor(() => fs.readdirSync(path.join(dir, 'perf')).length > 0, 'a perf file');
  const files = fs.readdirSync(path.join(dir, 'perf'));
  assert.equal(files.length, 1);
  const recordedIpc = () => readJsonLineLog(path.join(dir, 'perf', files[0])).some((s) => s.kind === 'ipc' && s.channel === 'acp:event');
  await waitFor(recordedIpc, 'the complete acp:event sample');
  assert.ok(recordedIpc());
  assert.equal(probe.chatOf(null), null);
});
