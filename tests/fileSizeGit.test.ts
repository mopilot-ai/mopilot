// File-size CLI against real Git snapshots: partial staging, renames, scoped allowances and merged-main comparisons.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cli, EXCEPTIONS_DIR } from '../scripts/file-size.mjs';
import { precommit } from '../scripts/precommit.mjs';

/** A new exception goes in a file of its own; the legacy file no longer grows. */
const EXCEPTIONS = `${EXCEPTIONS_DIR}new.json`;

function repository(t: TestContext) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'file-size-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '--initial-branch=main', '--template=');
  for (const [key, value] of [
    ['user.name', 'file-size-test'],
    ['user.email', 'file-size@invalid'],
    ['commit.gpgSign', 'false'],
    ['core.hooksPath', '.no-hooks'],
  ]) {
    git('config', key, value);
  }
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  const source = (file: string, lines: number) => write(file, '// source\n'.repeat(lines));
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  write('README.md', 'fixture\n');
  commit();
  const logs: string[] = [];
  const check = (args = ['--staged']) => {
    logs.length = 0;
    return cli(args, { cwd, log: (message: string) => logs.push(message) });
  };
  return { cwd, git, write, source, commit, check, logs };
}

test('the hook judges staged blobs and staged allowances, never unstaged edits or untracked files', (t) => {
  const r = repository(t);
  const file = 'src/a with\ttab\nand newline.ts';
  r.source(file, 501);
  r.git('add', '.');
  r.source(file, 10);
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.includes('501 lines exceeds 500')));
  r.git('add', '.');
  r.source(file, 900);
  r.source('src/untracked.ts', 900);
  assert.equal(r.check([]), 0);
  r.source(file, 501);
  r.git('add', file);
  r.write(
    EXCEPTIONS,
    JSON.stringify({ exceptions: { [file]: { maxLines: 501, reason: 'One serialized closure with a shared lexical scope.' } } }),
  );
  assert.equal(r.check(), 1, 'an unstaged allowance does not approve staged growth');
  r.git('add', EXCEPTIONS);
  r.write(EXCEPTIONS, '{ invalid unstaged JSON');
  assert.equal(r.check(), 0);
  r.git('add', EXCEPTIONS);
  assert.equal(r.check(), 1);
  assert.match(r.logs.at(-1)!, /^file-size: /);
});

test('the real CLI compares committed HEAD against the requested base, and invokes the same implementation', (t) => {
  const r = repository(t);
  const base = r.git('rev-parse', 'HEAD');
  r.source('web/app/a.tsx', 501);
  r.commit();
  r.source('web/app/a.tsx', 1);
  r.git('add', '.');
  assert.equal(r.check([`--base=${base}`]), 1, 'CI ignores both staged and unstaged repairs to the committed head');
  const result = spawnSync(process.execPath, [path.resolve('scripts/file-size.mjs'), `--base=${base}`], { cwd: r.cwd, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /file-size error: web\/app\/a.tsx: 501 lines exceeds 500/);
  r.commit();
  assert.equal(r.check([`--base=${base}`]), 0);
  for (const args of [['--base=missing'], ['--base='], ['--unknown'], ['--staged', '--base=HEAD']]) {
    assert.equal(r.check(args), 1, args.join(' '));
  }
});

test('the pre-commit entry point reaches the guard for Git-quoted filenames', (t) => {
  const r = repository(t);
  r.source('web/app/含有\ttab\nnewline.tsx', 501);
  r.git('add', '.');
  const run = (cmd: string, args: string[]) => {
    if (cmd === 'git') return spawnSync(cmd, args, { cwd: r.cwd, encoding: 'utf8' });
    assert.deepEqual([cmd, ...args], ['node', 'scripts/file-size.mjs', '--staged']);
    const result = spawnSync(process.execPath, [path.resolve(args[0]), ...args.slice(1)], { cwd: r.cwd, encoding: 'utf8' });
    assert.match(result.stdout, /501 lines exceeds 500/);
    return result;
  };
  assert.equal(precommit({ run, log: () => {} }), 1);
});

test('dirty and untracked Git-quoted typed paths select the index typecheck, preserving partial staging', (t) => {
  for (const kind of ['dirty', 'untracked']) {
    const r = repository(t);
    const unusual = 'src/含有\ttab\nnewline.ts';
    r.write(kind === 'dirty' ? unusual : 'src/staged.ts', 'const value: number = "staged error";\n');
    r.git('add', '.');
    r.write(unusual, 'const value: number = 1;\n');
    const run = (cmd: string, args: string[]) => {
      if (cmd === 'git') return spawnSync(cmd, args, { cwd: r.cwd, encoding: 'utf8' });
      // The actual index typecheck is exercised in precommit.test.ts; here only it reports a staged type error.
      return { status: args.includes('--typecheck-index') ? 2 : 0 };
    };
    assert.equal(precommit({ run, log: () => {} }), 2, kind);
  }
});

test('shrinking a grandfathered file lowers its next ceiling; a pure rename keeps it, a copy gets no allowance', (t) => {
  const r = repository(t);
  r.source('src/old.ts', 600);
  r.commit();
  r.git('mv', 'src/old.ts', 'src/new.ts');
  assert.equal(r.check(), 0);
  r.commit();
  r.source('src/new.ts', 590);
  r.git('add', '.');
  assert.equal(r.check(), 0);
  r.commit();
  r.source('src/new.ts', 591);
  r.git('add', '.');
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.includes('591 lines exceeds 590')));
  r.source('src/new.ts', 590);
  r.source('src/copy.ts', 590);
  r.git('add', '.');
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.includes('src/copy.ts: 590 lines exceeds 500')));
});

