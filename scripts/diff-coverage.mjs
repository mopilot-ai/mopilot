// Changed-code coverage: every line, branch and function a change touches in a measured source file
// must be executed by the unit tests. Reads the c8 report written by `npm run test:coverage` and
// compares it with the working tree's diff (untracked files included) against the merge base with a
// base ref. `npm run test:coverage -- --changed` runs this after its tests; `npm run test:diff-coverage`
// checks an existing report.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCoreSource } from './rust-coverage.mjs';
import { inHiddenFolder } from './source-tree.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const USAGE = 'Usage: npm run test:diff-coverage -- [--base <ref>] [--coverage <coverage-final.json>]';

/** Added line numbers per file, from `git diff --unified=0` output. */
export function addedLines(diff) {
  /** @type {Map<string, Set<number>>} */
  const files = new Map();
  /** @type {Set<number> | null} */
  let lines = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4);
      lines = name === '/dev/null' ? null : new Set();
      if (lines) files.set(name.replace(/^b\//, ''), lines);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && lines) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) lines.add(n);
    }
  }
  return files;
}

const emptyTotals = () => ({ lines: [0, 0], branches: [0, 0], functions: [0, 0] });

/**
 * Coverage of the changed lines of one file. A location counts when its range contains a changed line,
 * not only when it starts on one: an edit inside a multi-line condition still needs every arm, and an
 * edit inside a function needs the function called. c8 maps statements one per source line, so the
 * line metric is the changed lines that hold executable code.
 */
export function changedFileCoverage(fileCoverage, changed) {
  const totals = emptyTotals();
  const misses = [];
  const touches = (loc) => [...changed].some((line) => loc.start.line <= line && line <= loc.end.line);
  const count = (metric, hits, line, kind) => {
    totals[metric][1]++;
    if (hits > 0) totals[metric][0]++;
    else misses.push({ line, kind });
  };
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(fileCoverage.statementMap))
    for (let line = loc.start.line; line <= loc.end.line; line++)
      if (changed.has(line)) lineHits.set(line, Math.min(lineHits.get(line) ?? Infinity, fileCoverage.s[id]));
  for (const [line, hits] of [...lineHits].sort(([a], [b]) => a - b)) count('lines', hits, line, 'line');
  for (const [id, branch] of Object.entries(fileCoverage.branchMap))
    fileCoverage.b[id].forEach((hits, i) => {
      const loc = branch.locations?.[i] ?? branch.loc;
      if (touches(loc)) count('branches', hits, loc.start.line, 'branch');
    });
  for (const [id, fn] of Object.entries(fileCoverage.fnMap))
    if (touches(fn.loc)) count('functions', fileCoverage.f[id], (fn.decl ?? fn.loc).start.line, 'function');
  misses.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return { totals, misses };
}

/**
 * The measured files a change touches, the covered/total counts over them, and every uncovered location.
 * @param {{ diff: string, untracked?: string[], coverage: Record<string, any>, measured: (file: string) => boolean, repoRoot?: string }} o
 */
export function diffCoverage({ diff, untracked = [], coverage, measured, repoRoot = root }) {
  const changes = addedLines(diff);
  for (const file of untracked) {
    const count = readFileSync(path.join(repoRoot, file), 'utf8').split('\n').length;
    changes.set(file, new Set(Array.from({ length: count }, (_, i) => i + 1)));
  }
  // c8 keys its report by absolute path; each entry also carries it
  const byPath = new Map(Object.entries(coverage).map(([key, entry]) => [entry.path ?? key, entry]));
  /** @type {{ files: string[], totals: ReturnType<typeof emptyTotals>, failures: { file: string, line: number, kind: string }[] }} */
  const report = { files: [], totals: emptyTotals(), failures: [] };
  for (const [file, changed] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = path.join(repoRoot, file);
    if (!changed.size || !measured(abs)) continue;
    report.files.push(file);
    const fileCoverage = byPath.get(abs);
    if (!fileCoverage) {
      report.totals.lines[1] += changed.size;
      report.failures.push({ file, line: Math.min(...changed), kind: 'file missing from the coverage report' });
      continue;
    }
    const { totals, misses } = changedFileCoverage(fileCoverage, changed);
    for (const metric of Object.keys(totals)) for (const i of [0, 1]) report.totals[metric][i] += totals[metric][i];
    for (const m of misses) report.failures.push({ file, ...m });
  }
  return report;
}

/** Whether c8, with the repository's config, measures a file. */
export function measuredBy(config, repoRoot = root) {
  const TestExclude = require('test-exclude');
  const exclude = new TestExclude({
    cwd: repoRoot,
    include: config.include,
    exclude: config.exclude,
    extension: config.extension,
    excludeNodeModules: true,
  });
  return (abs) => exclude.shouldInstrument(abs);
}

/**
 * Check a coverage report against the changes since the merge base of `base` and HEAD. Logs the files
 * in scope, the covered/total counts and any uncovered locations; returns the exit code.
 */
export function checkChanged({ base, coverage, git, log = console.log, repoRoot = root }) {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', mergeBase]);
  // a hidden folder's untracked files are a running test's fixtures (src/.lint-fixture-*), not changes
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter((f) => f && !inHiddenFolder(f));
  const config = JSON.parse(readFileSync(path.join(repoRoot, '.c8rc.json'), 'utf8'));
  const js = measuredBy(config, repoRoot);
  // the Rust core's sources are measured too, from the lcov scripts/rust-coverage.mjs merges into `coverage`
  const measured = (/** @type {string} */ abs) => isCoreSource(path.relative(repoRoot, abs).split(path.sep).join('/')) || js(abs);
  const report = diffCoverage({ diff, untracked, coverage, measured, repoRoot });
  log(`Changed sources since ${base}: ${report.files.length ? report.files.join(', ') : 'none'}`);
  for (const [metric, [covered, total]] of Object.entries(report.totals)) log(`Changed ${metric}: ${covered}/${total} (100% required)`);
  if (!report.failures.length) return 0;
  log(`${report.failures.length} uncovered locations on changed lines:`);
  for (const f of report.failures) log(`  ${f.file}:${f.line}  ${f.kind}`);
  log('Add unit tests that execute these lines (see docs/unit-coverage.md).');
  return 1;
}

export function parseArgs(args) {
  const opts = { base: 'origin/main', coverage: 'coverage/unit/coverage-final.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    const key = { '--base': 'base', '--coverage': 'coverage' }[args[i]];
    if (!key || args[i + 1] === undefined) throw new Error(`${USAGE} (got ${args[i]})`);
    opts[key] = args[++i];
  }
  return opts;
}

export function run(
  args,
  { git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }), log = console.log, repoRoot = root } = {},
) {
  const opts = parseArgs(args);
  const coverage = JSON.parse(readFileSync(path.resolve(repoRoot, opts.coverage), 'utf8'));
  return checkChanged({ base: opts.base, coverage, git, log, repoRoot });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
