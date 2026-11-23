// scripts/hook-check.mjs: repair, or else warn about, a checkout where git would not run this checkout's .githooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOKS, hookDiagnosis, main } from '../scripts/hook-check.mjs';

// Under a git hook or `rebase --exec` these point git at the developer's repository; the real-git tests below must
// only touch their temporary ones.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete process.env[name];

const problem = (deps: Parameters<typeof hookDiagnosis>[0]) => hookDiagnosis(deps)?.problem ?? null;

/** A checkout with every hook in .githooks, and a git that answers the hooks folder and the scopes that set it. */
function checkout(t: { after: (fn: () => void) => void }) {
  const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hook-check-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  mkdirSync(path.join(repoRoot, '.githooks'));
  for (const hook of HOOKS) writeFileSync(path.join(repoRoot, '.githooks', hook), '#!/bin/sh\n', { mode: 0o755 });
  const git =
    (hooks: string, scopes: string | Error = 'local\t.githooks\n') =>
    (args: string[]) => {
      if (args[0] === 'rev-parse') return `${hooks}\n`;
      if (scopes instanceof Error) throw scopes;
      return scopes;
    };
  return { repoRoot, git };
}

/**
 * A git whose hooks settings live in `config` by scope, applying the `git config` writes main makes; `calls` records
 * every write.
 */
function configGit(config: { worktree?: string; local?: string }) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    if (args[0] === 'rev-parse') return `${config.worktree ?? config.local ?? '.git/hooks'}\n`;
    if (args[1] === '--show-scope') {
      const lines = Object.entries(config).map(([scope, value]) => `${scope}\t${value}\n`);
      if (!lines.length) throw new Error('exit 1');
      return lines.join('');
    }
    calls.push(args);
    if (args[1] === '--worktree') delete config.worktree;
    else config.local = args[2];
    return '';
  };
  return { git, calls };
}

test('no problem when git runs this checkout’s own .githooks', (t) => {
  const { repoRoot, git } = checkout(t);
  assert.equal(problem({ git: git('.githooks'), repoRoot }), null);
  assert.equal(problem({ git: git(path.join(repoRoot, '.githooks')), repoRoot }), null);
});

test('a worktree pointed at another checkout’s hooks is told to drop its own setting', (t) => {
  const { repoRoot, git } = checkout(t);
  const other = '/elsewhere/.githooks';
  const found = problem({ git: git(other, 'local\t.githooks\nworktree\t/elsewhere/.githooks\n'), repoRoot });
  assert.match(found ?? '', /git uses hooks from \/elsewhere\/\.githooks, not .*\.githooks\./);
  assert.match(found ?? '', /`git config --worktree --unset core\.hooksPath` \(docs\/code-quality\.md\)\.$/);
  assert.deepEqual(hookDiagnosis({ git: git(other, 'worktree\t/elsewhere/.githooks\n'), repoRoot })?.fix, [
    'config',
    '--worktree',
    '--unset',
    'core.hooksPath',
  ]);
});

test('a hooks folder someone chose in the repository or global settings is reported, not repaired', (t) => {
  const { repoRoot, git } = checkout(t);
  for (const scopes of ['local\t/my/hooks\n', 'global\t/my/hooks\n']) {
    const found = hookDiagnosis({ git: git('/my/hooks', scopes), repoRoot });
    assert.equal(found?.fix, null);
    assert.match(
      found?.problem ?? '',
      /If that folder does not run \.githooks, use `git config core\.hooksPath \.githooks` \(docs\/code-quality\.md\)\.$/,
    );
  }
});

test('no hooks path at all is told to set the repository’s', (t) => {
  const { repoRoot, git } = checkout(t);
  // git config exits 1 when nothing sets core.hooksPath
  const unset = hookDiagnosis({ git: git('.git/hooks', new Error('exit 1')), repoRoot });
  assert.match(unset?.problem ?? '', /`git config core\.hooksPath \.githooks`/);
  assert.deepEqual(unset?.fix, ['config', 'core.hooksPath', '.githooks']);
});

test('a missing or non-executable hook in the right folder is named, and only restoring the files fixes it', (t) => {
  const { repoRoot, git } = checkout(t);
  // git ignores a hook that is not executable, and has none to run once it is gone
  chmodSync(path.join(repoRoot, '.githooks', 'pre-push'), 0o644);
  const one = hookDiagnosis({ git: git('.githooks'), repoRoot });
  assert.match(one?.problem ?? '', /The pre-push hook in .* is missing or not executable\. Restore with `git checkout -- \.githooks`/);
  assert.equal(one?.fix, null);
  rmSync(path.join(repoRoot, '.githooks', 'pre-commit'));
  assert.match(problem({ git: git('.githooks'), repoRoot }) ?? '', /The pre-commit and pre-push hooks in .* are missing or not executable/);
});

