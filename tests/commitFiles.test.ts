// The Changes pane's commit with real git (electron/platform/commitFiles.cjs, its IPC, and src/lib/commitFiles.ts's sentences): only the ticked files are committed, built in an index of its own, so a commit that fails leaves the index as it was; a merge under way is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFailure } from '../src/lib/commitFiles.ts';

const require = createRequire(import.meta.url);
const { commitFiles } = require('../electron/platform/commitFiles.cjs');
const { register } = require('../electron/app/ipc/commitFiles.cjs');

function repo(t: any) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commitfiles-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trimEnd();
  const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  sh('init', '--quiet', '--initial-branch=main');
  sh('config', 'user.name', 't');
  sh('config', 'user.email', 't@example.invalid');
  sh('config', 'commit.gpgsign', 'false');
  for (const f of ['a', 'b', 'old', 'old2', 'del', 'del2', 'foo']) write(f, `${f}\n`);
  sh('add', '.');
  sh('commit', '--quiet', '-m', 'first');
  return { dir, sh, write };
}

test('only the ticked files are committed; every other change stays as it was, staged or not', async (t) => {
  const r = repo(t);
  r.write('a', 'a2\n');
  r.write('b', 'b2\n');
  r.sh('add', 'b');
  // a rename and a deletion both staged and not, a new file with a glob character in its name, one left untracked
  r.sh('mv', 'old', 'new');
  fs.renameSync(path.join(r.dir, 'old2'), path.join(r.dir, 'new2'));
  r.sh('rm', '--quiet', 'del');
  fs.rmSync(path.join(r.dir, 'del2'));
  r.write('star*', 'n\n');
  r.write('c', 'c\n');
  const picked = [
    { path: 'a' },
    { path: 'new', oldPath: 'old' },
    { path: 'new2', oldPath: 'old2' },
    { path: 'del', isDeleted: true },
    { path: 'del2', isDeleted: true },
    { path: 'star*' },
  ];
  const done = await commitFiles(r.dir, 'some', picked);
  assert.equal(done.ok, true, done.stderr);
  assert.deepEqual(
    r.sh('show', '--name-status', '--format=', '-M', 'HEAD').split('\n').sort(),
    ['D\tdel', 'D\tdel2', 'M\ta', 'R100\told\tnew', 'R100\told2\tnew2', 'A\tstar*'].sort(),
  );
  assert.deepEqual(r.sh('status', '--porcelain').split('\n'), ['M  b', '?? c']);
});

test('a ticked file is committed as it is on disk; a commit a hook stops leaves the index as it was, staged hunks too', async (t) => {
  const r = repo(t);
  r.write('a', 'staged\n');
  r.sh('add', 'a');
  r.write('a', 'staged\nand not\n');
  r.write('b', 'b2\n');
  const before = r.sh('diff', '--cached');
  fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 });
  const stopped = await commitFiles(r.dir, 'm', [{ path: 'a' }, { path: 'b' }]);
  assert.equal(stopped.ok, false);
  assert.equal(r.sh('diff', '--cached'), before);
  assert.equal(r.sh('rev-list', '--count', 'HEAD'), '1');
  fs.rmSync(path.join(r.dir, '.git', 'hooks', 'pre-commit'));
  assert.equal((await commitFiles(r.dir, 'm', [{ path: 'a' }])).ok, true);
  assert.equal(r.sh('show', 'HEAD:a'), 'staged\nand not');
  assert.deepEqual(r.sh('status', '--porcelain').split('\n'), [' M b']);
});

test('a case-only rename is committed with ticks too', async (t) => {
  const r = repo(t);
  r.sh('mv', 'foo', 'Foo');
  r.write('b', 'b2\n');
  const done = await commitFiles(r.dir, 'case', [{ path: 'Foo', oldPath: 'foo' }]);
  assert.equal(done.ok, true, done.stderr);
  const names = r.sh('ls-tree', '--name-only', 'HEAD').split('\n');
  assert.deepEqual([names.includes('Foo'), names.includes('foo')], [true, false]);
  assert.deepEqual(r.sh('status', '--porcelain').split('\n'), [' M b']);
});

test('a merge under way is refused before anything is staged; so are an empty list and a bad request', async (t) => {
  const r = repo(t);
  r.sh('switch', '--quiet', '-c', 'side');
  r.write('a', 'side\n');
  r.sh('commit', '--quiet', '-am', 'side');
  r.sh('switch', '--quiet', 'main');
  r.write('a', 'main\n');
  r.sh('commit', '--quiet', '-am', 'main');
  assert.throws(() => r.sh('merge', '--quiet', 'side'));
  r.write('c', 'c\n');
  const conflicted = r.sh('ls-files', '-u');
  assert.deepEqual(await commitFiles(r.dir, 'm', [{ path: 'a' }]), {
    ok: false,
    stdout: '',
    stderr: 'Finish or abort the merge, rebase, cherry-pick or revert under way before committing only some files.',
    refused: true,
  });
  assert.equal(r.sh('ls-files', '-u'), conflicted, 'the conflict is still unresolved');
  r.sh('merge', '--abort');
  for (const [root, message, files] of [
    ['rel', 'm', []],
    [r.dir, ' ', []],
    [r.dir, 'm', [{ path: '/abs' }]],
    [r.dir, 'm', 'a'],
    [r.dir, 'm', [{ path: 'a', oldPath: 3 }]],
  ] as const)
    assert.equal((await commitFiles(root, message, files)).stderr, 'Invalid commit request.');
  assert.equal((await commitFiles(r.dir, 'm', [])).stderr, 'No files are selected to commit.');
});

