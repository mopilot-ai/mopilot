// Code copied from Orca stays in one folder behind one seam (design/phone-on-orca/plan.md, D9): nothing outside mobile/vendor/orca imports
// Orca's shared tree or `@orca/` packages, vendored files reach only their own folder or the view-model in mobile/src/ui, every vendored
// file has a row in ORCA_FILES.md (with its Orca commit) and every row has a file, and no Orca mark or endpoint survives a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { runtimeSpecifiers } from './phoneBundleDependencies.invariant.test.ts';

const ROOT = resolve('.');
const VENDOR = 'mobile/vendor/orca';
const UI = 'mobile/src/ui';
const DOCS = new Set(['README.md', 'LICENSE-ORCA.md', 'ORCA_FILES.md']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'build']);
const SHARED = /(?:^|\/)src\/shared(?:\/|$)/;
const MARKS = /onorca\.dev|\borca:\/\/|google-services|GoogleService-Info/i;
const HEX40 = /^[0-9a-f]{40}$/;

/** Every file under `dir` (repository-relative, posix), skipping dependency and native build folders. */
export function walk(dir: string, base = ROOT): string[] {
  const abs = join(base, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = posix.join(dir, name);
    if (statSync(join(base, rel)).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(rel, base);
    return [rel];
  });
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** The import rules broken by one source file, as readable lines. `file` is repository-relative. */
export function importViolations(file: string, source: string): string[] {
  const vendored = inside(file, VENDOR);
  const bad: string[] = [];
  for (const spec of runtimeSpecifiers(source)) {
    const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)) : undefined;
    if (!vendored && spec.startsWith('@orca/')) bad.push(`${file} imports ${spec}`);
    if (!vendored && SHARED.test(spec) && !(target && inside(target, VENDOR))) bad.push(`${file} imports ${spec}`);
    if (vendored && target && !inside(target, VENDOR) && !inside(target, UI))
      bad.push(`${file} reaches outside the vendor folder: ${spec}`);
  }
  return bad;
}

/** The rows of ORCA_FILES.md between its markers: each is the cells of one table line. */
export function manifestRows(text: string): string[][] {
  const body = /<!-- orca-files:start -->([\s\S]*?)<!-- orca-files:end -->/.exec(text)?.[1];
  assert.ok(body, 'ORCA_FILES.md has its start and end markers');
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s|-]+\|$/.test(l) && !l.startsWith('| Path |'))
    .map((l) =>
      l
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim().replace(/^`|`$/g, '')),
    );
}

/** What is wrong between the manifest rows and the vendored files (paths relative to the vendor folder). */
export function manifestProblems(rows: string[][], files: string[]): string[] {
  const bad: string[] = [];
  const listed = new Set<string>();
  for (const [path, orcaPath, commit, blob, changes, licence, ...extra] of rows) {
    if (!path || !orcaPath || extra.length || licence === undefined) bad.push(`row for ${path || '(no path)'} has the wrong columns`);
    if (listed.has(path)) bad.push(`${path} is listed twice`);
    listed.add(path);
    if (!HEX40.test(commit ?? '')) bad.push(`${path}: Orca commit is not a 40-character id`);
    if (!HEX40.test(blob ?? '')) bad.push(`${path}: Orca blob is not a 40-character id`);
    if (!changes) bad.push(`${path}: Changes is empty`);
    if (!licence) bad.push(`${path}: Licence is empty`);
    if (!files.includes(path)) bad.push(`${path} is listed but does not exist`);
  }
  for (const f of files) if (!listed.has(f)) bad.push(`${f} is vendored but not listed in ORCA_FILES.md`);
  return bad;
}

const vendorFiles = () => walk(VENDOR).filter((f) => !DOCS.has(posix.relative(VENDOR, f)));

