// electron/platform/worktreeAdopt.cjs through git.cjs, with real repositories: a worktree made elsewhere becomes a managed one in place and is never removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const { adoptedInfo, ADOPT_MARKER } = require('../electron/platform/worktreeAdopt.cjs');
const { FIRST_PORT } = require('../electron/platform/worktreePorts.cjs');

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

/** A project with two workspaces laid out as Conductor does: ~/conductor/workspaces/<repo>/<name>, siblings in one folder. */
function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const repo = path.join(home, 'src', 'app');
  fs.mkdirSync(repo, { recursive: true });
  run(repo, 'init', '--quiet', '--initial-branch=trunk');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  run(repo, 'add', '.');
  run(repo, 'commit', '--quiet', '-m', 'first');
  const spaces = path.join(home, 'conductor', 'workspaces', 'app');
  fs.mkdirSync(spaces, { recursive: true });
  const tokyo = path.join(spaces, 'tokyo');
  const lima = path.join(spaces, 'lima');
  run(repo, 'worktree', 'add', '--quiet', '-b', 'feat/tokyo', tokyo);
  run(repo, 'worktree', 'add', '--quiet', '-b', 'feat/lima', lima);
  return { home, repo, spaces, tokyo, lima };
}

test('an adopted worktree is managed where it is, on its own branch; its sibling in the same folder is not', async (t) => {
  const { repo, spaces, tokyo, lima } = setup(t);
  assert.equal(git.worktreeInfo(tokyo), null);
  const r = await git.worktreeAdopt(tokyo);
  assert.deepEqual(r, { ok: true, adopted: true, path: tokyo, repo, branch: 'feat/tokyo' });
  const info = git.worktreeInfo(tokyo);
  assert.equal(info.adopted, true);
  assert.equal(info.repo, repo);
  assert.equal(info.branch, 'feat/tokyo');
  assert.ok(info.createdAt > 0);
  fs.mkdirSync(path.join(tokyo, 'pkg'));
  assert.equal(git.worktreeInfo(path.join(tokyo, 'pkg')).path, tokyo, 'a subfolder is the same worktree');
  assert.equal(git.worktreeInfo(lima), null, 'the sibling was not adopted');
  assert.equal(git.worktreeInfo(spaces), null);
  assert.equal(git.worktreeInfo(repo), null, 'the project itself is not a worktree');
  // nothing was moved, checked out or written into the checkout
  assert.equal(run(tokyo, 'status', '--porcelain').toString(), '');
  assert.equal(run(tokyo, 'symbolic-ref', '--short', 'HEAD').toString().trim(), 'feat/tokyo');
  assert.deepEqual(fs.readdirSync(spaces).sort(), ['lima', 'tokyo']);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'worktrees', 'tokyo', ADOPT_MARKER)), true);
  // the branch is read as it is now, not as it was when adopted
  run(tokyo, 'switch', '--quiet', '-c', 'feat/renamed');
  assert.equal(git.worktreeInfo(tokyo).branch, 'feat/renamed');
  run(tokyo, 'switch', '--quiet', 'feat/tokyo');
  // the same worktree through another spelling of its path
  fs.symlinkSync(spaces, path.join(path.dirname(spaces), 'link'));
  assert.equal(git.worktreeInfo(path.join(path.dirname(spaces), 'link', 'tokyo')).repo, repo);
  // adopting again changes nothing
  const before = fs.readFileSync(path.join(repo, '.git', 'worktrees', 'tokyo', ADOPT_MARKER), 'utf8');
  assert.deepEqual(await git.worktreeAdopt(tokyo), { ok: true, adopted: false, path: tokyo, repo, branch: 'feat/tokyo' });
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'worktrees', 'tokyo', ADOPT_MARKER), 'utf8'), before);
});

test('an adopted worktree is never removed from here, and its scripts get its variables under its folder name', async (t) => {
  const { repo, tokyo, lima } = setup(t);
  await git.worktreeAdopt(tokyo);
  await git.worktreeAdopt(lima);
  assert.equal(await git.removeWorktree({ path: tokyo, repo }), false);
  assert.equal(fs.existsSync(path.join(tokyo, 'a.txt')), true);
  assert.match(run(repo, 'worktree', 'list').toString(), /tokyo/);
  const env = git.worktreeEnv(tokyo);
  assert.equal(env.CONDUCTOR_WORKSPACE_NAME, 'tokyo');
  assert.equal(env.MOPILOT_WORKSPACE_PATH, tokyo);
  assert.equal(env.CONDUCTOR_ROOT_PATH, repo);
  assert.equal(env.CONDUCTOR_PORT, String(FIRST_PORT));
  assert.equal(git.worktreeEnv(lima).CONDUCTOR_PORT, String(FIRST_PORT + 10));
  // git removing the worktree (the tool that made it, or the user) ends the adoption with it
  run(repo, 'worktree', 'remove', '--force', tokyo);
  assert.equal(git.worktreeInfo(tokyo), null);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'worktrees', 'tokyo')), false);
});

test('a detached worktree is adopted without a branch', async (t) => {
  const { repo, tokyo } = setup(t);
  run(tokyo, 'switch', '--quiet', '--detach');
  assert.deepEqual(await git.worktreeAdopt(tokyo), { ok: true, adopted: true, path: tokyo, repo, branch: null });
  assert.equal(git.worktreeInfo(tokyo).branch, null);
});

test("one of MoPilot's own worktrees is left as it is", async (t) => {
  const { home, repo } = setup(t);
  const made = await git.worktreeAdd(repo, { root: path.join(home, 'trees') });
  const r = await git.worktreeAdopt(made.worktree);
  assert.deepEqual(r, { ok: true, adopted: false, path: made.worktree, repo, branch: made.branch });
  assert.equal(git.worktreeInfo(made.worktree).adopted, undefined);
  assert.equal(await git.removeWorktree({ path: made.worktree, repo }), true);
});

