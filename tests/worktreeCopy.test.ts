// electron/platform/worktreeCopy.cjs with a real repository: which ignored files a new worktree gets, what is never written, the bounds, and what is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { copyIgnored, copyIgnoredFrom } = require('../electron/platform/worktreeCopy.cjs');
const git = require('../electron/platform/git.cjs');

/** A repository with ignored and untracked files, and a second checkout of it standing in for the new worktree. */
function setup(t: any, ignore = '.env\n*.env.local\n.env.local\nsecrets/\nnode_modules/\n') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtcopy-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'app');
  fs.mkdirSync(repo);
  const run = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo });
  const write = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  run('init', '--quiet', '--initial-branch=trunk');
  write(repo, '.gitignore', ignore);
  write(repo, 'a.txt', 'a');
  run('add', '.');
  run('commit', '--quiet', '-m', 'first');
  const dir = path.join(home, 'tree');
  run('worktree', 'add', '--quiet', '-b', 'task', dir);
  const warned: string[] = [];
  const copy = (patterns: string[], o: object = {}) =>
    copyIgnored(repo, dir, {
      resolve: () => ({ copy: patterns, copyError: null, copySource: 'worktreeinclude' }),
      warn: (_what: string, error: Error) => warned.push(error.message),
      ...o,
    });
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
  return { home, repo, dir, run, write, copy, read, warned };
}

test('ignored files that match are copied to the same place; tracked, unignored and unmatched files are not', async (t) => {
  const s = setup(t);
  s.write(s.repo, '.env', 'ROOT=1');
  s.write(s.repo, 'apps/web/.env.local', 'WEB=1');
  s.write(s.repo, '.env.example', 'untracked, not ignored');
  s.write(s.repo, 'secrets/key.pem', 'ignored, not matched');
  s.write(s.repo, 'node_modules/pkg/.env', 'in an ignored folder');
  const r = await s.copy(['.env*']);
  assert.deepEqual(r, { copied: ['.env', 'apps/web/.env.local', 'node_modules/pkg/.env'], skipped: [], problem: null, notice: '' });
  assert.deepEqual([s.read('.env'), s.read('apps/web/.env.local')], ['ROOT=1', 'WEB=1']);
  assert.equal(fs.existsSync(path.join(s.dir, '.env.example')), false);
  assert.equal(fs.existsSync(path.join(s.dir, 'secrets')), false);
  assert.deepEqual(s.warned, []);
  // the .env* default, which nobody wrote for this repository, stays out of folders git ignores as a whole
  for (const rel of ['.env', 'apps', 'node_modules']) fs.rmSync(path.join(s.dir, rel), { recursive: true });
  s.write(s.repo, 'new/.env.local', 'in an untracked folder');
  s.write(s.repo, 'new/.env.example', 'untracked, not ignored');
  const byDefault = await s.copy(['.env*'], { resolve: () => ({ copy: ['.env*'], copyError: null, copySource: 'default' }) });
  assert.deepEqual(byDefault.copied, ['.env', 'apps/web/.env.local', 'new/.env.local']);
  assert.equal(fs.existsSync(path.join(s.dir, 'node_modules')), false);
  fs.rmSync(path.join(s.dir, 'new'), { recursive: true });
  // a project that is a folder of its repository: files land where they are in the repository
  fs.rmSync(path.join(s.dir, 'apps'), { recursive: true });
  const sub = await copyIgnoredFrom(path.join(s.repo, 'apps', 'web'), s.dir, {
    resolve: () => ({ copy: ['.env.local'], copyError: null }),
  });
  assert.deepEqual(sub.copied, ['apps/web/.env.local', 'new/.env.local']);
  assert.equal(s.read('apps/web/.env.local'), 'WEB=1');
  // a later pattern takes files back out, as in a .gitignore
  fs.rmSync(path.join(s.dir, '.env'));
  fs.rmSync(path.join(s.dir, 'apps'), { recursive: true });
  assert.deepEqual((await s.copy(['.env*', '!.env.local'])).copied, ['.env', 'node_modules/pkg/.env']);
});

