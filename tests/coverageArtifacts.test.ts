// Coverage runs keep their reports, remove raw traces however they end, and generate an HTML site only on request.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { coveragePlan, main } from '../scripts/unit-coverage.mjs';

test('ordinary coverage keeps its machine-readable reports without generating a repository-wide HTML site', () => {
  const report = coveragePlan(['tests/modelRetry.test.ts']).report;
  const reporters = report.flatMap((arg: string, i: number) => (arg === '--reporter' ? [report[i + 1]] : []));
  assert.deepEqual(reporters, ['text-summary', 'json', 'json-summary']);
});

test('--html adds the browser report without changing coverage thresholds or unit selection', () => {
  for (const args of [['tests/modelRetry.test.ts'], ['--all'], ['--report-only', 'tests/modelRetry.test.ts']]) {
    const ordinary = coveragePlan(args);
    const html = coveragePlan([...args, '--html']);
    assert.deepEqual(html.test, ordinary.test);
    assert.deepEqual(
      html.report.filter((arg: string, i: number, all: string[]) => arg !== 'html' && all[i + 1] !== 'html'),
      ordinary.report,
    );
    assert.ok(html.report.includes('html'));
  }
});

test('a coverage command removes the raw traces of a completed run only, prunes old dead runs, keeps its reports, and keeps raw on --keep-raw', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'coverage-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'tests/a.test.ts'), '');
  const reports = path.join(root, 'coverage/unit');
  // a run killed before it finished, from a process that no longer exists
  const dead = path.join(reports, 'tmp/run-999999999-killed');
  mkdirSync(dead, { recursive: true });
  writeFileSync(path.join(dead, 'coverage-0.json'), '{"result":[]}');
  const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(dead, longAgo, longAgo);
  let raw = '';
  const spawn = (status: number) => (_cmd: string, args: string[], opts: any) => {
    if (args.includes('--test')) {
      raw = path.join(opts.env.NODE_V8_COVERAGE, 'coverage-1.json');
      writeFileSync(raw, JSON.stringify({ result: [{ scriptId: '1', url: 'file:///a.mjs', functions: [] }] }));
    } else {
      assert.ok(args.includes('html'));
      writeFileSync(path.join(reports, 'coverage-final.json'), '{}');
      writeFileSync(path.join(reports, 'coverage-summary.json'), '{}');
    }
    return { status };
  };
  for (const status of [0, 1]) {
    assert.equal(main(['tests/a.test.ts', '--html'], spawn(status) as any, root), status);
    assert.equal(existsSync(path.dirname(raw)), status === 1, 'a passing run removes its traces; a failing one keeps them as evidence');
    assert.equal(existsSync(dead), false, 'an old dead run is pruned');
    assert.ok(existsSync(path.join(reports, 'coverage-final.json')));
    assert.ok(existsSync(path.join(reports, 'coverage-summary.json')));
  }
  const logs: string[] = [];
  t.mock.method(console, 'warn', (line: string) => logs.push(line));
  assert.equal(main(['tests/a.test.ts', '--html', '--keep-raw'], spawn(1) as any, root), 1);
  assert.ok(existsSync(raw), '--keep-raw keeps them');
  assert.match(logs.join('\n'), /Kept raw coverage/);
});
