// electron/platform/git.cjs with a fake `git` (execFile): the failure paths of worktree add/restore/list/prune
// and the IPC defaults (env:write and setup scripts: gitEnvScripts.test.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');

type Reply = { ok?: boolean; stdout?: string; stderr?: string };
let calls: { args: string[]; cwd: string }[] = [];
let respond: (args: string[], cwd: string) => Reply = () => ({ ok: true });
mock.method(childProcess, 'execFile', (_cmd: string, args: string[], opts: any, cb: any) => {
  calls.push({ args, cwd: opts.cwd });
  let r = respond(args, opts.cwd);
  // unless a test answers it: as git does, cwd's folder under the top level the test's repository reports
  if (args[0] === 'rev-parse' && args[1] === '--show-prefix' && r.ok !== false && r.stdout === undefined) {
    const top = respond(['rev-parse', '--show-toplevel'], opts.cwd).stdout?.replace(/\n$/, '') ?? '';
    const sub = path.posix.relative(top, opts.cwd);
    r = { stdout: sub ? `${sub}/\n` : '\n' };
  }
  setImmediate(() => cb(r.ok === false ? new Error('git failed') : null, r.stdout, r.stderr));
});

function tmp(t: any, prefix = 'gitfake-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  calls = [];
  return d;
}
const has = (args: string[], ...want: string[]) => want.every((w, i) => args[i] === w);
function ipc() {
  const h = new Map<string, (...a: any[]) => any>();
  git.register({ handle: (ch: string, f: any) => h.set(ch, f) });
  return (ch: string, ...a: any[]) => h.get(ch)!({}, ...a);
}
const marker = (holder: string, m: any) => {
  fs.mkdirSync(holder, { recursive: true });
  fs.writeFileSync(path.join(holder, git.MARKER), JSON.stringify(m));
};

const { NOT_A_REPO, NO_COMMITS } = require('../shared/worktreeSupport.mjs');

test("worktreeAdd outside a repo says the folder can't hold one", async (t) => {
  tmp(t);
  respond = () => ({ ok: false });
  assert.deepEqual(await git.worktreeAdd('/x', { root: '/r' }), { ok: false, unsupported: true, error: NOT_A_REPO });
});

