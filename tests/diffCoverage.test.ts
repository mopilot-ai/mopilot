// The one changed-code coverage check (scripts/diff-coverage.mjs), used by `npm run test:coverage -- --changed`
// and `npm run test:diff-coverage`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addedLines, changedFileCoverage, checkChanged, diffCoverage, measuredBy, parseArgs, run } from '../scripts/diff-coverage.mjs';

const loc = (line: number, end = line) => ({ start: { line, column: 0 }, end: { line: end, column: 1 } });
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,0 +2,3 @@',
  '+one',
  '+two',
  '+three',
  '@@ -9 +12 @@',
  '-old',
  '+new',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -3 +2,0 @@',
].join('\n');

test('added lines come from each hunk, skipping deletions and deleted files', () => {
  const files = addedLines(DIFF);
  assert.deepEqual([...files.keys()], ['src/a.ts', 'src/b.ts']);
  assert.deepEqual([...files.get('src/a.ts')!], [2, 3, 4, 12]);
  assert.equal(files.get('src/b.ts')!.size, 0);
});

test('a changed line counts every location whose range contains it: lines, every branch arm, enclosing functions', () => {
  const coverage = {
    // line 3 holds two statements, one never run; line 9 is changed but holds no code
    statementMap: { 0: loc(2), 1: loc(3), 2: loc(3), 3: loc(5), 4: loc(20) },
    s: { 0: 1, 1: 1, 2: 0, 3: 0, 4: 0 },
    fnMap: {
      // a function declared before the change, whose body the change edits
      0: { decl: loc(1), loc: loc(1, 6) },
      1: { loc: loc(5) },
      2: { loc: loc(20, 22) },
    },
    f: { 0: 1, 1: 0, 2: 0 },
    branchMap: {
      // a multi-line condition edited on its second line: both arms count
      0: { loc: loc(4, 6), locations: [loc(4, 5), loc(6)] },
      // c8's single-location branches use loc
      1: { loc: loc(2, 3) },
      2: { loc: loc(30), locations: [loc(30)] },
    },
    b: { 0: [0, 3], 1: [2], 2: [0] },
  };
  assert.deepEqual(changedFileCoverage(coverage, new Set([2, 3, 5, 9])), {
    totals: { lines: [1, 3], branches: [1, 2], functions: [1, 2] },
    misses: [
      { line: 3, kind: 'line' },
      { line: 4, kind: 'branch' },
      { line: 5, kind: 'function' },
      { line: 5, kind: 'line' },
    ],
  });
  // deleted or unchanged code is not in scope
  assert.deepEqual(changedFileCoverage(coverage, new Set()), {
    totals: { lines: [0, 0], branches: [0, 0], functions: [0, 0] },
    misses: [],
  });
});

test('diff coverage covers measured, changed and untracked files and flags missing reports', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'diffcov-'));
  mkdirSync(path.join(repoRoot, 'src'));
  writeFileSync(path.join(repoRoot, 'src/new.ts'), 'a\nb');
  const abs = (f: string) => path.join(repoRoot, f);
  const covered = {
    statementMap: { 0: loc(2), 1: loc(3), 2: loc(4), 3: loc(12) },
    s: { 0: 1, 1: 1, 2: 1, 3: 0 },
    fnMap: { 0: { loc: loc(2, 4) } },
    f: { 0: 1 },
    branchMap: {},
    b: {},
  };
  const report = diffCoverage({
    diff: DIFF + '\n--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1 @@\n+doc',
    untracked: ['src/new.ts'],
    coverage: { [abs('src/a.ts')]: covered },
    measured: (file: string) => file.startsWith(abs('src/')),
    repoRoot,
  });
  assert.deepEqual(report, {
    files: ['src/a.ts', 'src/new.ts'],
    totals: { lines: [3, 6], branches: [0, 0], functions: [1, 1] },
    failures: [
      { file: 'src/a.ts', line: 12, kind: 'line' },
      { file: 'src/new.ts', line: 1, kind: 'file missing from the coverage report' },
    ],
  });
});

test('the measured set follows the c8 config', () => {
  const measured = measuredBy({ include: ['src/**'], exclude: ['src/protocol/**', '**/*.d.ts'], extension: ['.ts', '.tsx'] }, '/repo');
  assert.equal(measured('/repo/src/lib/a.ts'), true);
  assert.equal(measured('/repo/src/components/A.tsx'), true);
  assert.equal(measured('/repo/src/protocol/a.ts'), false);
  assert.equal(measured('/repo/src/types.d.ts'), false);
  assert.equal(measured('/repo/tests/a.test.ts'), false);
  assert.equal(measured('/repo/src/a.md'), false);
});

