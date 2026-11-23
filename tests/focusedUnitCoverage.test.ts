import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { parseCoverageArgs } from '../scripts/focused-unit-coverage.mjs';
import { main } from '../scripts/unit-coverage.mjs';

test('suites expand to their files and node:test options, deduplicated and merged', () => {
  const opts = parseCoverageArgs(['--suite', 'browser', '--suite', 'native-availability', 'tests/browserPanel.test.ts']);
  assert.equal(opts.files.filter((f) => f === 'tests/browserPanel.test.ts').length, 1);
  assert.ok(opts.files.includes('tests/nativeAvailabilityUI.test.ts'));
  assert.equal(opts.timeout, 30000);
  assert.deepEqual(opts.skip, ['the pinned CLI in --extension mode']);
  assert.throws(() => parseCoverageArgs(['--suite', 'nope']), /Unknown suite: nope\. Known suites: .*browser/);
});

test('a suite entry with * in its file name is every matching test, found when the suite runs', (t) => {
  const { dir } = repo(t);
  writeFileSync(path.join(dir, 'tests/b.test.ts'), '');
  writeFileSync(
    path.join(dir, 'tests/suites.json'),
    JSON.stringify({ all: { tests: ['tests/*.test.ts', 'tests/a.test.ts'] }, none: { tests: ['tests/z*.test.ts'] } }),
  );
  assert.deepEqual(parseCoverageArgs(['--suite', 'all'], dir).files, ['tests/a.test.ts', 'tests/b.test.ts']);
  // a pattern that matches nothing names no tests, which fails like an empty run
  assert.throws(() => parseCoverageArgs(['--suite', 'none'], dir), /Specify focused/);
  // the control-matrix suite is every control-matrix test on disk
  assert.deepEqual(
    parseCoverageArgs(['--suite', 'control-matrix']).files,
    readdirSync('tests')
      .filter((f) => /^controlMatrix.*\.test\.ts$/.test(f))
      .map((f) => `tests/${f}`)
      .sort(),
  );
});

test('every suite names existing top-level unit-test files', () => {
  const suites = JSON.parse(readFileSync('tests/suites.json', 'utf8'));
  for (const name of Object.keys(suites)) assert.ok(parseCoverageArgs(['--suite', name]).files.length, name);
});

test('--changed accepts the default target and an explicit base', () => {
  assert.equal(parseCoverageArgs(['--', '--report-only', '--changed', 'tests/modelRetry.test.ts']).changed, 'origin/main');
  assert.equal(parseCoverageArgs(['--changed=HEAD~2', 'tests/modelRetry.test.ts']).changed, 'HEAD~2');
  assert.throws(() => parseCoverageArgs([]), /Specify focused/);
  assert.throws(() => parseCoverageArgs(['tests/e2e/x.test.ts']), /Expected an existing/);
});