// Each test runs an hour after the last, so a fetch an earlier test made is never still fresh.
let hour = 0;
const nextHour = (t: any) => {
  const at = Date.UTC(2030, 0, 1) + ++hour * 3_600_000;
  t.mock.method(Date, 'now', () => at);
};
const fetches = () => calls.filter((c) => has(c.args, 'fetch')).map((c) => c.args);
/** A repo at /src/app whose refs and merge-bases answer as given. */
const repoReply =
  (o: {
    head?: string | null;
    local?: boolean;
    remote?: boolean;
    behind?: boolean;
    base?: boolean;
    sameConfig?: boolean;
    fetch?: boolean;
    refOk?: boolean;
    /** HEAD names a commit (false: a repository with none yet) */
    headCommit?: boolean;
  }) =>
  (args: string[]): Reply => {
    if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: '/src/app\n' };
    if (has(args, 'symbolic-ref')) return o.head ? { stdout: `origin/${o.head}\n` } : { ok: false };
    if (has(args, 'check-ref-format')) return { ok: o.refOk ?? true };
    if (has(args, 'fetch')) return { ok: o.fetch ?? true };
    if (has(args, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')) return { ok: o.headCommit ?? true };
    if (has(args, 'rev-parse', '--verify')) return { ok: args[3].startsWith('refs/heads/') ? !!o.local : !!o.remote };
    if (has(args, 'merge-base', '--is-ancestor')) return { ok: !!o.behind };
    if (has(args, 'merge-base')) return o.base === false ? { ok: false } : { stdout: 'b4se\n' };
    if (args.includes('diff')) return { ok: o.sameConfig ?? true };
    return { ok: true };
  };

test("worktreeAdd starts from origin/HEAD's branch, fetching just that branch, untracked; default root and prefix", async (t) => {
  const d = tmp(t);
  nextHour(t);
  t.mock.method(os, 'homedir', () => d);
  respond = repoReply({ head: 'trunk', remote: true });
  const r = await git.worktreeAdd('/src/app', {});
  assert.equal(r.ok, true);
  assert.match(r.branch, /^mopilot\/[0-9a-f]+$/);
  assert.equal(path.dirname(path.dirname(r.worktree)), path.join(d, '.mopilot', 'worktrees'));
  assert.equal(r.path, r.worktree);
  assert.deepEqual(fetches(), [['fetch', '--quiet', '--no-write-fetch-head', 'origin', '+refs/heads/trunk:refs/remotes/origin/trunk']]);
  assert.deepEqual(calls.at(-1)!.args, ['worktree', 'add', '--no-track', '-b', r.branch, r.worktree, 'origin/trunk']);
  const m = JSON.parse(fs.readFileSync(path.join(path.dirname(r.worktree), git.MARKER), 'utf8'));
  assert.equal(m.repo, '/src/app');
  assert.deepEqual(fs.readdirSync(path.dirname(r.worktree)), [git.MARKER], 'the marker is renamed into place');
});

test('a branch fetched in the last 30 minutes is not fetched again; a failed fetch is retried', async (t) => {
  const d = tmp(t);
  let now = Date.UTC(2020, 0, 1);
  t.mock.method(Date, 'now', () => now);
  respond = repoReply({ head: 'main', remote: true, fetch: false });
  await git.worktreeAdd('/src/app', { root: path.join(d, 'a') });
  await git.worktreeAdd('/src/app', { root: path.join(d, 'b') });
  assert.equal(fetches().length, 2, 'offline: tried each time');
  respond = repoReply({ head: 'main', remote: true });
  await git.worktreeAdd('/src/app', { root: path.join(d, 'c') });
  now += 29 * 60_000;
  await git.worktreeAdd('/src/app', { root: path.join(d, 'd') });
  assert.equal(fetches().length, 3);
  now += 2 * 60_000;
  await git.worktreeAdd('/src/app', { root: path.join(d, 'e') });
  assert.equal(fetches().length, 4);
  // a name git won't take as a branch ref is never put in a refspec
  calls = [];
  respond = repoReply({ local: true, refOk: false });
  const r = await git.worktreeAdd('/src/app', { root: path.join(d, 'f'), branch: 'we:ird' });
  assert.equal(r.ok, true);
  assert.deepEqual(fetches(), []);
});

test("worktreeAdd without origin/HEAD falls back to origin/main, then origin/master; keeps cwd's subfolder", async (t) => {
  const d = tmp(t);
  nextHour(t);
  for (const found of ['main', 'master']) {
    calls = [];
    respond = (args) => {
      if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: '/src/app\n' };
      if (has(args, 'symbolic-ref')) return { ok: false };
      if (has(args, 'rev-parse', '--verify')) return { ok: args[3].startsWith(`refs/remotes/origin/${found}`) };
      return { ok: true };
    };
    const r = await git.worktreeAdd('/src/app/sub', { root: path.join(d, found), prefix: 'me/' });
    assert.match(r.branch, /^me\//);
    assert.equal(r.path, path.join(r.worktree, 'sub'));
    assert.equal(fetches()[0].at(-1), `+refs/heads/${found}:refs/remotes/origin/${found}`);
    assert.equal(calls.at(-1)!.args.at(-1), `origin/${found}`);
  }
});

test('worktreeAdd: when git cannot say which subfolder cwd is, the chat starts at the worktree top', async (t) => {
  const d = tmp(t);
  nextHour(t);
  const reply = repoReply({});
  respond = (args) => (has(args, 'rev-parse', '--show-prefix') ? { ok: false } : reply(args));
  const r = await git.worktreeAdd('/src/app/sub', { root: d });
  assert.equal(r.ok, true);
  assert.equal(r.path, r.worktree);
});

test('worktreeAdd starts from HEAD without a default branch on origin, or when one never arrived', async (t) => {
  const d = tmp(t);
  nextHour(t);
  respond = repoReply({});
  const r = await git.worktreeAdd('/src/app', { root: path.join(d, 'none') });
  assert.equal(r.ok, true);
  assert.deepEqual(fetches(), []);
  assert.equal(calls.at(-1)!.args.at(-1), 'HEAD');
  // origin/HEAD names a branch, but offline and never fetched: no commit to start from
  calls = [];
  respond = repoReply({ head: 'main', fetch: false });
  const r2 = await git.worktreeAdd('/src/app', { root: path.join(d, 'offline') });
  assert.equal(r2.ok, true);
  assert.equal(fetches().length, 1);
  assert.equal(calls.at(-1)!.args.at(-1), 'HEAD');
});

test('worktreeAdd in a repository with no commits says so before making anything; a picked or default branch is not HEAD', async (t) => {
  const d = tmp(t);
  nextHour(t);
  respond = repoReply({ headCommit: false });
  assert.deepEqual(await git.worktreeAdd('/src/app', { root: path.join(d, 'empty') }), { ok: false, unsupported: true, error: NO_COMMITS });
  assert.equal(fs.existsSync(path.join(d, 'empty')), false);
  assert.ok(!calls.some((c) => has(c.args, 'worktree', 'add')));
  // HEAD unborn, but origin's default branch has commits to start from
  respond = repoReply({ headCommit: false, head: 'main', remote: true });
  const r = await git.worktreeAdd('/src/app', { root: path.join(d, 'remote') });
  assert.equal(r.ok, true);
  assert.equal(calls.at(-1)!.args.at(-1), 'origin/main');
});

test("a picked branch: origin's copy unless local commits leave .claude and .mcp.json alone; missing or invalid fails before anything is made", async (t) => {
  const d = tmp(t);
  nextHour(t);
  const base = async (o: any, branch = 'feat') => {
    calls = [];
    respond = repoReply(o);
    const r = await git.worktreeAdd('/src/app', { root: path.join(d, String(hour), String(Math.random())), branch });
    return r.ok ? calls.at(-1)!.args.at(-1) : r;
  };
  assert.equal(await base({ local: true, remote: true, behind: true }), 'origin/feat');
  assert.equal(
    calls.some((c) => has(c.args, 'symbolic-ref')),
    false,
    'a picked branch skips the default lookup',
  );
  assert.deepEqual(calls.find((c) => has(c.args, 'merge-base'))!.args, [
    'merge-base',
    '--is-ancestor',
    'refs/heads/feat',
    'refs/remotes/origin/feat',
  ]);
  assert.equal(await base({ remote: true }), 'origin/feat', 'not a local branch');
  assert.equal(await base({ local: true, remote: true, behind: false }), 'feat', 'local commits origin lacks are kept');
  assert.deepEqual(calls.find((c) => c.args.includes('diff'))!.args, [
    '-c',
    'diff.relative=false',
    'diff',
    '--quiet',
    '--no-ext-diff',
    '--no-textconv',
    'b4se',
    'refs/heads/feat',
    '--',
    ':(top,icase).claude',
    ':(top,icase).mcp.json',
  ]);
  assert.equal(
    await base({ local: true, remote: true, behind: false, sameConfig: false }),
    'origin/feat',
    'not when they change agent config',
  );
  assert.equal(await base({ local: true, remote: true, behind: false, base: false }), 'origin/feat', 'unrelated histories');
  assert.equal(await base({ local: true }), 'feat', 'never pushed');
  assert.deepEqual(await base({}, 'gone'), { ok: false, error: 'Branch gone not found' });
  assert.equal(
    calls.some((c) => has(c.args, 'worktree')),
    false,
  );
  calls = [];
  for (const bad of ['-x', '  ', 7])
    assert.deepEqual(await git.worktreeAdd('/src/app', { root: d, branch: bad }), { ok: false, error: `Invalid branch name "${bad}".` });
  assert.deepEqual(calls, []);
});

test("listBranches: null outside a repo; origin's default first, then git's order; detached and no default", async (t) => {
  tmp(t);
  respond = () => ({ ok: false });
  assert.equal(await ipc()('git:branches', '/x'), null);
  respond = (args) => {
    if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: '/src/app\n' };
    if (has(args, 'symbolic-ref', '--quiet', '--short', 'HEAD')) return { stdout: 'feature\n' };
    if (has(args, 'symbolic-ref')) return { stdout: 'origin/main\n' };
    if (has(args, 'for-each-ref')) return { stdout: 'a\nfeature\nmain\n\n' };
    return { ok: true };
  };
  assert.deepEqual(await git.listBranches('/src/app/sub'), {
    current: 'feature',
    default: 'main',
    branches: ['main', 'a', 'feature'],
    commits: true,
  });
  assert.ok(calls.filter((c) => !has(c.args, 'rev-parse', '--show-toplevel')).every((c) => c.cwd === '/src/app'));
  respond = (args) => {
    if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: '/src/app\n' };
    if (has(args, 'for-each-ref')) return { stdout: 'b\na\n' };
    return { ok: false };
  };
  // no commit at HEAD and no default on origin: a worktree has nothing to start from
  assert.deepEqual(await git.listBranches('/src/app'), { current: null, default: null, branches: ['b', 'a'], commits: false });
  // an unborn HEAD still has origin's default branch to start from once its commits are here, on origin's copy or a local one
  let have = ['refs/remotes/origin/main^{commit}'];
  respond = (args) => {
    if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: '/src/app\n' };
    if (has(args, 'symbolic-ref', '--quiet', '--short', 'HEAD')) return { stdout: 'main\n' };
    if (has(args, 'symbolic-ref')) return { stdout: 'origin/main\n' };
    if (has(args, 'for-each-ref')) return { stdout: '' };
    return { ok: has(args, 'rev-parse', '--verify') && have.includes(args[3]) };
  };
  assert.deepEqual(await git.listBranches('/src/app'), { current: 'main', default: 'main', branches: ['main'], commits: true });
  have = ['refs/heads/main^{commit}'];
  assert.equal((await git.listBranches('/src/app')).commits, true);
  // origin/HEAD names main, but it was never fetched (offline): worktreeAdd would find no commit, so neither does this
  have = [];
  assert.equal((await git.listBranches('/src/app')).commits, false);
});