test('CI uses current main as its ceiling after the merge, rather than charging the PR for main changes', (t) => {
  const r = repository(t);
  r.git('switch', '-qc', 'feature');
  r.source('src/feature.ts', 10);
  r.commit();
  r.git('switch', '-q', 'main');
  r.source('src/main.ts', 601);
  const base = r.commit();
  r.git('switch', '-q', 'feature');
  r.git('merge', '-qm', 'merge main', 'main');
  assert.equal(r.check([`--base=${base}`]), 0);
});

test('a merge follows each parent’s renames: a file the branch renamed keeps the ceiling main grew it to', (t) => {
  const r = repository(t);
  r.source('src/shared.ts', 400);
  r.commit();
  r.git('switch', '-qc', 'feature');
  r.git('mv', 'src/shared.ts', 'src/renamed.ts');
  r.source('src/feature.ts', 10);
  r.commit();
  r.git('switch', '-q', 'main');
  r.source('src/shared.ts', 503);
  r.commit();
  r.git('switch', '-q', 'feature');
  r.git('merge', '-q', '--no-commit', 'main');
  assert.equal(r.check(), 0, 'main’s growth arrives under the branch’s new name');
  r.source('src/renamed.ts', 504);
  r.git('add', '.');
  assert.equal(r.check(), 1, 'a merge resolution that grows past both parents is the merge commit’s growth');
  assert.ok(r.logs.some((line) => line.includes('src/renamed.ts: 504 lines exceeds 503')));
});

test('a merge commit takes a file another parent grew without counting it as growth; its own resolution still counts (#2268)', (t) => {
  const r = repository(t);
  r.source('src/shared.ts', 480);
  r.commit();
  r.git('checkout', '-q', '-b', 'feature');
  r.source('src/feature.ts', 10);
  r.commit();
  // main grows the file past the cap (two PRs each under it, merged), and the branch merges main in
  r.git('checkout', '-q', 'main');
  r.source('src/shared.ts', 503);
  r.commit();
  r.git('checkout', '-q', 'feature');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
  assert.equal(r.check(), 0, r.logs.join('\n'));
  // main's blob as it is: skipped like any file this commit didn't change
  assert.ok(!r.logs.some((line) => line.includes('src/shared.ts')), r.logs.join('\n'));
  // a resolution between the parents keeps the larger ceiling; one past both is this commit's growth
  r.write('src/shared.ts', '// resolved\n'.repeat(502));
  r.git('add', 'src/shared.ts');
  assert.equal(r.check(), 0, r.logs.join('\n'));
  r.source('src/shared.ts', 510);
  r.git('add', 'src/shared.ts');
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.includes('src/shared.ts: 510 lines exceeds 503')));
  // once the merge is gone, the branch's own commit is judged against its HEAD alone
  r.git('merge', '--abort');
  r.source('src/shared.ts', 503);
  r.git('add', 'src/shared.ts');
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.includes('src/shared.ts: 503 lines exceeds 500')));
});

test('an octopus merge reads every MERGE_HEAD line; one that names no commit fails closed', (t) => {
  const r = repository(t);
  r.source('src/a.ts', 10);
  r.source('src/b.ts', 10);
  r.commit();
  for (const [branch, file] of [
    ['grow-a', 'src/a.ts'],
    ['grow-b', 'src/b.ts'],
  ]) {
    r.git('checkout', '-q', '-b', branch, 'main');
    r.source(file, 520);
    r.commit();
  }
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-commit', '--no-ff', 'grow-a', 'grow-b');
  assert.equal(r.check(), 0, r.logs.join('\n'));
  writeFileSync(path.join(r.cwd, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);
  assert.equal(r.check(), 1);
  assert.ok(r.logs.some((line) => line.startsWith('file-size: git rev-parse failed')));
});

test('a staged file larger than the default child-output buffer is read whole, not failed', (t) => {
  const r = repository(t);
  // 1.6 MB in four lines: well under the line limit, past the 1 MB a captured git output holds by default
  r.write('src/generated.ts', `${'x'.repeat(400_000)}\n`.repeat(4));
  r.git('add', '.');
  assert.equal(r.check(), 0, r.logs.join('\n'));
});