test('no list commits every change; a new repository’s first commit can be some of its files', async (t) => {
  const r = repo(t);
  r.write('a', 'a2\n');
  r.write('c', 'c\n');
  assert.equal((await commitFiles(r.dir, 'all', null)).ok, true);
  assert.equal(r.sh('status', '--porcelain'), '');
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commitfiles-new-')));
  t.after(() => fs.rmSync(fresh, { recursive: true, force: true }));
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 't'],
    ['config', 'user.email', 't@example.invalid'],
  ])
    execFileSync('git', args, { cwd: fresh });
  fs.writeFileSync(path.join(fresh, 'x'), 'x');
  fs.writeFileSync(path.join(fresh, 'y'), 'y');
  assert.equal((await commitFiles(fresh, 'first', [{ path: 'x' }])).ok, true);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: fresh }).toString().trim(), '?? y');
});

test('git failing at a step stops there, and the IPC hands the request to main', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const at = (step: string, over: Record<string, { ok: boolean; stdout?: string }> = {}) =>
      commitFiles('/r', 'm', [{ path: 'a' }, { path: 'd', isDeleted: true }], {
        git: async (args: string[]) => ({
          stdout: '',
          stderr: step,
          ...(over[args[0]] ??
            (args[0] === 'rev-parse'
              ? args.includes('--git-path')
                ? { ok: true, stdout: '' }
                : { ok: true, stdout: 'a'.repeat(40) }
              : args[0] === 'diff-tree'
                ? { ok: true, stdout: 'a\0' }
                : { ok: args[0] !== step })),
        }),
      });
    for (const step of ['read-tree', 'rm', 'add', 'commit']) assert.deepEqual(await at(step), { ok: false, stdout: '', stderr: step });
    // the index can't be read for operations under way or conflicts: refused
    assert.equal((await at('', { 'rev-parse': { ok: false } })).refused, true);
    assert.match((await at('', { 'ls-files': { ok: false } })).stderr, /Resolve the conflicts/);
    // committed, but the repository's index couldn't take it: said as a warning, not a failure
    for (const over of [{ reset: { ok: false } }, { 'diff-tree': { ok: false } }] as Record<string, { ok: boolean }>[]) {
      const r = await at('', over);
      assert.equal(r.ok, true);
      assert.match(r.warning, /run git status before committing again/);
    }
    assert.equal((await at('', { 'diff-tree': { ok: true, stdout: '' } })).warning, undefined);
  } finally {
    console.warn = warn;
  }
  const handlers = new Map<string, (...a: any[]) => any>();
  register({ handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) });
  assert.equal((await handlers.get('git:commitFiles')!({}, 'rel', 'm', null)).stderr, 'Invalid commit request.');
});

