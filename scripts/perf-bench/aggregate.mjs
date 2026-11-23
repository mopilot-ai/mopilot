// The streaming benchmark's report: reads the probe samples of each measured cell, computes measurement.md's columns, takes the median of the repeats, and writes runs.json and the Markdown table.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ scenario: string, variant: string, rate: number, chunk: number, rep: number, from: number, to: number,
 *             probe: string, chats: number, error?: string }} Cell
 *   from/to: the cell's time window (ms epoch); probe: the instance's probe file, relative to the run folder
 * @typedef {{ t: number, kind: string } & Record<string, any>} Sample
 * @typedef {{ samples: Sample[], skipped: number, error?: string }} ProbeRead
 */

/** The `p`th percentile (0–100) by nearest rank; null for no values. */
export function percentile(/** @type {number[]} */ values, /** @type {number} */ p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
export const median = (/** @type {number[]} */ values) => percentile(values, 50);

/**
 * The JSON lines of a probe file, and how many lines did not parse (a write cut short when the instance quit): those
 * are counted for the report, and the rest of the file is still read.
 */
export function readSamples(/** @type {string} */ text) {
  /** @type {Sample[]} */
  const samples = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { samples, skipped };
}

/** The adapters' channels to windows (electron/app/windows.cjs); other IPC is not the stream's. */
const STREAM_CHANNELS = new Set(['codex:item', 'claude:event', 'acp:event']);

/** Sums `count` by a key, as a rate per second over `seconds`; the largest. */
function maxRate(/** @type {Sample[]} */ list, /** @type {(s: Sample) => unknown} */ keyOf, /** @type {number} */ seconds) {
  const sums = new Map();
  for (const s of list) sums.set(keyOf(s), (sums.get(keyOf(s)) ?? 0) + s.count);
  return sums.size ? Math.max(...sums.values()) / seconds : null;
}

/**
 * measurement.md's columns for one cell's samples.
 * @param {Sample[]} all the instance's samples
 * @param {Pick<Cell, 'from' | 'to'>} cell
 */
export function metrics(all, { from, to }) {
  const seconds = Math.max(0.001, (to - from) / 1000);
  const s = all.filter((x) => x.t >= from && x.t <= to);
  const of = (/** @type {string} */ kind) => s.filter((x) => x.kind === kind);
  const raw = of('raw');
  const frames = of('frame');
  // the window the user looks at: visible and focused; a run in background mode focuses no window, so visible
  const focused = frames.filter((f) => f.visible && f.focused);
  const active = focused.length ? focused : frames.filter((f) => f.visible);
  const writes = of('write');
  return {
    rawPerSec: raw.length ? raw.reduce((n, x) => n + x.count, 0) / seconds : null,
    ipcPerSecPerWindow: maxRate(
      of('ipc').filter((x) => STREAM_CHANNELS.has(x.channel)),
      (x) => x.window,
      seconds,
    ),
    commitsPerSecPerThread: maxRate(of('commit'), (x) => x.thread, seconds),
    frameP95: percentile(
      active.map((f) => f.ms),
      95,
    ),
    frameWindow: focused.length ? 'focused' : 'visible',
    longTasksPerMin: (of('longtask').length / seconds) * 60,
    reactP95: percentile(
      of('react').map((x) => x.ms),
      95,
    ),
    loopP95: percentile(
      of('loop').map((x) => x.p95),
      95,
    ),
    writeP95: percentile(
      writes.map((x) => x.ms),
      95,
    ),
    queueMax: writes.length ? Math.max(...writes.map((x) => x.queue ?? x.records)) : null,
    firstToken: median(of('firstToken').map((x) => x.ms)),
    ...revealCadence(of('reveal'), seconds),
  };
}

/** Longer than this between two reveal steps is a pause in the reply (a tool call, the next turn), not a stall. */
const PAUSE_MS = 2000;
/** Longer than this between two reveal steps, with the reply still going, reads as text stopping: two of the pacer's longest steps. */
export const STALL_MS = 300;

/**
 * How evenly a streaming reply showed: the 95th percentile of the time between reveal steps, and how often per
 * minute text stopped for longer than STALL_MS while the reply went on.
 * @param {Sample[]} reveals
 * @param {number} seconds
 */
export function revealCadence(reveals, seconds) {
  const gaps = [];
  for (let i = 1; i < reveals.length; i++) {
    const gap = reveals[i].t - reveals[i - 1].t;
    if (gap < PAUSE_MS) gaps.push(gap);
  }
  return {
    revealGapP95: percentile(gaps, 95),
    revealStallsPerMin: reveals.length ? (gaps.filter((g) => g > STALL_MS).length / seconds) * 60 : null,
  };
}

/** Columns of the table: the field, its heading, and its decimals. */
export const COLUMNS = /** @type {const} */ ([
  ['rawPerSec', 'raw/s', 0],
  ['ipcPerSecPerWindow', 'ipc/s per window', 0],
  ['commitsPerSecPerThread', 'commits/s per thread', 0],
  ['frameP95', 'frame p95 (ms)', 1],
  ['longTasksPerMin', 'long tasks/min', 1],
  ['reactP95', 'React commit p95 (ms)', 1],
  ['loopP95', 'main loop p95 (ms)', 1],
  ['writeP95', 'write p95 (ms)', 1],
  ['queueMax', 'queue max', 0],
  ['firstToken', 'first token (ms)', 0],
  ['revealGapP95', 'reveal gap p95 (ms)', 0],
  ['revealStallsPerMin', 'reveal stalls/min', 1],
]);

/** Numeric payload used by each measured sample; unknown diagnostic kinds never establish evidence. */
const VALUE_FIELDS = new Map([
  ['raw', 'count'],
  ['ipc', 'count'],
  ['commit', 'count'],
  ['frame', 'ms'],
  ['longtask', 'ms'],
  ['react', 'ms'],
  ['loop', 'p95'],
  ['write', 'ms'],
  ['firstToken', 'ms'],
  ['reveal', 'chars'],
  ['dropped', 'count'],
]);
const nonnegative = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** A report can retain partial measurements without counting their attempt as complete evidence. */
function measuredRun(/** @type {Cell} */ cell, /** @type {(probe: string) => Sample[] | ProbeRead} */ samplesOf) {
  if (cell.error) return { ...cell, status: 'failed', metrics: null, evidence: null };
  const loaded = samplesOf(cell.probe);
  const read = Array.isArray(loaded) ? { samples: loaded, skipped: 0 } : loaded;
  let invalid = 0;
  const valid = read.samples.filter((sample) => {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample) || !Number.isFinite(sample.t) || typeof sample.kind !== 'string') {
      invalid++;
      return false;
    }
    const field = VALUE_FIELDS.get(sample.kind);
    if (
      (field && !nonnegative(sample[field])) ||
      (sample.kind === 'frame' && (typeof sample.visible !== 'boolean' || typeof sample.focused !== 'boolean')) ||
      (sample.kind === 'write' && (!nonnegative(sample.records) || (sample.queue != null && !nonnegative(sample.queue)))) ||
      (sample.kind === 'commit' && typeof sample.thread !== 'string') ||
      (sample.kind === 'ipc' && (typeof sample.channel !== 'string' || !(typeof sample.window === 'string' || nonnegative(sample.window))))
    ) {
      invalid++;
      return false;
    }
    return true;
  });
  const inside = valid.filter((sample) => sample.t >= cell.from && sample.t <= cell.to);
  const measured = inside.filter(
    (sample) =>
      VALUE_FIELDS.has(sample.kind) &&
      sample.kind !== 'dropped' &&
      (sample.kind !== 'ipc' || STREAM_CHANNELS.has(sample.channel)) &&
      (sample.kind !== 'frame' || sample.visible),
  );
  // Drop markers are timestamped at flush, not at loss. The file cannot locate lost samples in a cell.
  const dropped = valid.filter((sample) => sample.kind === 'dropped').reduce((n, sample) => n + sample.count, 0);
  const reasons = [];
  if (read.error) reasons.push(read.error);
  if (read.skipped) reasons.push(`${read.skipped} unreadable probe lines`);
  if (invalid) reasons.push(`${invalid} invalid probe samples`);
  if (dropped) reasons.push(`${dropped} dropped samples in the probe file; loss timestamps unavailable`);
  if (!measured.length) reasons.push('no usable measurement samples in the cell');
  return {
    ...cell,
    status: reasons.length ? 'incomplete' : 'complete',
    metrics: measured.length ? metrics(measured, cell) : null,
    evidence: {
      samples: measured.length,
      skipped: read.skipped,
      invalid,
      dropped,
      reasons,
      longTasks: {
        recordedEvents: measured.filter((sample) => sample.kind === 'longtask').length,
        observerAvailability: 'unknown',
        observationCoverage: 'unknown',
      },
    },
  };
}

