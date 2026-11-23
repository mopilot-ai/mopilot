// The phone app's licence scan: SPDX expressions ranked, a fixture lockfile per case (copyleft, unknown, dual, decision), the report and exit code, and the real production tree staying clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, main, parseExpression, renderReport, scanLock, summarize } from '../scripts/mobile-licence-scan.mjs';

const lock = (packages: Record<string, any>): any => ({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
const pkg = (license: string | undefined, o: any = {}) => ({ version: '1.0.0', ...(license === undefined ? {} : { license }), ...o });

test('each licence class: permissive, decision, refused, unknown and empty', () => {
  for (const id of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1'])
    assert.deepEqual(classify(id), { status: 'allowed', dual: false }, id);
  for (const id of ['MPL-2.0', 'Unlicense', '0BSD', 'BlueOak-1.0.0', 'CC-BY-4.0', 'Python-2.0', 'LGPL-3.0'])
    assert.deepEqual(classify(id), { status: 'decide', dual: false }, id);
  for (const id of ['GPL-3.0', 'AGPL-3.0-only', 'GPL-2.0-or-later', 'SSPL-1.0', 'Made-Up-1.0'])
    assert.equal(classify(id).status, 'refused', id);
  assert.equal(classify(undefined).status, 'refused');
  assert.equal(classify('   ').status, 'refused');
});

test('OR takes the best alternative and reports the choice as dual; AND takes the worst; "+" and parentheses parse', () => {
  assert.deepEqual(classify('(MIT OR CC0-1.0)'), { status: 'allowed', dual: true });
  assert.deepEqual(classify('(BSD-3-Clause OR GPL-2.0)'), { status: 'allowed', dual: true });
  assert.deepEqual(classify('GPL-2.0 OR GPL-3.0'), { status: 'refused', dual: true });
  assert.deepEqual(classify('MIT AND Apache-2.0'), { status: 'allowed', dual: false });
  assert.deepEqual(classify('MIT AND GPL-3.0'), { status: 'refused', dual: false });
  assert.deepEqual(classify('MIT AND (Apache-2.0 OR MPL-2.0)'), { status: 'allowed', dual: true });
  assert.deepEqual(classify('MPL-2.0 OR GPL-3.0'), { status: 'decide', dual: true });
  assert.deepEqual(classify('Apache-2.0+'), { status: 'allowed', dual: false });
  assert.deepEqual(parseExpression('MIT'), { id: 'MIT' });
});

test('an expression that does not parse is one unknown id, never a pass', () => {
  for (const text of ['(MIT', 'MIT OR', 'MIT )', 'AND MIT', 'MIT MIT']) assert.equal(classify(text).status, 'refused', text);
  assert.deepEqual(parseExpression('(MIT'), { id: '(MIT' });
  assert.deepEqual(parseExpression(''), { id: 'UNKNOWN' });
});

test('the scan keeps production packages only, once each, by name', () => {
  const rows = scanLock(
    lock({
      'node_modules/b': pkg('MIT'),
      'node_modules/a': pkg('ISC'),
      'node_modules/a/node_modules/c': pkg('MIT'),
      'node_modules/x/node_modules/c': pkg('MIT'),
      'node_modules/dev-only': pkg('GPL-3.0', { dev: true }),
      'node_modules/linked': pkg('GPL-3.0', { link: true }),
      'node_modules/@s/pkg': pkg('MIT', { version: '2.0.0' }),
      'node_modules/nolicence': { version: '0.1.0' },
      'node_modules/noversion': { license: 'MIT' },
      'packages/local': pkg('MIT'),
    }),
  );
  assert.deepEqual(
    rows.map((r: any) => `${r.name}@${r.version}`),
    ['@s/pkg@2.0.0', 'a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'nolicence@0.1.0', 'noversion@?'],
  );
  assert.equal(rows.find((r: any) => r.name === 'nolicence')?.status, 'refused');
  assert.equal(scanLock({}).length, 0);
});

test('the summary separates refused from decisions, and counts licences', () => {
  const rows = scanLock(
    lock({
      'node_modules/a': pkg('MIT'),
      'node_modules/b': pkg('MIT'),
      'node_modules/c': pkg('MPL-2.0'),
      'node_modules/d': pkg('(MIT OR CC0-1.0)'),
      'node_modules/e': pkg('GPL-3.0'),
    }),
  );
  const s = summarize(rows);
  assert.equal(s.total, 5);
  assert.deepEqual(
    s.refused.map((r: any) => r.name),
    ['e'],
  );
  assert.deepEqual(
    s.decide.map((r: any) => r.name),
    ['c', 'd'],
  );
  assert.deepEqual(s.counts.at(0), ['MIT', 2]);
  const report = renderReport(rows);
  assert.match(report, /FAILED, 1 package/);
  assert.match(report, /\| e \| 1\.0\.0 \| GPL-3\.0 \|/);
  assert.match(renderReport(scanLock(lock({ 'node_modules/a': pkg('MIT'), 'node_modules/b': pkg('A|B') }))), /A\/B/);
  assert.match(
    renderReport(scanLock(lock({ 'node_modules/a': pkg('MIT') }))),
    /no refused or unknown licence\. 1 production packages; 0 need/,
  );
});

function run(packages: Record<string, any>, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'licence-scan-'));
  const lockFile = join(dir, 'lock.json');
  const report = join(dir, 'report.md');
  writeFileSync(lockFile, JSON.stringify(lock(packages)));
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    const code = main(['--lock', lockFile, '--report', report, ...extra]);
    return { code, logs, report: () => readFileSync(report, 'utf8') };
  } finally {
    console.log = log;
  }
}

test('the command exits 0 for a clean tree and writes the report; 1 and names the package for a copyleft one', () => {
  const clean = run({ 'node_modules/a': pkg('MIT') });
  assert.equal(clean.code, 0);
  assert.match(clean.report(), /# Phone app licence scan/);
  assert.match(clean.logs[0], /1 production packages, 0 refused/);
  const bad = run({ 'node_modules/a': pkg('MIT'), 'node_modules/agpl': pkg('AGPL-3.0') });
  assert.equal(bad.code, 1);
  assert.ok(bad.logs.some((l) => l.includes('refused: agpl@1.0.0 AGPL-3.0')));
  const unknown = run({ 'node_modules/mystery': pkg(undefined) });
  assert.equal(unknown.code, 1);
});

test('--check reads the tree and writes nothing; the default paths are the app’s lockfile and the design report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'licence-scan-'));
  const lockFile = join(dir, 'lock.json');
  writeFileSync(lockFile, JSON.stringify(lock({ 'node_modules/a': pkg('MIT') })));
  const log = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    assert.equal(main(['--lock', lockFile, '--check']), 0);
  } finally {
    console.log = log;
  }
  assert.doesNotMatch(logs[0], /report in/);
  // a flag with no value, or none at all, falls back to the app's own lockfile
  console.log = () => undefined;
  try {
    assert.equal(main(['--check', '--lock']), 0);
    assert.equal(main(['--check']), 0);
  } finally {
    console.log = log;
  }
});

test('the real production tree has no refused or unknown licence', () => {
  const real = JSON.parse(readFileSync('mobile/package-lock.json', 'utf8'));
  const s = summarize(scanLock(real));
  assert.deepEqual(
    s.refused.map((r: any) => `${r.name}@${r.version} ${r.licence}`),
    [],
  );
  assert.ok(s.total > 100);
});

test('run as a command it checks the app’s tree and exits with the scan’s code', () => {
  const r = spawnSync(process.execPath, ['scripts/mobile-licence-scan.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /production packages, 0 refused or unknown/);
});