test('arguments pick the base ref and report, and reject anything else', () => {
  assert.deepEqual(parseArgs([]), { base: 'origin/main', coverage: 'coverage/unit/coverage-final.json' });
  assert.deepEqual(parseArgs(['--', '--base', 'main', '--coverage', 'x.json']), { base: 'main', coverage: 'x.json' });
  assert.throws(() => parseArgs(['--base']), /Usage/);
  assert.throws(() => parseArgs(['--what', 'x']), /Usage/);
});

function fixtureRepo() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'diffcov-run-'));
  writeFileSync(path.join(repoRoot, '.c8rc.json'), JSON.stringify({ include: ['src/**'], extension: ['.ts'] }));
  const file = path.join(repoRoot, 'src/a.ts');
  const coverage = (hits: number) => ({
    [file]: {
      statementMap: { 0: loc(2), 1: loc(3), 2: loc(4), 3: loc(12) },
      s: { 0: 1, 1: hits, 2: hits, 3: hits },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    },
  });
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    return { 'merge-base': 'abc123\n', diff: DIFF, 'ls-files': '' }[args[0]]!;
  };
  return { repoRoot, coverage, calls, git };
}

test('the check compares the working tree with the merge base, prints the counts and explains failures', () => {
  const { repoRoot, coverage, calls, git } = fixtureRepo();
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  assert.equal(checkChanged({ base: 'main', coverage: coverage(0), git, log, repoRoot }), 1);
  assert.deepEqual(
    calls.map((c) => c.slice(0, 2)),
    [
      ['merge-base', 'main'],
      ['diff', '--unified=0'],
      ['ls-files', '--others'],
    ],
  );
  assert.ok(calls[1].includes('abc123'));
  assert.deepEqual(lines, [
    'Changed sources since main: src/a.ts',
    'Changed lines: 1/4 (100% required)',
    'Changed branches: 0/0 (100% required)',
    'Changed functions: 0/0 (100% required)',
    '3 uncovered locations on changed lines:',
    '  src/a.ts:3  line',
    '  src/a.ts:4  line',
    '  src/a.ts:12  line',
    'Add unit tests that execute these lines (see docs/unit-coverage.md).',
  ]);
  lines.length = 0;
  assert.equal(checkChanged({ base: 'main', coverage: coverage(1), git, log, repoRoot }), 0);
  assert.equal(lines[1], 'Changed lines: 4/4 (100% required)');
  // nothing measured changed
  lines.length = 0;
  const docsOnly = (args: string[]) => ({ 'merge-base': 'abc\n', diff: '+++ b/docs/x.md\n@@ -1 +1 @@', 'ls-files': '' })[args[0]]!;
  assert.equal(checkChanged({ base: 'main', coverage: {}, git: docsOnly, log, repoRoot }), 0);
  assert.equal(lines[0], 'Changed sources since main: none');
  // an untracked file in a hidden folder (a lint-rule test's fixture, written while the run reads the tree) is no change
  lines.length = 0;
  mkdirSync(path.join(repoRoot, 'src/.lint-fixture-x'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src/.lint-fixture-x/view.ts'), 'export {};\n');
  const fixture = (args: string[]) => ({ 'merge-base': 'abc\n', diff: '', 'ls-files': 'src/.lint-fixture-x/view.ts\n' })[args[0]]!;
  assert.equal(checkChanged({ base: 'main', coverage: {}, git: fixture, log, repoRoot }), 0);
  assert.equal(lines[0], 'Changed sources since main: none');
});

test('test:diff-coverage reads a saved report', () => {
  const { repoRoot, coverage, git } = fixtureRepo();
  writeFileSync(path.join(repoRoot, 'cov.json'), JSON.stringify(coverage(1)));
  const lines: string[] = [];
  assert.equal(run(['--coverage', 'cov.json'], { git, log: (l: string) => lines.push(l), repoRoot }), 0);
  assert.equal(lines[0], 'Changed sources since origin/main: src/a.ts');
});

test('the command reports a usage error', () => {
  const result = spawnSync(process.execPath, ['scripts/diff-coverage.mjs', '--nope'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
});

test('the command checks the real repository against HEAD', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'diffcov-cli-'));
  writeFileSync(path.join(dir, 'empty.json'), '{}');
  const result = spawnSync(process.execPath, ['scripts/diff-coverage.mjs', '--base', 'HEAD', '--coverage', path.join(dir, 'empty.json')], {
    encoding: 'utf8',
  });
  assert.match(result.stdout, /^Changed sources since HEAD: /);
});