/**
 * Each cell's metrics, then the median over its repeats.
 * @param {Cell[]} cells
 * @param {(probe: string) => Sample[] | ProbeRead} samplesOf the samples and availability of a cell's probe file
 */
export function aggregate(cells, samplesOf) {
  const runs = cells.map((c) => measuredRun(c, samplesOf));
  /** @type {Map<string, typeof runs>} */
  const groups = new Map();
  for (const r of runs) {
    const k = JSON.stringify([r.scenario, r.variant, r.rate, r.chunk]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows = [...groups.values()].map((g) => {
    const measured = g.filter((r) => r.metrics);
    /** @type {Record<string, number | null>} */
    const m = {};
    /** @type {Record<string, number>} */
    const metricRuns = {};
    for (const [field] of COLUMNS) {
      const values = measured.map((r) => /** @type {any} */ (r.metrics)[field]).filter((v) => v !== null);
      m[field] = median(values);
      metricRuns[field] = values.length;
    }
    const { scenario, variant, rate, chunk } = g[0];
    /** @type {{ scenario: string, variant: string, rate: number, chunk: number, runs: number, failed: number } & Record<string, any>} */
    const row = {
      scenario,
      variant,
      rate,
      chunk,
      attempted: g.length,
      measured: measured.length,
      runs: g.filter((r) => r.status === 'complete').length,
      failed: g.filter((r) => r.status === 'failed').length,
      incomplete: g.filter((r) => r.status === 'incomplete').length,
      metricRuns,
      ...m,
    };
    return row;
  });
  return { runs, rows };
}

const fmt = (/** @type {number | null} */ v, /** @type {number} */ digits) => (v === null || v === undefined ? '–' : v.toFixed(digits));

/** The Markdown report: one table per scenario, a row per variant, rate and chunk size. */
export function table(/** @type {ReturnType<typeof aggregate>['rows']} */ rows) {
  const out = [];
  for (const scenario of [...new Set(rows.map((r) => r.scenario))]) {
    out.push(`### ${scenario}`, '');
    out.push(
      `| variant | tok/s | chunk | attempted | measured | complete | incomplete | failed | ${COLUMNS.map((c) => c[1]).join(' | ')} |`,
    );
    out.push(`| --- | --- | --- | --- | --- | --- | --- | --- | ${COLUMNS.map(() => '---').join(' | ')} |`);
    for (const r of rows.filter((x) => x.scenario === scenario)) {
      out.push(
        `| ${r.variant} | ${r.rate} | ${r.chunk} | ${r.attempted} | ${r.measured} | ${r.runs} | ${r.incomplete} | ${r.failed} | ${COLUMNS.map(([f, , d]) => fmt(/** @type {any} */ (r)[f], d)).join(' | ')} |`,
      );
    }
    out.push('');
  }
  out.push(
    'Metrics retain usable samples from incomplete attempts. Complete counts indicate no detected evidence loss, not that every metric was collected or acceptance targets passed.',
    'The long-task rate counts recorded events only. Zero means no recorded events; observer availability and observation coverage are unknown. metricRuns counts numeric contributors, not verified observation spans.',
  );
  return out.join('\n');
}

/**
 * Reads a run folder's cells.json and probe files; writes runs.json and summary.md there. Returns the table.
 * @param {string} dir
 */
export function aggregateRun(dir) {
  /** @type {Cell[]} */
  const cells = JSON.parse(fs.readFileSync(path.join(dir, 'cells.json'), 'utf8'));
  /** @type {Map<string, ProbeRead>} */
  const cache = new Map();
  const read = (/** @type {string} */ probe) => {
    if (!cache.has(probe)) {
      const file = path.join(dir, probe);
      try {
        cache.set(probe, readSamples(fs.readFileSync(file, 'utf8')));
      } catch (error) {
        cache.set(probe, {
          samples: [],
          skipped: 0,
          error: `probe file unreadable (${/** @type {NodeJS.ErrnoException | null} */ (error)?.code ?? 'unknown'})`,
        });
      }
    }
    return /** @type {ProbeRead} */ (cache.get(probe));
  };
  const result = aggregate(cells, read);
  /** probe files with lines that did not parse, and how many */
  const unreadable = Object.fromEntries([...cache].filter(([, r]) => r.skipped).map(([probe, r]) => [probe, r.skipped]));
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify({ ...result, unreadable }, null, 2));
  const notes = Object.entries(unreadable).map(([probe, n]) => `${probe}: unreadable lines skipped: ${n}`);
  const incomplete = result.runs
    .filter((r) => r.status === 'incomplete')
    .map(
      (r) =>
        `${r.scenario}/${r.variant} ${r.rate}×${r.chunk} repeat ${r.rep}, ${r.probe}: ${/** @type {NonNullable<typeof r.evidence>} */ (r.evidence).reasons.join('; ')}`,
    );
  const md = [table(result.rows), ...notes, ...incomplete].join('\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), `${md}\n`);
  return md;
}

/**
 * `node scripts/perf-bench/aggregate.mjs <run folder>`: reports a finished run again.
 * @param {string[]} [argv]
 * @param {{ log: (s: string) => void, error: (s: string) => void }} [out]
 */
export function main(argv = process.argv.slice(2), out = console) {
  if (argv.length !== 1) {
    out.error('usage: node scripts/perf-bench/aggregate.mjs <run folder>');
    return 2;
  }
  out.log(aggregateRun(argv[0]));
  return 0;
}

if (import.meta.url === pathToFileURL(String(process.argv[1])).href) process.exitCode = main();