test("switchBranch: invalid names are refused; already on it is a no-op; git's refusal is reported with a fallback", async (t) => {
  tmp(t);
  assert.deepEqual(await git.switchBranch('/src/app', '--orphan'), { ok: false, error: 'Invalid branch name "--orphan".' });
  assert.deepEqual(await git.switchBranch('/src/app', null), { ok: false, error: 'Invalid branch name "null".' });
  assert.equal(calls.length, 0);
  respond = (args) => (has(args, 'symbolic-ref') ? { stdout: 'feat\n' } : { ok: true });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), { ok: true });
  assert.equal(
    calls.some((c) => has(c.args, 'switch')),
    false,
  );
  respond = (args) => (has(args, 'symbolic-ref') ? { stdout: 'main\n' } : { ok: true, stdout: '' });
  assert.deepEqual(await ipc()('git:switchBranch', '/src/app', 'feat'), { ok: true });
  assert.deepEqual(calls.at(-1), { args: ['switch', 'feat'], cwd: '/src/app' });
  respond = (args) =>
    has(args, 'switch')
      ? { ok: false, stderr: 'fatal: invalid reference: feat\n' }
      : has(args, 'symbolic-ref')
        ? { ok: false }
        : { ok: true, stdout: '' };
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), {
    ok: false,
    error: 'Failed to switch to "feat" in /src/app: fatal: invalid reference: feat',
  });
  respond = (args) => (has(args, 'switch') ? { ok: false } : { ok: true, stdout: '' });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), {
    ok: false,
    error: 'Failed to switch to "feat" in /src/app: git switch failed',
  });
});

