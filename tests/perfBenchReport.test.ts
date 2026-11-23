// The streaming benchmark's scenarios and report (scripts/perf-bench/scenarios.mjs, aggregate.mjs): S1 to S7 as plans and
// cells, measurement.md's columns from probe samples, the median of repeats, and the Markdown table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHUNKS, FAMILIES, RATES, REPEATS, SCENARIO_IDS, cells, plans, sendOrder } from '../scripts/perf-bench/scenarios.mjs';
import { aggregate, aggregateRun, main, median, metrics, percentile, readSamples, table } from '../scripts/perf-bench/aggregate.mjs';

test('the seven scenarios as measurement.md lists them', () => {
  assert.deepEqual(SCENARIO_IDS, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  const all = plans(SCENARIO_IDS);
  const shape = (id: string) =>
    all
      .filter((p) => p.id === id)
      .map((p) => [
        p.variant,
        p.chats.map((c) => `${c.family}${c.switchTo ? `>${c.switchTo}` : ''}:${c.role}`).join(' '),
        p.turns,
        p.bytes,
        p.toolEveryMs,
      ]);
  assert.deepEqual(
    shape('S1'),
    FAMILIES.map((f) => [f, `${f}:active`, 30, 4096, 0]),
  );
  assert.deepEqual(
    shape('S2'),
    FAMILIES.map((f) => [f, `${f}:sidebar ${f}:active`, 30, 4096, 0]),
  );
  assert.deepEqual(shape('S3'), [['mixed', 'codex:sidebar claude:sidebar acp:sidebar codex:active', 30, 4096, 0]]);
  assert.deepEqual(shape('S4'), [['switched', 'acp:sidebar codex>claude:active', 30, 4096, 0]]);
  assert.deepEqual(
    shape('S5'),
    FAMILIES.map((f) => [f, `${f}:active`, 300, 20_480, 0]),
  );
  assert.deepEqual(
    shape('S6'),
    FAMILIES.map((f) => [f, `${f}:active ${f}:window2`, 30, 4096, 0]),
  );
  assert.deepEqual(shape('S7'), [['acp', 'acp:sidebar acp:sidebar acp:sidebar acp:active', 30, 4096, 200]]);
  assert.deepEqual(
    plans(['S5'], { turnsScale: 0.1 }).map((p) => p.turns),
    [30, 30, 30],
  );
  assert.equal(plans(['S1'], { turnsScale: 0.001 })[0].turns, 1);
  assert.throws(() => plans(['S9']), /Unknown scenario: S9/);
});

test('each plan runs every rate and chunk size three times, and the active chat is sent its message last', () => {
  assert.deepEqual([RATES, CHUNKS, REPEATS], [[40, 120], [4, 32], 3]);
  assert.equal(cells().length, 12);
  assert.deepEqual(cells({ rates: [40], chunks: [4], repeats: 2 }), [
    { rate: 40, chunk: 4, rep: 0 },
    { rate: 40, chunk: 4, rep: 1 },
  ]);
  const order = sendOrder([
    { family: 'codex', role: 'active' },
    { family: 'acp', role: 'sidebar' },
    { family: 'claude', role: 'window2' },
  ]);
  assert.deepEqual(
    order.map((o) => o.i),
    [1, 2, 0],
  );
});

test('percentiles by nearest rank, and no value for no samples', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(median([4, 2]), 2);
});

test('probe files are read line by line, skipping a line cut short', () => {
  assert.deepEqual(readSamples('{"t":1,"kind":"loop"}\n\n{"t":2,"ki\n{"t":3,"kind":"frame"}\n'), {
    samples: [
      { t: 1, kind: 'loop' },
      { t: 3, kind: 'frame' },
    ],
    skipped: 1,
  });
});

/** Two seconds of samples, plus some outside the window. */
const SAMPLES = [
  { t: 500, kind: 'raw', harness: 'codex', chat: 'a', count: 999 },
  { t: 1000, kind: 'raw', harness: 'codex', chat: 'a', count: 100 },
  { t: 2000, kind: 'raw', harness: 'acp', chat: 'b', count: 60 },
  { t: 1000, kind: 'ipc', channel: 'codex:item', window: 1, count: 100 },
  { t: 2000, kind: 'ipc', channel: 'acp:event', window: 1, count: 60 },
  { t: 2000, kind: 'ipc', channel: 'acp:event', window: 2, count: 60 },
  { t: 2000, kind: 'ipc', channel: 'projects:changed', window: 1, count: 500 },
  { t: 1500, kind: 'commit', thread: 'a', count: 50, window: 1 },
  { t: 2500, kind: 'commit', thread: 'a', count: 70, window: 1 },
  { t: 2500, kind: 'commit', thread: 'b', count: 10, window: 1 },
  ...[10, 20, 30, 40].map((ms, i) => ({ t: 1100 + i, kind: 'frame', ms, visible: true, focused: true })),
  { t: 1200, kind: 'frame', ms: 500, visible: true, focused: false },
  { t: 1300, kind: 'frame', ms: 900, visible: false, focused: false },
  { t: 1400, kind: 'longtask', ms: 60 },
  { t: 1400, kind: 'react', ms: 4 },
  { t: 1400, kind: 'react', ms: 8 },
  { t: 1000, kind: 'loop', p50: 1, p95: 3, p99: 4, max: 5 },
  { t: 2000, kind: 'loop', p50: 1, p95: 12, p99: 14, max: 20 },
  { t: 1700, kind: 'write', chat: 'b', records: 4, bytes: 100, ms: 2, reason: 'timer', queue: 9 },
  { t: 1800, kind: 'write', chat: 'b', records: 7, bytes: 100, ms: 6, reason: 'flush' },
  { t: 1100, kind: 'firstToken', chat: 'a', ms: 30 },
  { t: 2100, kind: 'firstToken', chat: 'b', ms: 50 },
  { t: 2900, kind: 'firstToken', chat: 'c', ms: 70 },
];

