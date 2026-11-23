// Turns per-task result records into the arm x benchmark summary table, and compares two runs (before and after a
// change) per arm and benchmark, listing every task that flipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BENCH_NAMES } from './config.mjs';

/**
 * Every result record of a run folder (results/<run>), by arm. Only <task>.json files count; .finish.json and other
 * side files are skipped.
 * @param {string} runDir
 * @returns {Record<string, any[]>}
 */
export function loadRun(runDir) {
  if (!existsSync(runDir)) throw new Error(`no results at ${runDir}`);
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const arm of readdirSync(runDir, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    const dir = path.join(runDir, arm.name);
    out[arm.name] = readdirSync(dir)
      .filter((f) => /^[^.]+\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  }
  return out;
}

/** @param {number[]} xs */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const secs = (/** @type {number | null} */ v) => (v === null ? '-' : String(Math.round(v / 1000)));

/**
 * One arm on one benchmark: passes over gradable, supported tasks; medians of wall time; and the counts that
 * explain the rest.
 * @param {any[]} records
 */
export function stats(records) {
  const unsupported = records.filter((r) => r.unsupported).length;
  const graded = records.filter((r) => !r.unsupported && r.gradable !== false);
  const passes = graded.filter((r) => r.success);
  const walls = (rs) => rs.map((r) => r.wallMs).filter((w) => typeof w === 'number');
  return {
    total: records.length,
    graded: graded.length,
    passes: passes.length,
    rate: graded.length ? passes.length / graded.length : null,
    medianWall: median(walls(graded)),
    medianWallPasses: median(walls(passes)),
    unsupported,
    ungradable: records.length - unsupported - graded.length,
    timeouts: graded.filter((r) => r.timeout).length,
    shell: records.filter((r) => r.shellUsed).length,
    script: records.filter((r) => r.scriptUsed).length,
  };
}

const pct = (/** @type {number | null} */ r) => (r === null ? '-' : `${Math.round(100 * r)}%`);

/**
 * A record's benchmark. Records from before the field existed (the smoke1 baseline) are told apart by their task id:
 * MacArena ids are 8 hex digits, REAL ids end in -<number>, and the rest are WebGames.
 * @param {any} r
 */
export const benchOf = (r) => r.bench ?? (/^[0-9a-f]{8}$/.test(r.task) ? 'mac' : /^[a-z]+-\d+$/.test(r.task) ? 'real' : 'wg');

/** Records grouped by benchmark, in the order wg, real, mac. @param {any[]} records */
function byBench(records) {
  return Object.keys(BENCH_NAMES)
    .map((b) => /** @type {[string, any[]]} */ ([b, records.filter((r) => benchOf(r) === b)]))
    .filter(([, rs]) => rs.length);
}

/** The markdown summary table of a run. @param {Record<string, any[]>} run */
export function summaryTable(run) {
  const rows = [
    '| Arm | Benchmark | Pass | Pass rate | Median wall, graded (s) | Median wall, passes (s) | Unsupported | Ungradable | Timeouts | Shell used | Page script used |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [arm, records] of Object.entries(run)) {
    for (const [bench, rs] of byBench(records)) {
      const s = stats(rs);
      rows.push(
        `| ${arm} | ${BENCH_NAMES[bench]} (${s.total}) | ${s.passes}/${s.graded} | ${pct(s.rate)} | ${secs(s.medianWall)} | ${secs(s.medianWallPasses)} | ${s.unsupported} | ${s.ungradable} | ${s.timeouts} | ${s.shell} | ${s.script} |`,
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

/** A task's outcome as one word: PASS, fail, ungradable or unsupported. @param {any} r */
export const outcome = (r) => (r.unsupported ? 'unsupported' : r.gradable === false ? 'ungradable' : r.success ? 'PASS' : 'fail');

const signed = (/** @type {number} */ n, unit = '') => `${n > 0 ? '+' : ''}${n}${unit}`;

/**
 * Before/after comparison for a pull request: per arm and benchmark both pass counts, the change in pass rate and
 * median wall time, then every task whose outcome changed. Arms or benchmarks only one run has are listed as such.
 * @param {Record<string, any[]>} before @param {Record<string, any[]>} after
 */
export function compareRuns(before, after) {
  const rows = ['| Arm | Benchmark | Before | After | Pass rate change | Median wall change (s) |', '|---|---|---|---|---|---|'];
  const flips = [];
  for (const arm of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[arm] ?? [];
    const a = after[arm] ?? [];
    for (const bench of Object.keys(BENCH_NAMES)) {
      const rb = b.filter((r) => benchOf(r) === bench);
      const ra = a.filter((r) => benchOf(r) === bench);
      if (!rb.length && !ra.length) continue;
      const sb = stats(rb);
      const sa = stats(ra);
      const rate = sb.rate !== null && sa.rate !== null ? signed(Math.round(100 * (sa.rate - sb.rate)), ' pts') : '-';
      const wall = sb.medianWall !== null && sa.medianWall !== null ? signed(Math.round((sa.medianWall - sb.medianWall) / 1000)) : '-';
      const side = (/** @type {any[]} */ rs, /** @type {ReturnType<typeof stats>} */ s) =>
        rs.length ? `${s.passes}/${s.graded}` : 'not run';
      rows.push(`| ${arm} | ${BENCH_NAMES[bench]} | ${side(rb, sb)} | ${side(ra, sa)} | ${rate} | ${wall} |`);
      const old = new Map(rb.map((r) => [r.task, r]));
      for (const r of ra) {
        const prev = old.get(r.task);
        if (prev && outcome(prev) !== outcome(r))
          flips.push(`- ${arm} ${r.task}: ${outcome(prev)} -> ${outcome(r)}${r.notes ? ` (${r.notes})` : ''}`);
      }
    }
  }
  return `${rows.join('\n')}\n\n${flips.length ? `Changed tasks:\n${flips.join('\n')}` : 'No task changed outcome.'}\n`;
}