test('no file outside the vendor folder imports Orca code, and vendored files stay in their seam', () => {
  const bad = walk('mobile')
    .filter((f) => SOURCE.test(f))
    .flatMap((f) => importViolations(f, readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(bad, []);
});

test('every vendored file is in ORCA_FILES.md with its Orca commit, and every row has its file', () => {
  const rows = manifestRows(readFileSync(join(ROOT, VENDOR, 'ORCA_FILES.md'), 'utf8'));
  const files = vendorFiles().map((f) => posix.relative(VENDOR, f));
  assert.deepEqual(manifestProblems(rows, files), []);
});

test('vendored files carry no Orca mark, deep link, host or Firebase file', () => {
  const bad = vendorFiles().filter((f) => MARKS.test(f) || MARKS.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(bad, []);
});

test('the notice and the manifest format are in place', () => {
  assert.match(readFileSync(join(ROOT, VENDOR, 'LICENSE-ORCA.md'), 'utf8'), /Copyright \(c\) 2026 Lovecast Inc\./);
  for (const doc of DOCS) assert.ok(existsSync(join(ROOT, VENDOR, doc)), doc);
});

test('import rules: what is allowed and what is not', () => {
  const at = (file: string, ...specs: string[]) => importViolations(file, specs.map((s) => `import x from '${s}';`).join('\n'));
  assert.deepEqual(at('mobile/src/a.ts', '../src/shared/x', '../../src/shared', '@orca/process-host', '../../../src/shared/y'), [
    'mobile/src/a.ts imports ../src/shared/x',
    'mobile/src/a.ts imports ../../src/shared',
    'mobile/src/a.ts imports @orca/process-host',
    'mobile/src/a.ts imports ../../../src/shared/y',
  ]);
  assert.deepEqual(at('mobile/src/a.ts', '../../shared/remote/crypto.mjs', 'react', './src-shared', '../vendor/orca/src/shared/x'), []);
  assert.deepEqual(at(`${VENDOR}/ds/a.ts`, './b', '../i18n/c', 'react', '../../../src/ui/items/types', '@orca/x'), []);
  assert.deepEqual(at(`${VENDOR}/ds/a.ts`, '../../../src/remote/client', '../../../../shared/host/schema.mjs'), [
    `${VENDOR}/ds/a.ts reaches outside the vendor folder: ../../../src/remote/client`,
    `${VENDOR}/ds/a.ts reaches outside the vendor folder: ../../../../shared/host/schema.mjs`,
  ]);
  assert.deepEqual(at(`${VENDOR}/ds/a.ts`, '../src/shared/y'), []);
});

test('manifest rules: columns, ids, duplicates, missing and unlisted files', () => {
  const sha = 'a'.repeat(40);
  const good = ['ds/a.ts', 'mobile/src/a.ts', sha, sha, 'renamed', 'MIT (Lovecast Inc.)'];
  assert.deepEqual(manifestProblems([good], ['ds/a.ts']), []);
  assert.deepEqual(manifestProblems([], ['ds/b.ts']), ['ds/b.ts is vendored but not listed in ORCA_FILES.md']);
  assert.deepEqual(manifestProblems([good, good], ['ds/a.ts']), ['ds/a.ts is listed twice']);
  assert.deepEqual(manifestProblems([good], []), ['ds/a.ts is listed but does not exist']);
  assert.deepEqual(manifestProblems([['x.ts', 'o.ts', 'abc', 'zz', '', '']], ['x.ts']), [
    'x.ts: Orca commit is not a 40-character id',
    'x.ts: Orca blob is not a 40-character id',
    'x.ts: Changes is empty',
    'x.ts: Licence is empty',
  ]);
  assert.deepEqual(manifestProblems([['x.ts'], [...good, 'extra']], ['x.ts', 'ds/a.ts']).slice(0, 2), [
    'row for x.ts has the wrong columns',
    'x.ts: Orca commit is not a 40-character id',
  ]);
  assert.deepEqual(manifestProblems([['', ...good.slice(1)]], []).slice(0, 1), ['row for (no path) has the wrong columns']);
});

test('manifest parsing reads rows between the markers and ignores the header and separator', () => {
  const text =
    '<!-- orca-files:start -->\n| Path | Orca path | Orca commit | Orca blob | Changes | Licence |\n|---|---|---|---|---|---|\n| `a.ts` | `b.ts` | c | d | e | f |\n<!-- orca-files:end -->';
  assert.deepEqual(manifestRows(text), [['a.ts', 'b.ts', 'c', 'd', 'e', 'f']]);
  assert.deepEqual(manifestRows('<!-- orca-files:start -->\n<!-- orca-files:end -->'), []);
  assert.throws(() => manifestRows('no markers'));
});

test('walking skips dependency folders and a missing folder is empty', () => {
  assert.deepEqual(walk('mobile/does-not-exist'), []);
  assert.ok(walk('mobile').every((f) => !f.includes('/node_modules/')));
  assert.equal(relative(ROOT, dirname(join(ROOT, VENDOR))), 'mobile/vendor');
});