test('nothing is written over a file that is there, and a second copy changes nothing', async (t) => {
  const s = setup(t);
  s.write(s.repo, '.env', 'FROM_REPO');
  s.write(s.repo, '.env.local', 'LOCAL');
  s.write(s.dir, '.env', 'ALREADY_HERE');
  assert.deepEqual((await s.copy(['.env*'])).copied, ['.env.local']);
  assert.equal(s.read('.env'), 'ALREADY_HERE');
  // a link where the file would go, to a file or to nothing, is something that is there: nothing is written through it
  s.write(s.repo, 'x.env.local', 'X');
  s.write(s.repo, 'y.env.local', 'Y');
  s.write(s.home, 'target', 'UNTOUCHED');
  fs.symlinkSync(path.join(s.home, 'target'), path.join(s.dir, 'x.env.local'));
  fs.symlinkSync(path.join(s.home, 'nothing'), path.join(s.dir, 'y.env.local'));
  assert.deepEqual(await s.copy(['*.env.local']), { copied: [], skipped: [], problem: null, notice: '' });
  assert.equal(fs.readFileSync(path.join(s.home, 'target'), 'utf8'), 'UNTOUCHED');
  assert.equal(fs.existsSync(path.join(s.home, 'nothing')), false);
  s.write(s.repo, '.env.local', 'CHANGED_SINCE');
  assert.deepEqual(await s.copy(['.env*']), { copied: [], skipped: [], problem: null, notice: '' });
  assert.equal(s.read('.env.local'), 'LOCAL');
});

test('a link is not followed, and nothing is written through a folder that leads out of the worktree', async (t) => {
  const s = setup(t);
  const outside = path.join(s.home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(s.home, 'passwd'), 'not the repository’s');
  fs.symlinkSync(path.join(s.home, 'passwd'), path.join(s.repo, '.env'));
  s.write(s.repo, 'apps/.env.local', 'APPS');
  s.write(s.repo, 'deep/er/.env.local', 'DEEP');
  // the branch has `apps` as a link out of the worktree, and `deep` as a link whose target is gone
  fs.symlinkSync(outside, path.join(s.dir, 'apps'));
  fs.symlinkSync(path.join(s.home, 'nowhere'), path.join(s.dir, 'deep'));
  // and the branch has a file where another's folder would be
  s.write(s.repo, 'conf/.env.local', 'CONF');
  s.write(s.dir, 'conf', 'a file');
  const r = await s.copy(['.env*']);
  assert.deepEqual(r.copied, []);
  assert.deepEqual(r.skipped, [
    { path: '.env', reason: 'not a regular file' },
    { path: 'apps/.env.local', reason: 'its folder leads outside the worktree' },
    { path: 'conf/.env.local', reason: "its folder couldn't be made" },
    { path: 'deep/er/.env.local', reason: 'its folder leads outside the worktree' },
  ]);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(s.home, 'nowhere')), false);
  assert.equal(
    r.notice,
    "Not copied into the worktree: .env (not a regular file), apps/.env.local (its folder leads outside the worktree), conf/.env.local (its folder couldn't be made), and 1 more",
  );
  // the system's own words go to the record, and the line for the user is recorded last
  assert.match(s.warned[0], /EEXIST/);
  assert.deepEqual(s.warned.slice(1), [r.notice]);
});

test('the copy is bounded: by file size, by how many files and by their size together', async (t) => {
  const s = setup(t, '*.env\n');
  for (const n of ['a', 'b', 'c', 'd', 'e']) s.write(s.repo, `${n}.env`, n === 'c' ? 'x'.repeat(50) : 'xxxx');
  const big = await s.copy(['*.env'], { maxFileBytes: 10 });
  assert.deepEqual([big.copied, big.skipped], [['a.env', 'b.env', 'd.env', 'e.env'], [{ path: 'c.env', reason: 'too large to copy' }]]);
  for (const n of ['a', 'b', 'd', 'e']) fs.rmSync(path.join(s.dir, `${n}.env`));
  const many = await s.copy(['*.env'], { maxFiles: 2 });
  assert.deepEqual([many.copied, many.problem], [['a.env', 'b.env'], 'Only the first 2 files were copied into the worktree']);
  for (const n of ['a', 'b']) fs.rmSync(path.join(s.dir, `${n}.env`));
  const heavy = await s.copy(['*.env'], { maxTotalBytes: 9 });
  assert.deepEqual(
    [heavy.copied, heavy.problem],
    [['a.env', 'b.env'], 'Not every file was copied into the worktree: together they are too large'],
  );
  // more than three left out: the line names three and counts the rest
  for (const n of ['a', 'b']) fs.rmSync(path.join(s.dir, `${n}.env`));
  const none = await s.copy(['*.env'], { maxFileBytes: 1 });
  assert.equal(
    none.notice,
    'Not copied into the worktree: a.env (too large to copy), b.env (too large to copy), c.env (too large to copy), and 2 more',
  );
});

