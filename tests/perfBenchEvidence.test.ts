// Offline performance-report evidence: unavailable inputs are incomplete, partial metrics remain useful, and retries reread.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregate, aggregateRun, COLUMNS, readSamples, table } from '../scripts/perf-bench/aggregate.mjs';
import { MAX_PENDING, startPerfProbe, type PerfSample } from '../src/session/perf';

const cell = { scenario: 'S1', variant: 'codex', rate: 120, chunk: 4, chats: 1, rep: 0, from: 1000, to: 2000, probe: 'probe.jsonl' };
const frame = { t: 1500, kind: 'frame', ms: 16, visible: true, focused: true };
const report = (samples: any, cells: any[] = [cell]) => aggregate(cells, () => samples);

test('absent metrics stay unknown and a diagnostic alone never establishes a measured run', () => {
  for (const samples of [[], [{ t: 1500, kind: 'metadata' }], [{ t: 1500, kind: 'dropped', count: 0 }]]) {
    const { runs, rows } = report(samples);
    assert.equal(runs[0].status, 'incomplete');
    assert.equal(runs[0].metrics, null);
    assert.deepEqual([rows[0].attempted, rows[0].measured, rows[0].runs, rows[0].incomplete, rows[0].failed], [1, 0, 0, 1, 0]);
    for (const [field] of COLUMNS) {
      assert.equal(rows[0][field], null, field);
      assert.equal(rows[0].metricRuns[field], 0, field);
    }
  }
});

test('partial evidence retains its metrics and explains losses, without counting as complete', () => {
  const { runs, rows } = report({
    samples: [frame, { t: 1600, kind: 'dropped', count: 4 }, { t: 0, kind: 'dropped', count: 99 }],
    skipped: 2,
  });
  assert.equal(runs[0].status, 'incomplete');
  assert.equal(runs[0].metrics!.frameP95, 16);
  assert.deepEqual(runs[0].evidence, {
    samples: 1,
    skipped: 2,
    invalid: 0,
    dropped: 103,
    reasons: ['2 unreadable probe lines', '103 dropped samples in the probe file; loss timestamps unavailable'],
    longTasks: { recordedEvents: 0, observerAvailability: 'unknown', observationCoverage: 'unknown' },
  });
  assert.deepEqual([rows[0].attempted, rows[0].measured, rows[0].runs, rows[0].incomplete], [1, 1, 0, 1]);
  assert.equal(rows[0].metricRuns.frameP95, 1);
  assert.equal(rows[0].metricRuns.reactP95, 0);
  assert.match(table(rows), /Metrics retain usable samples from incomplete attempts/);
});

test('raw-only evidence preserves event-count arithmetic but cannot certify a zero or observer coverage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-evidence-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cells.json'), JSON.stringify([cell]));
  fs.writeFileSync(path.join(dir, cell.probe), JSON.stringify({ t: 1500, kind: 'raw', count: 1 }));
  const output = aggregateRun(dir);
  const { runs, rows } = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  assert.equal(runs[0].status, 'complete', 'complete means no detected loss, not all metrics collected');
  assert.deepEqual(runs[0].evidence.longTasks, {
    recordedEvents: 0,
    observerAvailability: 'unknown',
    observationCoverage: 'unknown',
  });
  assert.equal(rows[0].longTasksPerMin, 0, 'legacy recorded-event arithmetic remains unchanged');
  assert.equal(rows[0].metricRuns.longTasksPerMin, 1, 'counts numeric contributors, not verified spans');
  assert.equal(rows[0].frameP95, null);
  assert.equal(rows[0].reactP95, null);
  assert.match(
    output,
    /Complete counts indicate no detected evidence loss, not that every metric was collected or acceptance targets passed/,
  );
  assert.match(output, /Zero means no recorded events; observer availability and observation coverage are unknown/);
  assert.match(output, /metricRuns counts numeric contributors, not verified observation spans/);
});