test('a file left in conflict (a stash pop, a stopped rebase) is refused, the conflict kept; a hook’s own staging reaches the index', async (t) => {
  const r = repo(t);
  r.write('a', 'stashed\n');
  r.sh('stash', 'push', '--quiet');
  r.write('a', 'committed\n');
  r.sh('commit', '--quiet', '-am', 'other');
  assert.throws(() => r.sh('stash', 'pop', '--quiet'));
  const conflicted = r.sh('ls-files', '-u');
  assert.ok(conflicted);
  assert.equal((await commitFiles(r.dir, 'm', [{ path: 'a' }])).stderr, 'Resolve conflicts in 1 file first.');
  // ticking only other files, or the conflicted one among them, refuses too: a stale pane can never commit the markers
  r.write('b', 'b2\n');
  for (const picked of [[{ path: 'b' }], [{ path: 'b' }, { path: 'a' }]])
    assert.deepEqual(await commitFiles(r.dir, 'm', picked), {
      ok: false,
      stdout: '',
      stderr: 'Resolve conflicts in 1 file first.',
      refused: true,
    });
  r.sh('checkout', '--quiet', 'HEAD', '--', 'b');
  assert.equal(r.sh('ls-files', '-u'), conflicted);
  r.sh('checkout', '--quiet', 'HEAD', '--', 'a');
  r.sh('stash', 'drop', '--quiet');
  // a hook that makes and stages a file: committed, and the index has it as committed, not as a deletion
  fs.writeFileSync(path.join(r.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho made > gen.txt\ngit add gen.txt\n', { mode: 0o755 });
  r.write('b', 'b2\n');
  assert.equal((await commitFiles(r.dir, 'm', [{ path: 'b' }])).ok, true);
  assert.equal(r.sh('show', 'HEAD:gen.txt'), 'made');
  assert.equal(r.sh('status', '--porcelain'), '');
});

test('a commit made meanwhile (an agent’s) is never undone: the branch moving refuses the commit', async (t) => {
  const r = repo(t);
  r.write('b', 'b2\n');
  let moved = false;
  const git = require('../electron/platform/gitRun.cjs').git;
  const result = await commitFiles(r.dir, 'm', [{ path: 'b' }], {
    git: async (args: string[], cwd: string, timeout?: number, env?: any) => {
      // the agent commits while the ticked files are being added
      if (args[0] === 'add' && !moved) {
        moved = true;
        r.write('a', 'agent\n');
        r.sh('commit', '--quiet', '-m', 'agent', '--', 'a');
      }
      return git(args, cwd, timeout, env);
    },
  });
  assert.equal(result.stderr, 'The branch moved while the commit was being made. Try again.');
  assert.equal(r.sh('log', '-1', '--format=%s'), 'agent');
  assert.equal(r.sh('status', '--porcelain'), ' M b');
});

test('a failed commit says what is wrong in a sentence; git’s own words go to the log', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const cases: [string, string][] = [
    ['nothing to commit, working tree clean', 'There is nothing to commit.'],
    ['no changes added to commit', 'There is nothing to commit.'],
    ['*** Please tell me who you are.', 'Git doesn’t know who you are. Set user.name and user.email in git, then try again.'],
    [
      "fatal: Unable to create '/r/.git/index.lock': File exists.",
      'Another git command is using this repository. Try again when it finishes.',
    ],
    ['hint: The pre-commit hook was ignored', 'A commit hook stopped the commit. Its output is in the log.'],
    // a path with "hook" in it is no hook
    [
      "fatal: pathspec ':(literal)src/hooks/useX.ts' did not match any files",
      'Git couldn’t commit. Its output, or a commit hook’s, is in the log.',
    ],
  ];
  for (const [stderr, said] of cases) assert.equal(commitFailure({ stdout: '', stderr }), said, stderr);
  assert.equal(commitFailure({ stdout: '', stderr: 'Already a sentence.', refused: true }), 'Already a sentence.');
  assert.match(String(warn.mock.calls[0].arguments[0]), /nothing to commit/);
});

test('a commit of every change refuses while a file is in conflict, naming how many, and takes it once resolved; a merge under way with none is committable', async (t) => {
  const r = repo(t);
  r.write('a', 'stashed\n');
  r.write('b', 'stashed\n');
  r.sh('stash', 'push', '--quiet');
  r.write('a', 'committed\n');
  r.write('b', 'committed\n');
  r.sh('commit', '--quiet', '-am', 'other');
  assert.throws(() => r.sh('stash', 'pop', '--quiet'));
  const head = r.sh('rev-parse', 'HEAD');
  assert.match(r.sh('status', '--porcelain'), /^UU a\nUU b/);
  assert.deepEqual(await commitFiles(r.dir, 'markers', null), {
    ok: false,
    stdout: '',
    stderr: 'Resolve conflicts in 2 files first.',
    refused: true,
  });
  assert.equal(r.sh('rev-parse', 'HEAD'), head, 'nothing was committed');
  assert.match(r.sh('status', '--porcelain'), /^UU a\nUU b/, 'the markers were not staged as resolved');
  // one left: the sentence is singular
  r.write('a', 'resolved\n');
  r.sh('add', 'a');
  assert.equal((await commitFiles(r.dir, 'markers', null)).stderr, 'Resolve conflicts in 1 file first.');
  r.write('b', 'resolved\n');
  r.sh('add', 'b');
  assert.equal((await commitFiles(r.dir, 'resolved', null)).ok, true);
  // a merge that stopped before committing, with nothing in conflict, is committed as it stands
  r.sh('stash', 'drop', '--quiet');
  r.sh('switch', '--quiet', '-c', 'side');
  r.write('c', 'side\n');
  r.sh('add', 'c');
  r.sh('commit', '--quiet', '-m', 'side');
  r.sh('switch', '--quiet', 'main');
  r.sh('merge', '--no-commit', '--no-ff', '--quiet', 'side');
  assert.ok(fs.existsSync(path.join(r.dir, '.git', 'MERGE_HEAD')));
  assert.equal((await commitFiles(r.dir, 'merged', null)).ok, true);
  // the check itself failing is a refusal, not a commit
  const git = async (args: string[]) => ({ ok: args[0] !== 'ls-files', stdout: '', stderr: '' });
  assert.deepEqual(await commitFiles(r.dir, 'm', null, { git }), {
    ok: false,
    stdout: '',
    stderr: 'Could not check for unresolved conflicts. Try again.',
    refused: true,
  });
});
