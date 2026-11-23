// electron/platform/conductorImport.cjs importFound and its IPC, with real repositories and a real project store: repositories become projects, workspaces are adopted in place, and repeating changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { discover, importFound } = require('../electron/platform/conductorImport.cjs');
const { ProjectsStore, registerProjects } = require('../electron/platform/projects.cjs');
const git = require('../electron/platform/git.cjs');

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

function setup(t: any) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cimport-')));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const repoAt = (name: string) => {
    const dir = path.join(h, 'code', name);
    fs.mkdirSync(dir, { recursive: true });
    run(dir, 'init', '--quiet', '--initial-branch=trunk');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    run(dir, 'add', '.');
    run(dir, 'commit', '--quiet', '-m', 'first');
    return dir;
  };
  const app = repoAt('app');
  const api = repoAt('api');
  const spaces = path.join(h, 'conductor', 'workspaces');
  fs.mkdirSync(path.join(spaces, 'app'), { recursive: true });
  fs.mkdirSync(path.join(spaces, 'api'), { recursive: true });
  run(app, 'worktree', 'add', '--quiet', '-b', 'feat/tokyo', path.join(spaces, 'app', 'tokyo'));
  run(app, 'worktree', 'add', '--quiet', '-b', 'feat/lima', path.join(spaces, 'app', 'lima'));
  run(api, 'worktree', 'add', '--quiet', '-b', 'feat/oslo', path.join(spaces, 'api', 'oslo'));
  fs.mkdirSync(path.join(spaces, 'app', 'plain'));
  const changes: any[] = [];
  const store = new ProjectsStore(path.join(h, 'state', 'projects.json'), (snap: any) => changes.push(snap));
  return { h, app, api, spaces, store, changes };
}
const adopt = (dir: string) => git.worktreeAdopt(dir);

test('repositories become projects and their workspaces are adopted in place; importing again changes nothing', (t) => {
  const { h, app, api, spaces, store, changes } = setup(t);
  // one of them is a project already, under the name the user gave it
  const had = store.add({ path: app, name: 'My app' });
  const first = importFound(discover({ home: h }), { store, adopt });
  const apiId = store.list().projects.find((p: any) => p.path === api).id;
  assert.deepEqual(first, {
    repos: [
      {
        repo: api,
        name: 'api',
        projectId: apiId,
        added: true,
        workspaces: [{ path: path.join(spaces, 'api', 'oslo'), name: 'oslo', branch: 'feat/oslo', status: 'adopted' }],
      },
      {
        repo: app,
        name: 'app',
        projectId: had,
        added: false,
        workspaces: [
          { path: path.join(spaces, 'app', 'lima'), name: 'lima', branch: 'feat/lima', status: 'adopted' },
          { path: path.join(spaces, 'app', 'tokyo'), name: 'tokyo', branch: 'feat/tokyo', status: 'adopted' },
        ],
      },
    ],
    skipped: [{ path: path.join(spaces, 'app', 'plain'), reason: 'not a git worktree' }],
    truncated: false,
  });
  assert.equal(store.list().projects.find((p: any) => p.id === had).name, 'My app', "the user's own name is kept");
  assert.equal(git.worktreeInfo(path.join(spaces, 'app', 'tokyo')).repo, app);
  // every checkout is where it was, on its branch, unchanged
  for (const [dir, branch] of [
    [path.join(spaces, 'app', 'tokyo'), 'feat/tokyo'],
    [path.join(spaces, 'api', 'oslo'), 'feat/oslo'],
  ]) {
    assert.equal(run(dir, 'symbolic-ref', '--short', 'HEAD').toString().trim(), branch);
    assert.equal(run(dir, 'status', '--porcelain').toString(), '');
  }
  const projects = JSON.stringify(store.list().projects);
  const pushed = changes.length;
  const again = importFound(discover({ home: h }), { store, adopt });
  assert.deepEqual(
    again.repos.map((r: any) => [r.added, r.workspaces.map((w: any) => w.status)]),
    [
      [false, ['already']],
      [false, ['already', 'already']],
    ],
  );
  assert.equal(JSON.stringify(store.list().projects), projects);
  assert.equal(changes.length, pushed, 'nothing was written or announced the second time');
});

test('only the chosen repositories are imported; a choice that names nothing found imports nothing', (t) => {
  const { h, app, api, spaces, store } = setup(t);
  const r = importFound(discover({ home: h }), { store, adopt, only: [api, path.join(h, 'elsewhere'), 7] });
  assert.deepEqual(
    r.repos.map((x: any) => x.repo),
    [api],
  );
  assert.deepEqual(
    store.list().projects.map((p: any) => p.path),
    [api],
  );
  assert.equal(git.worktreeInfo(path.join(spaces, 'app', 'tokyo')), null);
  assert.deepEqual(importFound(discover({ home: h }), { store, adopt, only: [] }).repos, []);
  // a selection that is not a list selects nothing; only leaving it out means everything
  for (const bad of ['everything', { repo: app }, new Set([app]), 0])
    assert.deepEqual(importFound(discover({ home: h }), { store, adopt, only: bad }).repos, []);
  assert.equal(git.worktreeInfo(path.join(spaces, 'app', 'tokyo')), null);
  assert.equal(importFound(discover({ home: h }), { store, adopt, only: null }).repos.length, 2);
  assert.equal(git.worktreeInfo(path.join(spaces, 'app', 'tokyo')).repo, app);
});