test('a cell’s columns come from its own window of samples', () => {
  const m = metrics(SAMPLES, { from: 1000, to: 3000 });
  assert.deepEqual(m, {
    rawPerSec: 80,
    ipcPerSecPerWindow: 80,
    commitsPerSecPerThread: 60,
    frameP95: 40,
    frameWindow: 'focused',
    longTasksPerMin: 30,
    reactP95: 8,
    loopP95: 12,
    writeP95: 6,
    queueMax: 9,
    firstToken: 50,
    revealGapP95: null,
    revealStallsPerMin: null,
  });
});

test('reveal cadence: the gaps between reveal steps, stalls past STALL_MS, pauses past 2 s left out', () => {
  const at = (t: number) => ({ t, kind: 'reveal', chars: 20 });
  const m = metrics([at(0), at(50), at(100), at(500), at(550), at(5000), at(5050)], { from: 0, to: 60000 });
  assert.equal(m.revealGapP95, 400);
  // one stop longer than STALL_MS (400 ms) in a minute; the 4.45 s pause is a pause, not a stall
  assert.equal(m.revealStallsPerMin, 1);
});

test('with no focused window (a background run) frames of visible windows count; missing samples are no value', () => {
  const m = metrics(
    [
      { t: 1, kind: 'frame', ms: 16, visible: true, focused: false },
      { t: 1, kind: 'frame', ms: 99, visible: false, focused: false },
    ],
    { from: 0, to: 2000 },
  );
  assert.equal(m.frameP95, 16);
  assert.equal(m.frameWindow, 'visible');
  assert.equal(m.rawPerSec, null);
  assert.equal(m.ipcPerSecPerWindow, null);
  assert.equal(m.writeP95, null);
  assert.equal(m.queueMax, null);
  assert.equal(m.firstToken, null);
  assert.equal(m.longTasksPerMin, 0);
});

test('repeats are reduced to their median, failed runs are left out and counted, and the table has a row per cell', () => {
  const base = { scenario: 'S1', variant: 'codex', rate: 40, chunk: 4, chats: 1 };
  const cellsIn = [
    { ...base, rep: 0, from: 1000, to: 3000, probe: 'p1' },
    { ...base, rep: 1, from: 1000, to: 2000, probe: 'p1' },
    { ...base, rep: 2, from: 0, to: 0, probe: 'p1', error: 'timed out' },
    { ...base, rate: 120, rep: 0, from: 0, to: 0, probe: 'p1', error: 'timed out' },
    { ...base, scenario: 'S7', variant: 'acp', rep: 0, from: 1000, to: 3000, probe: 'p2' },
  ];
  const seen: string[] = [];
  const { runs, rows } = aggregate(cellsIn, (p: string) => (seen.push(p), p === 'p1' ? SAMPLES : []));
  assert.equal(runs.length, 5);
  assert.equal(runs[2].metrics, null);
  assert.deepEqual(seen, ['p1', 'p1', 'p2']);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].runs, rows[0].failed, rows[0].firstToken], [2, 1, 30]);
  assert.deepEqual([rows[1].runs, rows[1].failed, rows[1].rawPerSec], [0, 1, null]);
  const md = table(rows);
  assert.match(
    md,
    /^### S1\n\n\| variant \| tok\/s \| chunk \| attempted \| measured \| complete \| incomplete \| failed \| raw\/s \| ipc\/s per window \|/,
  );
  assert.match(md, /\| codex \| 40 \| 4 \| 3 \| 2 \| 2 \| 0 \| 1 \| /);
  assert.match(md, /\| codex \| 120 \| 4 \| 1 \| 0 \| 0 \| 0 \| 1 \| – \| – \|/);
  assert.match(md, /### S7\n\n.*\n.*\n\| acp \| 40 \| 4 \| 1 \| 0 \| 0 \| 1 \| 0 \| – \|/);
});

test('a run folder is reported from its cells.json and probe files, and the command says how to call it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-report-'));
  fs.mkdirSync(path.join(dir, 'S1', 'perf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'S1', 'perf', 'r.jsonl'), `${SAMPLES.map((s) => JSON.stringify(s)).join('\n')}\n{"t":9,`);
  const base = { scenario: 'S1', variant: 'codex', rate: 40, chunk: 4, chats: 1, from: 1000, to: 3000 };
  fs.writeFileSync(
    path.join(dir, 'cells.json'),
    JSON.stringify([
      { ...base, rep: 0, probe: 'S1/perf/r.jsonl' },
      { ...base, rep: 1, probe: 'S1/perf/r.jsonl' },
      { ...base, rep: 2, probe: 'missing.jsonl' },
    ]),
  );
  const logged: string[] = [];
  const errors: string[] = [];
  const out = { log: (s: string) => logged.push(s), error: (s: string) => errors.push(s) };
  assert.equal(main([dir], out), 0);
  assert.match(logged[0], /\| codex \| 40 \| 4 \| 3 \| 2 \| 0 \| 3 \| 0 \| 80 \|/);
  assert.equal(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), `${logged[0]}\n`);
  const runs = JSON.parse(fs.readFileSync(path.join(dir, 'runs.json'), 'utf8'));
  assert.equal(runs.rows.length, 1);
  assert.deepEqual(runs.unreadable, { 'S1/perf/r.jsonl': 1 });
  assert.match(logged[0], /\nS1\/perf\/r\.jsonl: unreadable lines skipped: 1\n/);
  assert.equal(aggregateRun(dir), logged[0]);
  assert.equal(main([], out), 2);
  assert.match(errors[0], /^usage: /);
});
