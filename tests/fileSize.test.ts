// File-size policy: physical-line thresholds, automatic Git ceilings, and scoped exception validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGrowth,
  createGit,
  EXCEPTIONS,
  EXCEPTIONS_DIR,
  isExceptionsFile,
  isSource,
  lineCount,
  parseExceptions,
  renameSources,
  snapshot,
} from '../scripts/file-size.mjs';

/** A new exception goes in a file of its own; the legacy file no longer grows. */
const NEW_EXCEPTIONS = `${EXCEPTIONS_DIR}new.json`;

test('authored sources include tests, web, styles, scripts and Swift, excluding generated and dependency/build trees', () => {
  for (const file of [
    'index.html',
    'src/a.ts',
    'src/a.tsx',
    'shared/a.d.mts',
    'electron/a.cjs',
    'scripts/a.mjs',
    'tests/a.test.ts',
    'web/app/a.tsx',
    'web/a.jsx',
    'native/helper/A.swift',
    'src/a.css',
    'src/a.scss',
    'scripts/a.py',
    'scripts/a.sh',
    'lint/rules/a.grit',
  ])
    assert.equal(isSource(file), true, file);
  for (const file of [
    'README.md',
    'data.json',
    'a.png',
    'src/protocol/a.ts',
    'src/a.generated.ts',
    'node_modules/a.ts',
    'web/node_modules/a.js',
    'native/helper/.build/a.swift',
    'build/a.js',
    'bench/external/a.py',
    'vendor/a.ts',
    'src/generated/a.ts',
    'dist/a.js',
    'out/a.js',
    'coverage/a.js',
    'test-results/a.js',
    'playwright-report/a.js',
    '.git/a.js',
    'web/.next/a.js',
  ])
    assert.equal(isSource(file), false, file);
});

test('physical lines count comments and blanks, without a phantom trailing line or doubled CRLF lines', () => {
  for (const [text, expected] of [
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['\n', 1],
    ['a\n\n', 2],
    ['a\nb', 2],
    ['a\r\nb\r\n', 2],
  ] as const) {
    assert.equal(lineCount(text), expected);
  }
});

test('exceptions require one exact authored path, a finite cap above 500 and a written reason', () => {
  assert.equal(parseExceptions(null).size, 0);
  const valid = { maxLines: 650, reason: 'This closure is serialized into one isolated browser world.' };
  assert.deepEqual(parseExceptions(JSON.stringify({ exceptions: { 'src/a.ts': valid } })).get('src/a.ts'), valid);
  for (const config of [null, [], {}, { other: {} }, { exceptions: [] }, { exceptions: null }, { exceptions: {}, other: true }]) {
    assert.throws(() => parseExceptions(JSON.stringify(config)), /expected an object/);
  }
  assert.throws(() => parseExceptions('{'), SyntaxError);
  for (const file of [
    'src/*.ts',
    'src/a?.ts',
    'src/[a].ts',
    'src\\a.ts',
    '/a.ts',
    'src//a.ts',
    './a.ts',
    'src/../a.ts',
    'data.json',
    'src/protocol/a.ts',
  ]) {
    assert.throws(() => parseExceptions(JSON.stringify({ exceptions: { [file]: valid } })), /one repository-relative/);
  }
  for (const entry of [
    null,
    [],
    {},
    { ...valid, extra: true },
    { ...valid, maxLines: 500 },
    { ...valid, maxLines: 650.5 },
    { ...valid, maxLines: '650' },
    { ...valid, maxLines: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, reason: null },
    { ...valid, reason: '  ' },
  ]) {
    assert.throws(() => parseExceptions(JSON.stringify({ exceptions: { 'src/a.ts': entry } })), /needs maxLines/);
  }
});

/** Git blob fixture: policy reads content exclusively through the supplied immutable blob ids. */
function fixture() {
  const blobs = new Map<string, string>();
  let next = 0;
  const entry = (content: string, mode = '100644') => {
    const oid = String(next++);
    blobs.set(oid, content);
    return { oid, mode };
  };
  const source = (lines: number) => entry('x\n'.repeat(lines));
  const config = (exceptions: object) => entry(JSON.stringify({ exceptions }));
  const git = (args: string[]) => {
    assert.deepEqual(args.slice(0, 2), ['cat-file', 'blob']);
    assert.ok(blobs.has(args[2]));
    return blobs.get(args[2])!;
  };
  return { source, entry, config, git };
}

