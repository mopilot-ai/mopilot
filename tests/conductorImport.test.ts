// electron/platform/conductorImport.cjs with real repositories laid out as Conductor does: which workspaces are found, grouped by repository, and what is left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { discover, MAX_CANDIDATES } = require('../electron/platform/conductorImport.cjs');
const git = require('../electron/platform/git.cjs');

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

function home(t: any) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function repoAt(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '--quiet', '--initial-branch=trunk');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  run(dir, 'add', '.');
  run(dir, 'commit', '--quiet', '-m', 'first');
  return dir;
}

test('workspaces are found in both layouts and grouped by the repository git says they belong to', async (t) => {
  const h = home(t);
  const app = repoAt(path.join(h, 'code', 'app'));
  const api = repoAt(path.join(h, 'code', 'api'));
  const spaces = path.join(h, 'conductor', 'workspaces');
  fs.mkdirSync(path.join(spaces, 'app'), { recursive: true });
  // Conductor names the folder after the repository, but only git decides which repository a workspace is of
  fs.mkdirSync(path.join(spaces, 'renamed'), { recursive: true });
  run(app, 'worktree', 'add', '--quiet', '-b', 'feat/tokyo', path.join(spaces, 'app', 'tokyo'));
  run(app, 'worktree', 'add', '--quiet', '-b', 'feat/lima', path.join(spaces, 'app', 'lima'));
  run(api, 'worktree', 'add', '--quiet', '--detach', path.join(spaces, 'renamed', 'oslo'));
  // the older layout: inside the project, beside Conductor's settings files
  fs.mkdirSync(path.join(api, '.conductor'));
  fs.writeFileSync(path.join(api, '.conductor', 'settings.toml'), '');
  run(api, 'worktree', 'add', '--quiet', '-b', 'old', path.join(api, '.conductor', 'cairo'));
  await git.worktreeAdopt(path.join(spaces, 'app', 'lima'));

  const found = discover({ home: h, projects: [api, api, 'relative', path.join(h, 'none')] });
  assert.deepEqual(found, {
    repos: [
      {
        repo: api,
        name: 'api',
        workspaces: [
          { path: path.join(spaces, 'renamed', 'oslo'), name: 'oslo', branch: null, adopted: false },
          { path: path.join(api, '.conductor', 'cairo'), name: 'cairo', branch: 'old', adopted: false },
        ],
      },
      {
        repo: app,
        name: 'app',
        workspaces: [
          { path: path.join(spaces, 'app', 'lima'), name: 'lima', branch: 'feat/lima', adopted: true },
          { path: path.join(spaces, 'app', 'tokyo'), name: 'tokyo', branch: 'feat/tokyo', adopted: false },
        ],
      },
    ],
    skipped: [],
    truncated: false,
  });
});