test('drop markers outside a cell conservatively mark every cell using that file incomplete', () => {
  for (const t of [cell.from - 1, cell.to + 1]) {
    const { runs, rows } = report([frame, { t, kind: 'dropped', count: 1 }], [cell, { ...cell, rep: 1 }]);
    assert.deepEqual(
      runs.map((run) => run.status),
      ['incomplete', 'incomplete'],
    );
    assert.equal(rows[0].runs, 0);
    assert.equal(rows[0].measured, 2);
    assert.equal(rows[0].frameP95, 16);
    assert.equal(runs[0].evidence!.dropped, 1);
  }
});

test('the real renderer producer can report in-cell sample losses only on a later flush', async () => {
  const { loadStore } = await import('./support/store-harness.ts');
  const { store } = await loadStore();
  let now = 1900;
  let onLongTask!: (ms: number) => void;
  let flush!: () => void;
  const sent: PerfSample[] = [];
  const stop = startPerfProbe({
    store: store.useStore,
    now: () => now,
    clock: () => now,
    send: (batch) => sent.push(...batch),
    raf: () => 1,
    cancelRaf: () => {},
    setInterval: (cb) => {
      flush = cb;
      return 1;
    },
    clearInterval: () => {},
    observeLongTasks: (cb) => {
      onLongTask = cb;
      return () => {};
    },
    visible: () => true,
    focused: () => true,
    onHidden: () => () => {},
  });
  try {
    for (let i = 0; i <= MAX_PENDING; i++) onLongTask(50);
    now = cell.to + 100;
    flush();
    assert.deepEqual(sent.at(-1), { t: now, kind: 'dropped', count: 1 });
    const { runs, rows } = report(sent);
    assert.equal(runs[0].status, 'incomplete');
    assert.equal(runs[0].evidence!.samples, MAX_PENDING);
    assert.equal(runs[0].evidence!.dropped, 1);
    assert.equal(rows[0].longTasksPerMin, MAX_PENDING * 60);
    assert.equal(rows[0].metricRuns.longTasksPerMin, 1);
  } finally {
    stop();
  }
});

test('wrong-shape and non-finite measurement samples do not poison valid partial results', () => {
  const invalid = [
    null,
    [],
    true,
    {},
    { t: '1500', kind: 'loop', p95: 4 },
    { t: NaN, kind: 'loop', p95: 4 },
    { t: 1500, kind: 4 },
    { t: 1500, kind: 'loop' },
    { t: 1500, kind: 'loop', p95: Infinity },
    { t: 1500, kind: 'raw', count: -1 },
    { ...frame, visible: 'true' },
    { ...frame, focused: null },
    { t: 1500, kind: 'write', ms: 2 },
    { t: 1500, kind: 'write', ms: 2, records: 1, queue: -1 },
    { t: 1500, kind: 'commit', count: 1 },
    { t: 1500, kind: 'ipc', count: 1, window: 1 },
    { t: 1500, kind: 'ipc', count: 1, channel: 'codex:item' },
  ];
  const { runs, rows } = report([frame, ...invalid]);
  assert.equal(runs[0].evidence!.invalid, invalid.length);
  assert.equal(runs[0].status, 'incomplete');
  assert.equal(rows[0].frameP95, 16);
  assert.equal(rows[0].metricRuns.frameP95, 1);
  assert.equal(rows[0].loopP95, null);
  assert.equal(rows[0].queueMax, null);
});

test('valid zeros, optional columns, additional fields and diagnostic metadata stay supported', () => {
  const { runs, rows } = report([
    { ...frame, ms: 0, extra: 'allowed' },
    { t: 1500, kind: 'metadata', version: 'new' },
    { t: 1500, kind: 'dropped', count: 0 },
    { t: 1500, kind: 'write', ms: 0, records: 0, queue: 0 },
    { t: 1500, kind: 'write', ms: 1, records: 1, queue: null },
    { t: 1500, kind: 'ipc', count: 0, channel: 'codex:item', window: 0 },
    { t: 1500, kind: 'ipc', count: 0, channel: 'acp:event', window: 'second' },
    { t: 1500, kind: 'commit', count: 0, thread: 'chat' },
    { t: 1500, kind: 'longtask', ms: 0 },
  ]);
  assert.equal(runs[0].status, 'complete');
  assert.equal(rows[0].frameP95, 0);
  assert.equal(rows[0].reactP95, null);
  assert.equal(rows[0].rawPerSec, null);
  assert.equal(rows[0].runs, 1);
});