test('no patterns: git is not asked; an unreadable pattern file is said even so', async (t) => {
  const s = setup(t);
  s.write(s.repo, '.env', 'x');
  let asked = 0;
  const git$ = async () => {
    asked++;
    return { ok: true, stdout: '', stderr: '' };
  };
  assert.deepEqual(await s.copy([], { git: git$ }), { copied: [], skipped: [], problem: null, notice: '' });
  const r = await s.copy([], { git: git$, resolve: () => ({ copy: [], copyError: '/r/.worktreeinclude couldn’t be read (EACCES)' }) });
  assert.equal(r.notice, '/r/.worktreeinclude couldn’t be read (EACCES)');
  assert.equal(asked, 0);
  // a folder git can't place is used as it is
  assert.equal((await copyIgnoredFrom(s.repo, s.dir, { git: git$, resolve: () => ({ copy: [], copyError: null }) })).notice, '');
  assert.equal(asked, 1);
  // with no one given to tell, main's own record of ignored errors gets it
  const { recentIgnored: recent } = require('../electron/ignored.cjs');
  await copyIgnored(s.repo, s.dir, { resolve: () => ({ copy: [], copyError: 'the pattern file is unreadable' }) });
  assert.ok(recent().some((e: any) => e.context === 'copy files into a new worktree' && e.message === 'the pattern file is unreadable'));
});

test('a listing that fails, a path git should never give, a copy that fails and config that throws are reported, not thrown', async (t) => {
  const s = setup(t);
  s.write(s.repo, '.env', 'x');
  const answers = (matched: object, ignored: object) => async (args: string[]) => ({
    ok: true,
    stdout: '',
    stderr: '',
    ...(args.includes('--exclude-standard') ? ignored : matched),
  });
  const cannot = "The files to copy into the worktree couldn't be listed (too many match, or git failed), so none were copied";
  const failed = await s.copy(['.env*'], { git: answers({ ok: false, stderr: 'fatal: bad pattern\nmore' }, {}) });
  const slow = await s.copy(['.env*'], {
    git: answers({}, { ok: false }),
    resolve: () => ({ copy: ['.env*'], copyError: 'The pattern file is unreadable' }),
  });
  assert.deepEqual([failed.problem, slow.problem], [cannot, `The pattern file is unreadable. ${cannot}`]);
  assert.deepEqual(s.warned, ['fatal: bad pattern', cannot, 'timed out, or too much to list', `The pattern file is unreadable. ${cannot}`]);
  const odd = await s.copy(['.env*'], {
    git: answers({ stdout: '../up/.env\0/abs/.env\0nested/\0.env\0' }, { stdout: '../up/.env\0/abs/.env\0nested/\0.env\0' }),
    copyFile: async () => {
      throw new Error('disk full\nat somewhere');
    },
  });
  assert.deepEqual(odd.skipped, [
    { path: '../up/.env', reason: 'not a path inside the repository' },
    { path: '.env', reason: "it couldn't be copied" },
    { path: '/abs/.env', reason: 'not a path inside the repository' },
  ]);
  const thrown = await s.copy(['.env*'], {
    resolve: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual([thrown.copied, thrown.problem], [[], "The files to copy into the worktree couldn't be read"]);
  assert.ok(s.warned.includes('boom') && s.warned.some((w) => w.startsWith('disk full')));
});

test('a worktree made by MoPilot gets the files its repository names, before anything runs in it', async (t) => {
  const s = setup(t);
  t.mock.method(os, 'homedir', () => s.home);
  s.write(s.repo, '.worktreeinclude', '# local config\n.env*\n');
  s.write(s.repo, '.env', 'ROOT=1');
  const made = await git.worktreeAdd(s.repo, { root: path.join(s.home, 'trees') });
  assert.equal(made.ok, true);
  assert.deepEqual(made.copy, { copied: ['.env'], skipped: [], problem: null, notice: '' });
  assert.equal(fs.readFileSync(path.join(made.worktree, '.env'), 'utf8'), 'ROOT=1');
  // removed and brought back from its branch: it gets them again
  fs.rmSync(path.dirname(made.worktree), { recursive: true });
  const back = await git.worktreeRestore(made.worktree, path.join(s.home, 'trees'), s.repo);
  assert.deepEqual([back.restored, back.copy.copied], [true, ['.env']]);
});