test('what is not a usable worktree is listed as skipped with the reason, and nothing else is touched', (t) => {
  const h = home(t);
  const app = repoAt(path.join(h, 'code', 'app'));
  const spaces = path.join(h, 'conductor', 'workspaces', 'app');
  fs.mkdirSync(path.join(spaces, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(spaces, 'notes.txt'), '');
  fs.symlinkSync(app, path.join(spaces, 'link'));
  // a full clone, not a worktree
  execFileSync('git', ['clone', '--quiet', app, path.join(spaces, 'clone')], { stdio: 'ignore' });
  // a worktree of a bare repository
  const bare = path.join(h, 'bare.git');
  execFileSync('git', ['clone', '--quiet', '--bare', app, bare]);
  run(bare, 'worktree', 'add', '--quiet', '-b', 'x', path.join(spaces, 'of-bare'));
  // a worktree whose repository was deleted since
  const gone = repoAt(path.join(h, 'code', 'gone'));
  run(gone, 'worktree', 'add', '--quiet', '-b', 'y', path.join(spaces, 'orphan'));
  fs.rmSync(gone, { recursive: true });
  run(app, 'worktree', 'add', '--quiet', '-b', 'ok', path.join(spaces, 'ok'));
  // a copy of a workspace still points at the original's git folder, which names only the original back
  fs.cpSync(path.join(spaces, 'ok'), path.join(spaces, 'copy'), { recursive: true });
  // a hand-made pointer at somebody else's repository
  const forged = path.join(spaces, 'forged');
  fs.mkdirSync(path.join(forged, 'x'), { recursive: true });
  fs.writeFileSync(path.join(forged, '.git'), 'gitdir: x\n');
  fs.writeFileSync(path.join(forged, 'x', 'commondir'), `${path.join(app, '.git')}\n`);
  fs.writeFileSync(path.join(forged, 'x', 'gitdir'), `${path.join(spaces, 'ok', '.git')}\n`);
  // a pipe named .git: opening it would block for ever
  fs.mkdirSync(path.join(spaces, 'pipe'));
  execFileSync('mkfifo', [path.join(spaces, 'pipe', '.git')]);
  // a huge file named .git
  fs.mkdirSync(path.join(spaces, 'huge'));
  fs.writeFileSync(path.join(spaces, 'huge', '.git'), `gitdir: ${'x'.repeat(70_000)}\n`);

  const found = discover({ home: h });
  assert.deepEqual(
    found.repos.map((r: any) => [r.repo, r.workspaces.map((w: any) => w.name)]),
    [[app, ['ok']]],
  );
  assert.deepEqual(found.skipped, [
    { path: path.join(spaces, 'clone'), reason: 'not a git worktree' },
    { path: path.join(spaces, 'copy'), reason: 'git does not list this folder as a worktree' },
    { path: path.join(spaces, 'forged'), reason: 'git does not list this folder as a worktree' },
    { path: path.join(spaces, 'huge'), reason: 'not a git worktree' },
    { path: path.join(spaces, 'of-bare'), reason: 'its repository has no checkout of its own' },
    { path: path.join(spaces, 'orphan'), reason: 'git does not list this folder as a worktree' },
    { path: path.join(spaces, 'pipe'), reason: 'not a git worktree' },
    { path: path.join(spaces, 'plain'), reason: 'not a git worktree' },
  ]);
  assert.equal(run(app, 'status', '--porcelain').toString(), '');
});

test('no Conductor folder finds nothing; more folders than one discovery looks at are cut off, and it says so', (t) => {
  const h = home(t);
  assert.deepEqual(discover({ home: h }), { repos: [], skipped: [], truncated: false });
  fs.mkdirSync(path.join(h, 'conductor'));
  fs.writeFileSync(path.join(h, 'conductor', 'workspaces'), 'a file, not a folder');
  assert.deepEqual(discover({ home: h }), { repos: [], skipped: [], truncated: false });
  fs.rmSync(path.join(h, 'conductor', 'workspaces'));
  // the budget is for the whole discovery, across repositories and projects
  const spaces = path.join(h, 'conductor', 'workspaces');
  const pad = (i: number) => String(i).padStart(5, '0');
  for (let i = 0; i < MAX_CANDIDATES - 1; i++) fs.mkdirSync(path.join(spaces, 'one', pad(i)), { recursive: true });
  for (let i = 0; i < 3; i++) fs.mkdirSync(path.join(spaces, 'two', pad(i)), { recursive: true });
  const project = path.join(h, 'code', 'app');
  fs.mkdirSync(path.join(project, '.conductor', 'old'), { recursive: true });
  const found = discover({ home: h, projects: [project] });
  assert.equal(found.truncated, true);
  assert.equal(found.skipped.length, MAX_CANDIDATES);
  assert.equal(found.skipped.filter((x: any) => x.path.startsWith(path.join(spaces, 'two'))).length, 1);
  // bad input is no input, and the default home is the account's
  t.mock.method(os, 'homedir', () => h);
  assert.equal(discover({ home: 3, projects: 'x' } as any).skipped.length, MAX_CANDIDATES);
  assert.equal(discover().truncated, true);
});