test('main repairs a worktree setting that points elsewhere, then the repository’s, and reports the repair', (t) => {
  const { repoRoot } = checkout(t);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const worktree = configGit({ worktree: '/elsewhere/.githooks', local: '.githooks' });
  assert.equal(main({ git: worktree.git, env: {}, log, repoRoot }), null);
  assert.deepEqual(worktree.calls, [['config', '--worktree', '--unset', 'core.hooksPath']]);
  assert.deepEqual(logs, ['hook-check: the git hooks did not run here; ran `git config --worktree --unset core.hooksPath`.']);
  // a worktree setting over nothing at all takes both repairs
  const both = configGit({ worktree: '/elsewhere/.githooks' });
  assert.equal(main({ git: both.git, env: {}, log, repoRoot }), null);
  assert.deepEqual(both.calls, [
    ['config', '--worktree', '--unset', 'core.hooksPath'],
    ['config', 'core.hooksPath', '.githooks'],
  ]);
  // a worktree setting over a repository folder someone chose: only the worktree's is dropped
  logs.length = 0;
  const chosen = configGit({ worktree: '/elsewhere/.githooks', local: '/my/hooks' });
  assert.match(main({ git: chosen.git, env: {}, log, repoRoot }) ?? '', /git uses hooks from \/my\/hooks/);
  assert.deepEqual(chosen.calls, [['config', '--worktree', '--unset', 'core.hooksPath']]);
  assert.match(logs.at(-1) ?? '', /^warning: .*If that folder does not run \.githooks/);
});

test('a repair that fails because another run already made it is not reported; one that keeps failing is', (t) => {
  const { repoRoot } = checkout(t);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  // the other run unsets the worktree setting just before this one tries to
  const raced = configGit({ worktree: '/elsewhere/.githooks', local: '.githooks' });
  const racing = (args: string[]) => {
    if (args[1] !== '--worktree') return raced.git(args);
    raced.git(args);
    throw new Error('exit 5: key does not exist');
  };
  assert.equal(main({ git: racing, env: {}, log, repoRoot }), null);
  assert.deepEqual(logs, []);
  // a setting git refuses to change
  const locked = configGit({ worktree: '/elsewhere/.githooks' });
  const refusing = (args: string[]) => {
    if (args[0] === 'config' && args[1] !== '--show-scope') throw new Error('could not lock config file');
    return locked.git(args);
  };
  assert.match(main({ git: refusing, env: {}, log, repoRoot }) ?? '', /git uses hooks from \/elsewhere/);
  assert.match(logs.at(-1) ?? '', /^warning: .* The repair failed: could not lock config file$/);
});

test('main warns when a repair does not take, or only the files can fix it', (t) => {
  const { repoRoot, git } = checkout(t);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  // a git that accepts the write but keeps answering another folder
  const stuck = (args: string[]) => (args[1] === 'core.hooksPath' ? '' : git('/elsewhere', new Error('exit 1'))(args));
  assert.match(main({ git: stuck, env: {}, log, repoRoot }) ?? '', /git uses hooks from \/elsewhere/);
  assert.equal(logs.filter((line) => line.startsWith('hook-check:')).length, 2);
  assert.match(logs.at(-1) ?? '', /^warning: The git hooks do not run here/);
  chmodSync(path.join(repoRoot, '.githooks', 'pre-commit'), 0o644);
  logs.length = 0;
  assert.match(main({ git: git('.githooks'), env: {}, log, repoRoot }) ?? '', /pre-commit hook .* missing or not executable/);
  assert.equal(logs.length, 1);
});

test('main stays quiet when healthy or in CI, and reports a failed check', (t) => {
  const { repoRoot, git } = checkout(t);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  assert.equal(main({ git: git('.githooks'), env: {}, log, repoRoot }), null);
  assert.deepEqual(logs, []);
  assert.equal(main({ git: git('/elsewhere'), env: { CI: 'true' }, log, repoRoot }), null);
  assert.deepEqual(logs, []);
  const broken = () => {
    throw new Error('not a git repository');
  };
  assert.match(main({ git: broken, env: {}, log, repoRoot }) ?? '', /Could not check the git hooks: not a git repository/);
  // the real git, in a directory that is no repository
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hook-check-none-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  // so git does not find a repository above the temporary folder
  const saved = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(outside);
  t.after(() => (saved === undefined ? delete process.env.GIT_CEILING_DIRECTORIES : (process.env.GIT_CEILING_DIRECTORIES = saved)));
  assert.match(main({ env: {}, log, repoRoot: outside }) ?? '', /^Could not check the git hooks: .*not a git repository/s);
});

test('the real git: a worktree setting pointing elsewhere is dropped and the hooks run', (t) => {
  const repoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hook-check-git-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  git(['init', '-q']);
  mkdirSync(path.join(repoRoot, '.githooks'));
  for (const hook of HOOKS) writeFileSync(path.join(repoRoot, '.githooks', hook), '#!/bin/sh\n', { mode: 0o755 });
  git(['config', 'core.hooksPath', '.githooks']);
  git(['config', 'extensions.worktreeConfig', 'true']);
  git(['config', '--worktree', 'core.hooksPath', '/elsewhere/.githooks']);
  const logs: string[] = [];
  assert.equal(main({ env: {}, log: (line) => logs.push(line), repoRoot }), null);
  const scopes = git(['config', '--show-scope', '--get-all', 'core.hooksPath']);
  assert.match(scopes, /^local\t\.githooks$/m);
  assert.doesNotMatch(scopes, /^worktree/m);
  assert.equal(logs.length, 1);
});

test('the command line exits 0 and leaves this checkout’s settings alone under CI', () => {
  // CI, so running the tests never rewrites the developer's own git configuration; the repair runs above, on a
  // temporary repository
  const r = spawnSync(process.execPath, ['scripts/hook-check.mjs'], { encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});