const loc = (line: number, end = line) => ({ start: { line }, end: { line: end } });
function repo(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'unit-coverage-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'tests/a.test.ts'), '');
  writeFileSync(path.join(dir, 'tests/suites.json'), '{}');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  writeFileSync(path.join(dir, 'lib.ts'), 'a\nb\n');
  writeFileSync(path.join(dir, 'gone.ts'), 'x\n');
  writeFileSync(path.join(dir, 'README.md'), 'r\n');
  git(['add', '.']);
  git(['-c', 'user.name=UT', '-c', 'user.email=ut@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  writeFileSync(path.join(dir, 'lib.ts'), 'a\nB\n');
  writeFileSync(path.join(dir, 'README.md'), 'R\n');
  rmSync(path.join(dir, 'gone.ts'));
  writeFileSync(path.join(dir, 'new.ts'), 'n1\nn2\n');
  writeFileSync(path.join(dir, 'unmeasured.ts'), 'u\n');
  writeFileSync(path.join(dir, '.c8rc.json'), JSON.stringify({ include: ['*.ts'], exclude: ['unmeasured.ts'], extension: ['.ts'] }));
  const entry = (file: string, hits: number[]) => ({
    path: path.join(dir, file),
    statementMap: Object.fromEntries(hits.map((_, i) => [i, loc(i + 1)])),
    s: Object.fromEntries(hits.map((h, i) => [i, h])),
    branchMap: {},
    b: {},
    fnMap: {},
    f: {},
  });
  return { dir, git, entry };
}

test('the single coverage runner preserves suite options and enforces changed-line coverage after normalization', (t) => {
  const { dir, entry } = repo(t);
  writeFileSync(
    path.join(dir, 'tests/suites.json'),
    JSON.stringify({ area: { tests: ['tests/a.test.ts'], timeout: 9000, skip: ['integration'] } }),
  );
  const runs: string[][] = [];
  let coverage: object = { lib: entry('lib.ts', [1, 1]), fresh: entry('new.ts', [1, 1]) };
  const spawn = (_cmd: string, argv: string[]) => {
    runs.push(argv);
    if (argv[1] === 'report') writeFileSync(path.join(dir, 'coverage/unit/coverage-final.json'), JSON.stringify(coverage));
    return { status: 0 };
  };
  const logs: string[] = [];
  const logger = mock.method(console, 'log', (line: string) => logs.push(line));
  t.after(() => logger.mock.restore());
  assert.equal(main(['--changed=HEAD', '--suite', 'area', '--html'], spawn as any, dir), 0);
  assert.ok(runs[0].includes('--test-timeout=9000'));
  assert.ok(runs[0].indexOf('--test-skip-pattern=integration') < runs[0].indexOf('tests/a.test.ts'));
  assert.ok(runs[1].includes('--check-coverage=false'));
  assert.ok(runs[1].includes('html'));
  // the changed and untracked measured sources; README, the deleted file and the excluded one are out of scope
  assert.deepEqual(logs, [
    'Changed sources since HEAD: lib.ts, new.ts',
    'Changed lines: 3/3 (100% required)',
    'Changed branches: 0/0 (100% required)',
    'Changed functions: 0/0 (100% required)',
  ]);
  // a changed source no test loaded, and an uncovered changed line, fail the run
  coverage = { lib: entry('lib.ts', [1, 0]) };
  logs.length = 0;
  assert.equal(main(['--changed=HEAD', 'tests/a.test.ts'], spawn as any, dir), 1);
  assert.deepEqual(logs.slice(4, 7), [
    '2 uncovered locations on changed lines:',
    '  lib.ts:2  line',
    '  new.ts:1  file missing from the coverage report',
  ]);
  assert.equal(main(['--suite', 'area', '--report-only'], spawn as any, dir), 0);
  assert.equal(main(['--suite', 'area'], spawn as any, dir), 0);
});

test('focused coverage uses the requested directory for raw data, reports and changed-line enforcement', (t) => {
  const { dir, entry } = repo(t);
  writeFileSync(path.join(dir, 'tests/suites.json'), JSON.stringify({ area: { tests: ['tests/a.test.ts'] } }));
  const reportDir = path.join(dir, 'custom reports');
  const runs: { argv: string[]; env: any }[] = [];
  let covered = true;
  const spawn = (_cmd: string, argv: string[], opts: any) => {
    runs.push({ argv, env: opts.env });
    if (argv[1] === 'report') {
      assert.equal(argv[argv.indexOf('--reports-dir') + 1], reportDir);
      writeFileSync(
        path.join(reportDir, 'coverage-final.json'),
        JSON.stringify({
          lib: entry('lib.ts', [1, covered ? 1 : 0]),
          fresh: entry('new.ts', [1, 1]),
        }),
      );
    }
    return { status: 0 };
  };
  const logger = mock.method(console, 'log', () => {});
  t.after(() => logger.mock.restore());
  assert.equal(main(['--reports-dir', 'custom reports', '--changed=HEAD', '--suite', 'area'], spawn as any, dir), 0);
  assert.ok(runs[0].env.NODE_V8_COVERAGE.startsWith(path.join(reportDir, 'tmp/run-')));
  assert.equal(runs[0].argv.includes('--reports-dir'), false);
  covered = false;
  assert.equal(main(['--changed=HEAD', 'tests/a.test.ts', '--reports-dir', reportDir], spawn as any, dir), 1);
  assert.equal(main(['--suite', 'area', '--reports-dir', reportDir], spawn as any, dir), 0);
  assert.equal(main(['--related', '--changed=HEAD', 'tests/a.test.ts', '--reports-dir', reportDir], spawn as any, dir), 1);
  assert.throws(() => main(['--suite', 'area', '--reports-dir'], spawn as any, dir), /needs a directory/);
});