test('what is not a linked worktree is refused, and says why', async (t) => {
  const { home, repo, tokyo } = setup(t);
  const no = async (dir: any, why: RegExp) => {
    const r = await git.worktreeAdopt(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, why);
  };
  await no('relative', /No folder/);
  await no(undefined, /No folder/);
  await no(repo, /not a git worktree of another checkout/);
  await no(path.join(home, 'none'), /not a git worktree/);
  await no(path.join(tokyo, 'missing'), /not a git worktree/);
  fs.mkdirSync(path.join(tokyo, 'pkg'));
  await no(path.join(tokyo, 'pkg'), /not a git worktree/);
  // a submodule's .git is a file too, but it names .git/modules/<name>
  const sub = path.join(home, 'sub');
  fs.mkdirSync(path.join(repo, '.git', 'modules', 'sub'), { recursive: true });
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.join(repo, '.git', 'modules', 'sub')}\n`);
  await no(sub, /not a git worktree/);
  fs.writeFileSync(path.join(sub, '.git'), 'not a pointer\n');
  await no(sub, /not a git worktree/);
  assert.equal(adoptedInfo(sub), null);
  // a worktree of a bare repository has no project folder
  const bare = path.join(home, 'bare.git');
  execFileSync('git', ['clone', '--quiet', '--bare', repo, bare]);
  const ofBare = path.join(home, 'of-bare');
  run(bare, 'worktree', 'add', '--quiet', '-b', 'x', ofBare);
  await no(ofBare, /is bare/);
  assert.equal(git.worktreeInfo(ofBare), null);
});

test('a worktree inside a managed one is adopted as itself, not taken for the one around it', async (t) => {
  const { home, repo } = setup(t);
  const outer = await git.worktreeAdd(repo, { root: path.join(home, 'trees') });
  // Claude Code's layout: <checkout>/.claude/worktrees/<name>
  const inner = path.join(outer.worktree, '.claude', 'worktrees', 'x');
  fs.mkdirSync(path.dirname(inner), { recursive: true });
  run(repo, 'worktree', 'add', '--quiet', '-b', 'inner', inner);
  assert.equal(git.worktreeInfo(inner).path, outer.worktree, 'until adopted it reads as part of the outer one');
  assert.deepEqual(await git.worktreeAdopt(inner), { ok: true, adopted: true, path: inner, repo, branch: 'inner' });
  assert.equal(git.worktreeInfo(inner).path, inner);
  assert.equal(git.worktreeInfo(path.join(outer.worktree, 'a.txt')).path, outer.worktree);
});

test('a worktree written with relative pointers is adopted the same', async (t) => {
  const { repo, tokyo } = setup(t);
  const own = path.join(repo, '.git', 'worktrees', 'tokyo');
  fs.writeFileSync(path.join(tokyo, '.git'), `gitdir: ${path.relative(tokyo, own)}\r\n`);
  assert.deepEqual(await git.worktreeAdopt(tokyo), { ok: true, adopted: true, path: tokyo, repo, branch: 'feat/tokyo' });
});

test('git must name the folder back: a copy of a worktree, or a worktree whose repository moved, is not one', async (t) => {
  const { home, repo, tokyo } = setup(t);
  await git.worktreeAdopt(tokyo);
  const copy = path.join(path.dirname(tokyo), 'copy');
  fs.cpSync(tokyo, copy, { recursive: true });
  // the copy points at tokyo's private git folder, which holds the marker; it must not read as adopted, nor be adoptable
  assert.equal(git.worktreeInfo(copy), null);
  assert.match((await git.worktreeAdopt(copy)).error, /not a git worktree of another checkout/);
  assert.equal(git.worktreeInfo(tokyo).adopted, true);
  // the back pointer is gone, or names nothing
  const own = path.join(repo, '.git', 'worktrees', 'tokyo');
  const back = fs.readFileSync(path.join(own, 'gitdir'), 'utf8');
  fs.writeFileSync(path.join(own, 'gitdir'), `${path.join(home, 'nowhere', '.git')}\n`);
  assert.equal(git.worktreeInfo(tokyo), null);
  fs.rmSync(path.join(own, 'gitdir'));
  assert.equal(git.worktreeInfo(tokyo), null);
  fs.writeFileSync(path.join(own, 'gitdir'), back);
  assert.equal(git.worktreeInfo(tokyo).adopted, true);
  // the repository's git folder is gone
  fs.writeFileSync(path.join(own, 'commondir'), '../../missing\n');
  assert.equal(git.worktreeInfo(tokyo), null);
});

test('a marker that does not say adopted is not an adoption; an unreadable HEAD names no branch', async (t) => {
  const { repo, tokyo } = setup(t);
  await git.worktreeAdopt(tokyo);
  const own = path.join(repo, '.git', 'worktrees', 'tokyo');
  const marker = path.join(own, ADOPT_MARKER);
  fs.writeFileSync(marker, JSON.stringify({ repo }));
  assert.equal(git.worktreeInfo(tokyo), null);
  fs.writeFileSync(marker, 'not json');
  assert.equal(git.worktreeInfo(tokyo), null);
  fs.writeFileSync(marker, JSON.stringify({ adopted: true, createdAt: 'x' }));
  assert.deepEqual(adoptedInfo(tokyo), { path: tokyo, repo, branch: 'feat/tokyo', adopted: true, createdAt: 0 });
  fs.rmSync(path.join(own, 'HEAD'));
  assert.equal(adoptedInfo(tokyo).branch, null);
});