test('switchBranch refuses before switching when uncommitted work would collide, as Claude Code does', async (t) => {
  tmp(t);
  const tree =
    (o: { status: string; target?: 'local' | 'remote' | null; changed?: string }) =>
    (args: string[]): Reply => {
      if (has(args, 'symbolic-ref')) return { stdout: 'main\n' };
      if (has(args, 'status')) return { stdout: o.status };
      if (has(args, 'rev-parse', '--verify'))
        return o.target && args[3].startsWith(o.target === 'local' ? 'refs/heads/' : 'refs/remotes/')
          ? { stdout: 'c0ffee\n' }
          : { ok: false };
      if (has(args, 'diff')) return { stdout: o.changed ?? '' };
      return { ok: true };
    };
  const refused = {
    ok: false,
    error: 'Can\'t switch to "feat": there are uncommitted changes on "main" in /src/app. Commit or stash them, or turn on Worktree.',
  };
  respond = tree({ status: ' M a.txt\0', target: 'local', changed: 'a.txt\0b.txt\0' });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), refused);
  assert.equal(
    calls.some((c) => has(c.args, 'switch')),
    false,
  );
  assert.deepEqual(calls.find((c) => has(c.args, 'diff'))!.args, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', 'c0ffee']);
  respond = tree({ status: 'R  new.txt\0old.txt\0', target: 'remote', changed: 'old.txt\0' });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), refused, "a rename's original path counts");
  respond = tree({ status: 'UU a.txt\0' });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), refused, 'a conflict in progress');
  respond = tree({ status: ' M a.txt\0', target: null });
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), refused, "a branch it can't find");
  // changes the branch doesn't touch, or none at all: it switches
  for (const o of [{ status: ' M a.txt\0?? x\0', target: 'local' as const, changed: 'b.txt\0' }, { status: '' }]) {
    calls = [];
    respond = tree(o);
    assert.deepEqual(await git.switchBranch('/src/app', 'feat'), { ok: true });
    assert.ok(calls.some((c) => has(c.args, 'switch', 'feat')));
  }
  // detached: the message has no branch to name
  respond = (args) => (has(args, 'symbolic-ref') ? { ok: false } : tree({ status: 'UU a\0' })(args));
  assert.deepEqual(await git.switchBranch('/src/app', 'feat'), {
    ok: false,
    error: 'Can\'t switch to "feat": there are uncommitted changes in /src/app. Commit or stash them, or turn on Worktree.',
  });
});