test('new files warn above 400 and block above 500; existing oversized files may hold or shrink, then cannot grow back', () => {
  const f = fixture();
  for (const [was, now, errors, warnings] of [
    [0, 0, 0, 0],
    [0, 400, 0, 0],
    [0, 401, 0, 1],
    [0, 500, 0, 1],
    [0, 501, 1, 1],
    [500, 501, 1, 1],
    [800, 800, 0, 1],
    [800, 799, 0, 1],
    [800, 801, 1, 1],
    [799, 800, 1, 1],
    [400, 501, 1, 1],
  ]) {
    const before = new Map(was ? [['src/a.ts', f.source(was)]] : []);
    const after = new Map([['src/a.ts', f.source(now)]]);
    const result = checkGrowth(before, after, f.git);
    assert.equal(result.errors.length, errors, `${was} -> ${now}`);
    assert.equal(result.warnings.length, warnings, `${was} -> ${now}`);
    if (errors) assert.match(result.errors[0], new RegExp(`exceeds ${Math.max(500, was)}`));
  }
  const same = f.source(800);
  assert.deepEqual(checkGrowth(new Map([['src/a.ts', same]]), new Map([['src/a.ts', same]]), f.git), { warnings: [], errors: [] });
  assert.deepEqual(checkGrowth(new Map([['src/a.ts', same]]), new Map(), f.git), { warnings: [], errors: [] });
});

test('an exception authorizes only its reviewed increase, capped exactly, and cannot restore headroom in a later diff', () => {
  const f = fixture();
  const reason = 'The browser serializes this closure as one executable unit.';
  const exception = f.config({ 'src/a.ts': { maxLines: 650, reason } });
  const after = new Map([
    ['src/a.ts', f.source(650)],
    [NEW_EXCEPTIONS, exception],
  ]);
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 0);
  assert.equal(checkGrowth(new Map([['src/a.ts', f.source(500)]]), after, f.git).errors.length, 0);
  after.set('src/a.ts', f.source(651));
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 1);
  after.set('src/a.ts', f.source(640));
  const shrunk = new Map([
    ['src/a.ts', f.source(630)],
    [NEW_EXCEPTIONS, exception],
  ]);
  assert.equal(checkGrowth(shrunk, after, f.git).errors.length, 1, 'an unchanged exception grants no new growth');
  after.set(NEW_EXCEPTIONS, f.config({ 'src/a.ts': { maxLines: 640, reason: 'The serialized closure needs another protocol branch.' } }));
  assert.equal(checkGrowth(shrunk, after, f.git).errors.length, 0, 'a fresh explanation and finite cap is reviewed in the diff');
  after.set(NEW_EXCEPTIONS, f.config({ 'src/a.ts': { maxLines: 641, reason } }));
  assert.equal(checkGrowth(shrunk, after, f.git).errors.length, 0, 'a changed cap is also visible in the diff');
});

test('a merge takes the larger ceiling of its parents, and an exception approves growth only when it differs from every parent', () => {
  const f = fixture();
  const reason = 'The browser serializes this closure as one executable unit.';
  const ours = new Map([['src/a.ts', f.source(450)]]);
  const theirs = { files: new Map([['src/a.ts', f.source(620)]]), renames: new Map<string, string>() };
  const after = new Map([['src/a.ts', f.source(620)]]);
  assert.equal(checkGrowth(ours, after, f.git).errors.length, 1, 'against HEAD alone, the merged branch’s growth looks like ours');
  assert.equal(checkGrowth(ours, after, f.git, new Map(), [theirs]).errors.length, 0, 'the merged branch already had it');
  after.set('src/a.ts', f.source(621));
  assert.match(checkGrowth(ours, after, f.git, new Map(), [theirs]).errors[0], /621 lines exceeds 620/);
  const allowance = f.config({ 'src/a.ts': { maxLines: 640, reason } });
  theirs.files.set(NEW_EXCEPTIONS, allowance);
  after.set(NEW_EXCEPTIONS, allowance);
  assert.equal(checkGrowth(ours, after, f.git, new Map(), [theirs]).errors.length, 1, 'the merged branch’s own allowance is not new');
  after.set(NEW_EXCEPTIONS, f.config({ 'src/a.ts': { maxLines: 640, reason: 'The merge resolution adds a protocol branch.' } }));
  assert.equal(checkGrowth(ours, after, f.git, new Map(), [theirs]).errors.length, 0, 'an allowance this merge changes is reviewed');
});