test('a project added through a link to the repository is that project: no second one is made', (t) => {
  const { h, app, store } = setup(t);
  fs.symlinkSync(path.join(h, 'code'), path.join(h, 'link'));
  const viaLink = store.add({ path: path.join(h, 'link', 'app'), name: 'Linked' });
  // a project whose folder is gone is no match for anything, and stays
  const gone = store.add({ path: path.join(h, 'removed'), name: 'Gone' });
  const r = importFound(discover({ home: h }), { store, adopt, only: [app] });
  assert.equal(r.repos[0].projectId, viaLink);
  assert.equal(r.repos[0].added, false);
  assert.deepEqual(
    store
      .list()
      .projects.map((p: any) => p.id)
      .sort(),
    [viaLink, gone].sort(),
  );
});

test('one failure is reported where it happened and the rest still imports', (t) => {
  const { h, app, spaces, store } = setup(t);
  const tokyo = path.join(spaces, 'app', 'tokyo');
  const flaky = (dir: string) => {
    if (dir === tokyo) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    if (dir.endsWith('lima')) return { ok: false, error: `${dir} is not a git worktree of another checkout` };
    return git.worktreeAdopt(dir);
  };
  const r = importFound(discover({ home: h }), { store, adopt: flaky });
  const byName = Object.fromEntries(r.repos.flatMap((x: any) => x.workspaces).map((w: any) => [w.name, w]));
  assert.equal(byName.oslo.status, 'adopted');
  assert.equal(byName.tokyo.status, 'failed');
  assert.ok(byName.tokyo.error && !/at .*\.cjs/.test(byName.tokyo.error), 'a sentence, not a stack');
  assert.deepEqual(byName.lima, {
    path: path.join(spaces, 'app', 'lima'),
    name: 'lima',
    status: 'failed',
    error: `${path.join(spaces, 'app', 'lima')} is not a git worktree of another checkout`,
  });
  assert.equal(store.list().projects.length, 2);
  // a project list that cannot be written: each repository says so, and no workspace is adopted without its project
  const blocked = {
    list: () => ({ projects: [] as any[] }),
    add: (o: any) => {
      if (o.path === app) throw new Error('The project list could not be saved');
      return 'p1';
    },
  };
  const calls: string[] = [];
  const out = importFound(discover({ home: h }), {
    store: blocked,
    adopt: (d: string) => (calls.push(d), { ok: true, adopted: true, branch: null }),
  });
  assert.deepEqual(out.repos[1], { repo: app, name: 'app', error: 'The project list could not be saved.', workspaces: [] });
  assert.deepEqual(calls, [path.join(spaces, 'api', 'oslo')]);
  assert.deepEqual(out.repos[0].projectId, 'p1');
});

test('the window asks by channel and never names a folder to adopt: an import discovers again in main', async (t) => {
  const { h, app, api, store } = setup(t);
  t.mock.method(os, 'homedir', () => h);
  const handlers = new Map<string, (...a: any[]) => any>();
  registerProjects({ handle: (ch: string, f: any) => handlers.set(ch, f) }, store);
  const found = await handlers.get('conductor:discover')!({});
  assert.deepEqual(
    found.repos.map((r: any) => r.repo),
    [api, app],
  );
  assert.equal(store.list().projects.length, 0, 'looking adds nothing');
  // a real repository with a real worktree, but not where Conductor keeps them: naming it in the selection brings in
  // neither the repository nor the worktree
  const other = path.join(h, 'elsewhere', 'other');
  fs.mkdirSync(other, { recursive: true });
  run(other, 'init', '--quiet', '--initial-branch=trunk');
  fs.writeFileSync(path.join(other, 'a.txt'), 'a');
  run(other, 'add', '.');
  run(other, 'commit', '--quiet', '-m', 'first');
  const otherTree = path.join(h, 'elsewhere', 'tree');
  run(other, 'worktree', 'add', '--quiet', '-b', 'x', otherTree);
  const r = await handlers.get('conductor:import')!({}, [other, otherTree, app]);
  assert.deepEqual(
    r.repos.map((x: any) => x.repo),
    [app],
  );
  assert.equal(
    store.list().projects.some((p: any) => p.path === other),
    false,
  );
  assert.equal(git.worktreeInfo(otherTree), null);
  assert.equal(fs.existsSync(path.join(other, '.git', 'worktrees', 'tree', 'mopilot-worktree.json')), false);
  assert.deepEqual(
    r.repos[0].workspaces.map((w: any) => w.status),
    ['adopted', 'adopted'],
  );
  // the older layout is found through the projects the store now has
  fs.mkdirSync(path.join(app, '.conductor'));
  run(app, 'worktree', 'add', '--quiet', '-b', 'old', path.join(app, '.conductor', 'cairo'));
  const all = await handlers.get('conductor:import')!({});
  assert.deepEqual(
    all.repos.find((x: any) => x.repo === app).workspaces.map((w: any) => [w.name, w.status]),
    [
      ['lima', 'already'],
      ['tokyo', 'already'],
      ['cairo', 'adopted'],
    ],
  );
});