test("a failed worktree add removes the holder and reports git's error", async (t) => {
  const d = tmp(t);
  respond = (args) => {
    if (has(args, 'rev-parse')) return { stdout: '/src/app\n' };
    return { ok: false, stderr: ' fatal: branch exists \n' };
  };
  const r = await git.worktreeAdd('/src/app', { root: d });
  assert.deepEqual(r, { ok: false, error: 'fatal: branch exists' });
  assert.deepEqual(fs.readdirSync(d), []);
});

test('worktreeInfo: non-paths are null; a marker without branch/date gets defaults; no marker is null', (t) => {
  const d = tmp(t);
  assert.equal(git.worktreeInfo(7), null);
  assert.equal(git.worktreeInfo('rel/path'), null);
  marker(path.join(d, 'id1'), { repo: '/src/app' });
  assert.deepEqual(git.worktreeInfo(path.join(d, 'id1', 'app', 'deep')), {
    path: path.join(d, 'id1', 'app'),
    repo: '/src/app',
    branch: null,
    createdAt: 0,
  });
  assert.equal(git.worktreeInfo(path.join(d, 'nomarker')), null);
});

test('listWorktrees: unreadable root is empty; unmarked ones only with all (needing .git); defaults filled', (t) => {
  const d = tmp(t);
  assert.deepEqual(git.listWorktrees(path.join(d, 'missing')), []);
  marker(path.join(d, 'm1'), { repo: '/src/a' });
  fs.mkdirSync(path.join(d, 'm1', 'a', '.git'), { recursive: true });
  fs.mkdirSync(path.join(d, 'u1', 'withgit', '.git'), { recursive: true });
  fs.mkdirSync(path.join(d, 'u1', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(d, 'loose-file'), '');
  assert.deepEqual(git.listWorktrees(d), [{ path: path.join(d, 'm1', 'a'), repo: '/src/a', branch: null, createdAt: 0 }]);
  const all = git.listWorktrees(d, true);
  assert.deepEqual(
    all.map((w: any) => [path.relative(d, w.path), w.repo]),
    [
      ['u1/withgit', null],
      ['m1/a', '/src/a'],
    ],
  );
});

test('listWorktrees: a holder that cannot be listed contributes nothing', (t) => {
  const d = tmp(t);
  marker(path.join(d, 'm1'), { repo: '/src/a', branch: 'b', createdAt: 5 });
  const real = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p: string, o: any) => {
    if (p === path.join(d, 'm1')) throw new Error('EACCES');
    return real(p, o);
  });
  assert.deepEqual(git.listWorktrees(d), []);
});