test('renames preserve ceilings, copies do not, and files moved in from excluded trees receive the new-file limit', () => {
  const f = fixture();
  const before = new Map([
    ['src/old.ts', f.source(600)],
    ['src/protocol/generated.ts', f.source(900)],
  ]);
  const after = new Map([
    ['src/new.ts', f.source(599)],
    ['src/from-generated.ts', f.source(700)],
  ]);
  const renames = renameSources('R099\0src/old.ts\0src/new.ts\0M\0README.md\0R090\0src/protocol/generated.ts\0src/from-generated.ts\0');
  const result = checkGrowth(before, after, f.git, renames);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /from-generated.ts.*exceeds 500/);
  assert.equal(checkGrowth(before, after, f.git).errors.length, 2);
  assert.equal(renameSources('C100\0src/old.ts\0src/copy.ts\0').size, 0);
  assert.equal(renameSources('').size, 0);
});

test('symlinks and submodules have no source ceiling, executable files do, and exceptions cannot point at a missing file or symlink', () => {
  const f = fixture();
  const after = new Map([['src/generated/a.generated.ts', f.source(999)]]);
  after.set('src/link.ts', f.entry('target.ts', '120000'));
  after.set('src/module.ts', f.entry('submodule', '160000'));
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 0);
  after.set('scripts/a.sh', f.entry('x\n'.repeat(501), '100755'));
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 1);
  const config = f.config({ 'src/missing.ts': { maxLines: 600, reason: 'Needs a cohesive state owner.' } });
  after.set(NEW_EXCEPTIONS, config);
  assert.throws(() => checkGrowth(new Map(), after, f.git), /missing or nonregular/);
  after.set('src/missing.ts', f.entry('target.ts', '120000'));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /missing or nonregular/);
  after.set(EXCEPTIONS, f.entry('target.json', '120000'));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /must be a regular file/);
  assert.throws(() => checkGrowth(after, new Map(), f.git), /must be a regular file/);
});

test('snapshot parsing preserves unusual filenames and rejects every unmerged index stage', () => {
  const name = 'src/a\twith\nspace.ts';
  assert.deepEqual(snapshot(() => `100755 blob abc\t${name}\0`, 'HEAD').get(name), { mode: '100755', oid: 'abc' });
  assert.deepEqual(snapshot(() => `100644 abc 0\t${name}\0`, null).get(name), { mode: '100644', oid: 'abc' });
  assert.throws(() => snapshot(() => '100644 abc 2\tsrc/a.ts\0', null), /Resolve the index conflict/);
});