test('malformed serialized data preserves readable samples and per-metric contributor counts', () => {
  const partial = readSamples(JSON.stringify(frame) + '\nnull\n{bad\n');
  const result = aggregate(
    [
      { ...cell, rep: 0 },
      { ...cell, rep: 1, probe: 'other' },
      { ...cell, rep: 2, error: 'runner timed out' },
    ],
    (probe) => (probe === cell.probe ? partial : [{ t: 1500, kind: 'loop', p95: 5 }]),
  );
  assert.deepEqual(
    result.runs.map((r) => r.status),
    ['incomplete', 'complete', 'failed'],
  );
  assert.deepEqual(
    [result.rows[0].attempted, result.rows[0].measured, result.rows[0].runs, result.rows[0].incomplete, result.rows[0].failed],
    [3, 2, 1, 1, 1],
  );
  assert.equal(result.rows[0].frameP95, 16);
  assert.equal(result.rows[0].loopP95, 5);
  assert.equal(result.rows[0].metricRuns.frameP95, 1);
  assert.equal(result.rows[0].metricRuns.loopP95, 1);
  assert.equal(result.runs[2].evidence, null);
});

test('each invocation rereads recovered files; unreadable files retain an explicit reason', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-evidence-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, cell.probe);
  fs.writeFileSync(path.join(dir, 'cells.json'), JSON.stringify([cell]));
  fs.mkdirSync(file);
  assert.match(aggregateRun(dir), /probe file unreadable \(EISDIR\)/);
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify(frame));
  aggregateRun(dir);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  assert.equal(result.rows[0].runs, 1);
  assert.equal(result.rows[0].incomplete, 0);
  assert.equal(result.rows[0].frameP95, 16);
});

test('an unreadable probe without a platform error code is still reported, not thrown or treated as complete', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-evidence-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cells.json'), JSON.stringify([cell]));
  const original = fs.readFileSync;
  const replacement = mock.method(fs, 'readFileSync', (...args: any[]) => {
    if (args[0] === path.join(dir, cell.probe)) throw new Error('read unavailable');
    return (original as any)(...args);
  });
  t.after(() => replacement.mock.restore());
  assert.match(aggregateRun(dir), /probe file unreadable \(unknown\)/);
  replacement.mock.mockImplementation((...args: any[]) => {
    if (args[0] === path.join(dir, cell.probe)) throw null;
    return (original as any)(...args);
  });
  assert.match(aggregateRun(dir), /probe file unreadable \(unknown\)/);
});

test('the actual offline CLI generates an honestly incomplete report with its existing success exit contract', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-evidence-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'cells.json'), JSON.stringify([cell]));
  const cli = spawnSync(process.execPath, ['scripts/perf-bench/aggregate.mjs', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /\| codex \| 120 \| 4 \| 1 \| 0 \| 0 \| 1 \| 0 \|/);
  assert.match(cli.stdout, /probe file unreadable \(ENOENT\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), cli.stdout);
  const badArgs = spawnSync(process.execPath, ['scripts/perf-bench/aggregate.mjs'], { encoding: 'utf8' });
  assert.equal(badArgs.status, 2);
  assert.match(badArgs.stderr, /^usage:/);
});

test('valid samples ignored by metric selection do not establish measurement evidence', () => {
  for (const ignored of [
    { t: 1500, kind: 'ipc', channel: 'projects:changed', window: 1, count: 1 },
    { ...frame, visible: false, focused: false },
  ]) {
    const absent = report([ignored]);
    assert.equal(absent.runs[0].status, 'incomplete');
    assert.equal(absent.runs[0].metrics, null);
    assert.equal(absent.rows[0].measured, 0);
    assert.equal(absent.runs[0].evidence!.invalid, 0, 'legitimate ignored samples are not malformed');
    const present = report([ignored, frame]);
    assert.equal(present.runs[0].status, 'complete');
    assert.equal(present.rows[0].frameP95, 16);
  }
});