test("git:worktreeList reads each worktree's branch, keeping the marker's when git fails; default root", async (t) => {
  const d = tmp(t);
  t.mock.method(os, 'homedir', () => d);
  const root = path.join(d, '.mopilot', 'worktrees');
  marker(path.join(root, 'a'), { repo: '/src/a', branch: 'old-a', createdAt: 2 });
  fs.mkdirSync(path.join(root, 'a', 'app', '.git'), { recursive: true });
  marker(path.join(root, 'b'), { repo: '/src/b', branch: 'old-b', createdAt: 1 });
  fs.mkdirSync(path.join(root, 'b', 'app', '.git'), { recursive: true });
  respond = (_args, cwd) => (cwd.includes(`${path.sep}a${path.sep}`) ? { stdout: 'feature\n' } : { ok: false });
  const list = await ipc()('git:worktreeList');
  assert.deepEqual(
    list.map((w: any) => w.branch),
    ['feature', 'old-b'],
  );
});

test('removeWorktree: kept when git fails and the folder remains; removed when git succeeds or it is gone', async (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'h', 'app'), { recursive: true });
  respond = () => ({ ok: false });
  assert.equal(await git.removeWorktree({ path: path.join(d, 'h', 'app'), repo: '/src' }), false);
  assert.equal(fs.existsSync(path.join(d, 'h', 'app')), true);
  respond = () => (fs.rmSync(path.join(d, 'h', 'app'), { recursive: true, force: true }), { ok: true });
  assert.equal(await git.removeWorktree({ path: path.join(d, 'h', 'app'), repo: '/src' }), true);
  assert.equal(fs.existsSync(path.join(d, 'h')), false);
  respond = () => ({ ok: false });
  assert.equal(await git.removeWorktree({ path: path.join(d, 'gone', 'app'), repo: '/src' }), true);
  assert.ok(calls.some((c) => has(c.args, 'worktree', 'prune')));
});

test('worktreeRestore: refusals, a missing branch, git failure, and success (default root via IPC)', async (t) => {
  const d = tmp(t);
  t.mock.method(os, 'homedir', () => d);
  const root = path.join(d, '.mopilot', 'worktrees');
  const call = ipc();
  assert.deepEqual(await call('git:worktreeRestore', 5), { ok: false, error: 'No folder to restore' });
  assert.deepEqual(await call('git:worktreeRestore', 'rel'), { ok: false, error: 'No folder to restore' });
  assert.deepEqual(await call('git:worktreeRestore', d), { ok: true, restored: false });
  assert.deepEqual(await call('git:worktreeRestore', path.join(d, 'elsewhere', 'x')), { ok: false, error: 'Not a MoPilot worktree' });
  assert.deepEqual(await call('git:worktreeRestore', path.join(root, 'id9')), { ok: false, error: 'Not a MoPilot worktree' });
  assert.deepEqual(await call('git:worktreeRestore', path.join(root, 'id9', 'app'), null, 7), {
    ok: false,
    error: 'The project folder is gone',
  });
  assert.deepEqual(await call('git:worktreeRestore', path.join(root, 'id9', 'app'), null, path.join(d, 'nope')), {
    ok: false,
    error: 'The project folder is gone',
  });

  respond = () => ({ stdout: 'main\nother/zz\n' });
  assert.deepEqual(await call('git:worktreeRestore', path.join(root, 'id9', 'app'), null, d), {
    ok: false,
    error: 'The branch for this worktree (…/id9) is gone',
  });

  respond = (args) =>
    has(args, 'for-each-ref') ? { stdout: 'feat/id9\n' } : has(args, 'worktree', 'add') ? { ok: false, stderr: 'fatal: nope\n' } : {};
  assert.deepEqual(await call('git:worktreeRestore', path.join(root, 'id9', 'app'), null, d), { ok: false, error: 'fatal: nope' });

  respond = (args) => (has(args, 'for-each-ref') ? { stdout: 'mopilot/id9\n' } : {});
  const { copy, ...r } = await git.worktreeRestore(path.join(root, 'id9', 'app', 'sub'), null, d);
  assert.deepEqual(copy.copied.length === 0 && r, {
    ok: true,
    restored: true,
    branch: 'mopilot/id9',
    worktree: path.join(root, 'id9', 'app'),
    path: path.join(root, 'id9', 'app', 'sub'),
    repo: d,
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'id9', git.MARKER), 'utf8')).branch, 'mopilot/id9');
  assert.deepEqual(fs.readdirSync(path.join(root, 'id9')), [git.MARKER]);
  // the id went to another repository's worktree since: that one is left alone
  marker(path.join(root, 'id8'), { repo: '/elsewhere', branch: 'mopilot/id8' });
  respond = (args) => (has(args, 'for-each-ref') ? { stdout: 'mopilot/id8\n' } : {});
  calls = [];
  assert.deepEqual(await git.worktreeRestore(path.join(root, 'id8', 'app'), null, d), {
    ok: false,
    error: 'Another worktree uses …/id8 now',
  });
  assert.equal(
    calls.some((c) => has(c.args, 'worktree', 'add')),
    false,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'id8', git.MARKER), 'utf8')).repo, '/elsewhere');
});

