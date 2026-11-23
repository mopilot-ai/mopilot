// git:status / git:diff read git's -z output: names with spaces, non-ASCII and renames come through verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { parseStatusZ, parseNumstatZ, parseLsFilesZ } = createRequire(import.meta.url)('../electron/platform/gitParse.cjs');

test('status: spaces, non-ASCII, renames (new path kept, original skipped), untracked', () => {
  const out = ' M my file.txt\0M  über.txt\0R  new name.txt\0old name.txt\0?? notes/a b.md\0';
  assert.deepEqual(parseStatusZ(out), [
    { code: ' M', path: 'my file.txt' },
    { code: 'M ', path: 'über.txt' },
    { code: 'R ', path: 'new name.txt' },
    { code: '??', path: 'notes/a b.md' },
  ]);
  assert.deepEqual(parseStatusZ(''), []);
  // no output at all, and an entry with no path, are nothing
  assert.deepEqual(parseStatusZ(undefined), []);
  assert.deepEqual(parseStatusZ(' M a b\0??\0'), [{ code: ' M', path: 'a b' }]);
});

test('numstat: plain entries, renames keyed by the new path, binary as 0', () => {
  const out = '3\t1\tmy file.txt\0' + '2\t0\t\0old name.txt\0new name.txt\0' + '-\t-\tlogo ü.png\0' + '1\t1\tüber.txt\0';
  assert.deepEqual(parseNumstatZ(out), {
    'my file.txt': { added: 3, removed: 1 },
    'new name.txt': { added: 2, removed: 0 },
    'logo ü.png': { added: 0, removed: 0 },
    'über.txt': { added: 1, removed: 1 },
  });
  // no output, and a rename cut off before its new path, add nothing
  assert.deepEqual(parseNumstatZ(null), {});
  assert.deepEqual(parseNumstatZ('1\t2\tf\0' + '5\t6\t\0'), { f: { added: 1, removed: 2 } });
});

test('ls-files', () => {
  assert.deepEqual(parseLsFilesZ('a b.txt\0über.txt\0'), ['a b.txt', 'über.txt']);
  assert.deepEqual(parseLsFilesZ(''), []);
});

test('against a real repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-gitparse-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'my file.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'old name.txt'), 'x\ny\nz\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'my file.txt'), 'a\nb\nc\n');
    git('mv', 'old name.txt', 'new name.txt');
    fs.writeFileSync(path.join(dir, 'über.txt'), 'u\n');
    const status = parseStatusZ(git('status', '--porcelain=v1', '-uall', '-z'));
    assert.deepEqual(
      status.map((f: any) => f.path),
      ['my file.txt', 'new name.txt', 'über.txt'],
    );
    assert.equal(status[1].code, 'R ');
    const stats = parseNumstatZ(git('diff', 'HEAD', '--numstat', '-M', '-z'));
    assert.deepEqual(stats['my file.txt'], { added: 2, removed: 0 });
    assert.deepEqual(stats['new name.txt'], { added: 0, removed: 0 });
    assert.deepEqual(parseLsFilesZ(git('ls-files', '--others', '--exclude-standard', '-z')), ['über.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