test('exceptions live in one file per pull request under lint/file-size-exceptions/, beside the legacy file, one per path', () => {
  assert.equal(isExceptionsFile(EXCEPTIONS), true);
  assert.equal(isExceptionsFile('lint/file-size-exceptions/chat-view.json'), true);
  assert.equal(isExceptionsFile('lint/file-size-exceptions/nested/a.json'), false);
  assert.equal(isExceptionsFile('lint/file-size-exceptions/readme.md'), false);
  assert.equal(isExceptionsFile('lint/baseline.json'), false);
  const f = fixture();
  const reason = 'The browser serializes this closure as one executable unit.';
  const one = `${EXCEPTIONS_DIR}a.json`;
  const after = new Map([
    ['src/a.ts', f.source(650)],
    ['src/b.ts', f.source(620)],
    [one, f.config({ 'src/a.ts': { maxLines: 650, reason } })],
    [`${EXCEPTIONS_DIR}b.json`, f.config({ 'src/b.ts': { maxLines: 620, reason } })],
  ]);
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 0, 'each file approves its own path');
  after.set('src/a.ts', f.source(651));
  assert.equal(checkGrowth(new Map(), after, f.git).errors.length, 1, 'the cap holds');
  // the same path in two files, or in the legacy file and one under the folder, is refused
  after.set(`${EXCEPTIONS_DIR}c.json`, f.config({ 'src/a.ts': { maxLines: 700, reason } }));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /c\.json: src\/a\.ts already has an exception in .*a\.json; keep one/);
  after.delete(`${EXCEPTIONS_DIR}c.json`);
  after.set(EXCEPTIONS, f.config({ 'src/b.ts': { maxLines: 640, reason } }));
  assert.throws(
    () => checkGrowth(new Map(), after, f.git),
    /b\.json: src\/b\.ts already has an exception in lint\/file-size-exceptions\.json/,
  );
  // an invalid file and a missing path name the file they are in
  after.delete(EXCEPTIONS);
  after.set(one, f.entry('{ "exceptions": { "src/a.ts": 1 } }'));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /a\.json: src\/a\.ts needs maxLines/);
  after.set(one, f.config({ 'src/gone.ts': { maxLines: 600, reason } }));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /a\.json: remove the exception for missing or nonregular file src\/gone\.ts/);
  // a folder file that is not a regular file is refused too
  after.set(one, f.entry('target.json', '120000'));
  assert.throws(() => checkGrowth(new Map(), after, f.git), /a\.json must be a regular file/);
});

test('the legacy exceptions file only shrinks or edits an entry it has; a parent that already holds a path twice is tolerated', () => {
  const f = fixture();
  const reason = 'The browser serializes this closure as one executable unit.';
  const files = (legacy: object, extra: Record<string, object> = {}) =>
    new Map([
      ['src/a.ts', f.source(600)],
      ['src/b.ts', f.source(600)],
      [EXCEPTIONS, f.config(legacy)],
      ...Object.entries(extra).map(([file, exceptions]) => [file, f.config(exceptions)] as [string, { oid: string; mode: string }]),
    ]);
  const was = files({ 'src/a.ts': { maxLines: 600, reason } });
  // a new path in the legacy file is refused, with where to put it
  const added = checkGrowth(was, files({ 'src/a.ts': { maxLines: 600, reason }, 'src/b.ts': { maxLines: 600, reason } }), f.git);
  assert.match(
    added.errors[0],
    /lint\/file-size-exceptions\.json: src\/b\.ts is new there\. Put its exception in a new lint\/file-size-exceptions\/<name>\.json/,
  );
  // changing or dropping an entry it has is fine, and so is the same path moved into a file of its own
  const edited = files({ 'src/a.ts': { maxLines: 650, reason } });
  assert.deepEqual(checkGrowth(was, edited, f.git).errors, []);
  assert.deepEqual(checkGrowth(was, files({}, { [NEW_EXCEPTIONS]: { 'src/a.ts': { maxLines: 600, reason } } }), f.git).errors, []);
  // a merge's other parent counts as having its own legacy entries
  const theirs = {
    files: files({ 'src/a.ts': { maxLines: 600, reason }, 'src/b.ts': { maxLines: 600, reason } }),
    renames: new Map<string, string>(),
  };
  assert.deepEqual(checkGrowth(was, theirs.files, f.git, new Map(), [theirs]).errors, []);
  // a parent holding one path in two files (two merges that each passed) does not fail a change that is not about it
  const doubled = files({ 'src/a.ts': { maxLines: 600, reason } }, { [NEW_EXCEPTIONS]: { 'src/a.ts': { maxLines: 600, reason } } });
  assert.throws(() => checkGrowth(new Map(), doubled, f.git), /already has an exception/);
  assert.deepEqual(checkGrowth(doubled, files({}, { [NEW_EXCEPTIONS]: { 'src/a.ts': { maxLines: 600, reason } } }), f.git).errors, []);
});

test('Git execution fails closed on spawn, command, and empty-output failures', () => {
  assert.throws(() => createGit('.', () => ({ status: null, error: new Error('spawn failed') }))(['status']), /spawn failed/);
  assert.throws(() => createGit('.', () => ({ status: 128, stderr: ' no ref \n' }))(['show']), /no ref/);
  assert.throws(() => createGit('.', () => ({ status: 128 }))(['show']), /exit 128/);
  assert.equal(createGit('.', () => ({ status: 0 }))(['status']), '');
});