test('worktreeAdd never reuses an id a kept branch or another worktree folder holds; it gives up after many tries', async (t) => {
  const d = tmp(t);
  const ids = [0x1234, 0x5678, 0xabcd, 0x0f0f];
  const random = t.mock.method(Math, 'random', () => (ids.length > 1 ? ids.shift()! : ids[0]) / 0x10000);
  // Retained branches reserve 1234 and 5678 across prefixes; abcd is another repository's worktree folder.
  fs.mkdirSync(path.join(d, 'abcd'), { recursive: true });
  respond = (args) => (has(args, 'for-each-ref') ? { stdout: 'main\nmopilot/1234\ncodex/5678\n' } : repoReply({ local: true })(args));
  const r = await git.worktreeAdd('/src/app', { root: d, branch: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.branch, 'mopilot/0f0f');
  assert.equal(r.worktree, path.join(d, '0f0f', 'app'));
  // every id taken: it says so instead of looping
  random.mock.mockImplementation(() => 0x1234 / 0x10000);
  assert.deepEqual(await git.worktreeAdd('/src/app', { root: d, branch: 'main' }), {
    ok: false,
    error: 'No free worktree name: delete some old worktrees or branches',
  });
  // a holder folder that can't be made is a failure, not a free name
  random.mock.mockImplementation(() => 0x5555 / 0x10000);
  const mk = t.mock.method(fs, 'mkdirSync', (p: string, o?: any) => {
    if (o?.recursive) return undefined;
    throw Object.assign(new Error('read-only'), { code: 'EROFS' });
  });
  await assert.rejects(async () => git.worktreeAdd('/src/app', { root: d, branch: 'main' }), /read-only/);
  mk.mock.restore();
});

test('pruneCandidates: a bad limit means 15, and never below 1', () => {
  const list = Array.from({ length: 17 }, (_, i) => ({ path: `/w/${i}`, createdAt: i }));
  assert.deepEqual(
    git.pruneCandidates(list, 'x', [], () => false).map((w: any) => w.path),
    ['/w/1', '/w/0'],
  );
  assert.deepEqual(
    git.pruneCandidates(list.slice(0, 2), 0.5, ['/w/0/sub'], () => false),
    [],
  );
});

test('git:worktreePrune: nothing under the limit; dirty or failing status is kept; keep is stringified', async (t) => {
  // a temp path that happens to contain the worktree names (as on GitHub's macOS runners) must not matter
  const d = tmp(t, 'gitfake-h0h1-');
  t.mock.method(os, 'homedir', () => d);
  const root = path.join(d, '.mopilot', 'worktrees');
  for (let i = 0; i < 4; i++) {
    marker(path.join(root, `h${i}`), { repo: '/src', createdAt: i });
    fs.mkdirSync(path.join(root, `h${i}`, 'app', '.git'), { recursive: true });
  }
  const call = (git.setChatFolders(async () => []), ipc());
  assert.deepEqual(await call('git:worktreePrune', undefined, 'bad', null), []);
  respond = (args, cwd) => {
    if (has(args, 'status')) {
      const holder = path.basename(path.dirname(cwd));
      if (holder === 'h0') return { ok: false };
      if (holder === 'h1') return { stdout: ' M file\n' };
      return { stdout: '' };
    }
    return {};
  };
  const removed = await call('git:worktreePrune', undefined, 1, [path.join(root, 'h2', 'app'), 5]);
  assert.deepEqual(removed, []);
  const removed2 = await call('git:worktreePrune', root, 1, 'notarray');
  assert.deepEqual(removed2, [path.join(root, 'h2', 'app')]);
});

test('branch listing and worktree creation retain whitespace in repository roots', async (t) => {
  const d = tmp(t);
  for (const suffix of [' ', '\t', '\n', '\r']) {
    const repo = '/src/app' + suffix;
    respond = (args) => {
      if (has(args, 'rev-parse', '--show-toplevel')) return { stdout: repo + '\n' };
      if (has(args, 'symbolic-ref', '--quiet', '--short', 'HEAD')) return { stdout: 'main\n' };
      if (has(args, 'for-each-ref')) return { stdout: 'main\n' };
      if (has(args, 'rev-parse', '--show-prefix')) return { stdout: 'sub/\n' };
      if (has(args, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')) return { ok: true };
      if (has(args, 'worktree', 'add')) return { ok: true };
      return { ok: false };
    };
    calls = [];
    assert.deepEqual(await git.listBranches(repo + '/sub'), { current: 'main', default: null, branches: ['main'], commits: true });
    assert.ok(calls.filter((c) => !has(c.args, 'rev-parse', '--show-toplevel')).every((c) => c.cwd === repo));
    const result = await git.worktreeAdd(repo + '/sub', { root: d });
    assert.equal(result.ok, true);
    assert.equal(result.repo, repo);
    assert.equal(path.basename(result.worktree), 'app' + suffix);
    assert.equal(result.path, path.join(result.worktree, 'sub'));
    assert.equal(calls.find((c) => has(c.args, 'worktree', 'add'))!.cwd, repo);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(result.worktree), git.MARKER), 'utf8')).repo, repo);
  }
});

test('empty successful root output does not start branch or worktree operations', async (t) => {
  const d = tmp(t);
  respond = () => ({ stdout: '\n' });
  assert.equal(await git.listBranches('/src/app'), null);
  assert.deepEqual(await git.worktreeAdd('/src/app', { root: d }), { ok: false, unsupported: true, error: NOT_A_REPO });
  assert.equal(calls.length, 2);
});

test('a worktree root typed in Settings: empty is the default, ~ is home, and a relative one is refused everywhere', async (t) => {
  tmp(t);
  const home = '/Users/me';
  assert.equal(git.rootOf('', home), path.join(home, '.mopilot', 'worktrees'));
  assert.equal(git.rootOf(null, home), path.join(home, '.mopilot', 'worktrees'));
  assert.equal(git.rootOf('  /wt  ', home), '/wt');
  assert.equal(git.rootOf('~', home), home);
  assert.equal(git.rootOf('~/wt', home), path.join(home, 'wt'));
  assert.equal(git.rootOf('~\\wt', home), path.join(home, 'wt'));
  assert.equal(git.rootOf('worktrees', home), null);
  assert.equal(git.rootOf('~other/wt', home), null);
  assert.equal(git.rootOf('', undefined), git.defaultRoot());
  // nothing is made under wherever main started, and nothing is listed, pruned or restored there
  respond = repoReply({ head: 'main', remote: true });
  const refused = { ok: false, error: 'The worktree root in Settings → Worktrees must be a full path, like ~/worktrees' };
  assert.deepEqual(await git.worktreeAdd('/src/app', { root: 'worktrees' }), refused);
  assert.equal(
    calls.some((c) => has(c.args, 'worktree', 'add')),
    false,
  );
  const call = ipc();
  assert.deepEqual(await call('git:worktreeList', 'worktrees'), []);
  assert.deepEqual(await call('git:worktreePrune', 'worktrees', 1, []), []);
  assert.deepEqual(await call('git:worktreeRestore', '/gone/abcd/app', 'worktrees', '/src/app'), refused);
});
