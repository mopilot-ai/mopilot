// Getting the code to the target Host (shared/host/codeTransfer.mjs, host/src/hostGit.mjs inspect and clone --branch, electron/host/codeTransfer.cjs; package 3.5): repository facts that never carry a credential, a target folder classified against the source, a clone on the source's branch that leaves no half folder, and a handoff that says what it knows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit } from '../host/src/hostGit.mjs';
const require = createRequire(import.meta.url);
const T = require('../shared/host/codeTransfer.mjs');
const { createCodeTransfer, localInspect } = require('../electron/host/codeTransfer.cjs');
const { continueHandoff } = require('../shared/host/continueHandoff.mjs');

const SHA = 'a'.repeat(40);
const facts = (o: object = {}) => ({ isRepo: true, remote: 'https://github.com/a/b', branch: 'feat/x', head: SHA, dirty: 0, ...o });

test('I1: an address loses its password, token, query and fragment; what the target cannot clone is null', () => {
  assert.equal(T.publicRemote('https://user:tok@github.com/a/b.git?x=1#f'), 'https://github.com/a/b.git');
  assert.equal(T.publicRemote('https://ghp_secret@github.com:8443/a/b'), 'https://github.com:8443/a/b');
  assert.equal(T.publicRemote(' ssh://git:pw@host.io/a/b.git '), 'ssh://git@host.io/a/b.git');
  assert.equal(T.publicRemote('ssh://host.io/a/b'), 'ssh://host.io/a/b');
  assert.equal(T.publicRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  for (const bad of [
    '/srv/git/b',
    'file:///srv/b',
    'ftp://h/a',
    'https://h/a b',
    'https://',
    'ssh:///x',
    'https://h/\u0001',
    '',
    null,
    5,
    undefined,
  ])
    assert.equal(T.publicRemote(bad), null, String(bad));
});

test('I1: the https, ssh and scp forms of one repository share a key; different repositories and non-addresses do not', () => {
  const key = 'github.com/a/b';
  for (const u of [
    'https://github.com/a/b',
    'https://GitHub.com/a/b.git',
    'git@github.com:a/b.git',
    'ssh://git@github.com/a/b/',
    'https://t:x@github.com/a/b.git',
  ])
    assert.equal(T.repoKey(u), key, u);
  assert.notEqual(T.repoKey('https://github.com/a/c'), key);
  assert.equal(T.repoKey('/srv/git/b'), null);
  assert.equal(T.repoKey('https://github.com/'), null);
  assert.equal(T.repoKey('git@github.com:'), null);
});

/** A git that answers from a table of `verb → result`. */
const table = (answers: Record<string, { ok: boolean; stdout?: string }>) => async (args: string[]) => {
  const a = answers[args.find((x) => !x.startsWith('--no-')) as string] ?? { ok: false };
  return { stdout: '', ...a };
};
test('inspectRepo reads origin, branch, commit and changed files; a part git cannot say is null, never wrong', async () => {
  const full = table({
    'rev-parse': { ok: true, stdout: 'true\n' },
    'symbolic-ref': { ok: true, stdout: 'feat/x\n' },
    remote: { ok: true, stdout: 'https://tok@github.com/a/b.git\n' },
    status: { ok: true, stdout: ' M a.ts\n?? b.ts\n' },
  });
  // the one `rev-parse` fake answers `true` to the work-tree question, so the commit is not a sha
  assert.deepEqual(await T.inspectRepo(full), {
    isRepo: true,
    remote: 'https://github.com/a/b.git',
    branch: 'feat/x',
    head: null,
    dirty: 2,
  });
  assert.deepEqual(await T.inspectRepo(async () => ({ ok: false, stdout: '' })), { isRepo: false });
  assert.deepEqual(await T.inspectRepo(async () => ({ ok: true, stdout: 'false\n' })), { isRepo: false });
  const empty = await T.inspectRepo(table({ 'rev-parse': { ok: true, stdout: 'true\n' } }));
  assert.deepEqual(empty, { isRepo: true, remote: null, branch: null, head: null, dirty: 0 });
});

test('repoFacts reads an answer from an unknown Host as not a repository rather than trusting it', () => {
  for (const v of [null, 'x', 5, {}, { isRepo: false }, { isRepo: 'true' }]) assert.deepEqual(T.repoFacts(v), { isRepo: false });
  assert.deepEqual(T.repoFacts({ isRepo: true, remote: 'https://u:p@h.io/a/b', branch: 'main', head: SHA, dirty: 3, extra: 1 }), {
    isRepo: true,
    remote: 'https://h.io/a/b',
    branch: 'main',
    head: SHA,
    dirty: 3,
  });
  assert.deepEqual(T.repoFacts({ isRepo: true, remote: 7, branch: '', head: 'zz', dirty: -1 }), {
    isRepo: true,
    remote: null,
    branch: null,
    head: null,
    dirty: 0,
  });
  assert.equal(T.repoFacts({ isRepo: true, branch: 'x'.repeat(1001) }).branch, null);
  assert.equal(T.repoFacts({ isRepo: true, dirty: 1.5 }).dirty, 0);
});

test('classifyTarget: ready, another branch, another repository, no repository, and nothing to compare', () => {
  const source = facts();
  assert.equal(T.classifyTarget(source, facts({ remote: 'git@github.com:a/b.git' })), 'ready');
  assert.equal(T.classifyTarget(source, facts({ branch: 'main' })), 'other_branch');
  assert.equal(T.classifyTarget(source, facts({ branch: null })), 'other_branch');
  assert.equal(T.classifyTarget(source, facts({ remote: 'https://github.com/a/c' })), 'other_repository');
  assert.equal(T.classifyTarget(source, facts({ remote: null })), 'other_repository');
  assert.equal(T.classifyTarget(source, { isRepo: false }), 'no_repository');
  assert.equal(T.classifyTarget(null, facts()), 'unverified');
  assert.equal(T.classifyTarget({ isRepo: false }, facts()), 'unverified');
  assert.equal(T.classifyTarget(facts({ remote: null }), facts()), 'unverified');
  assert.equal(T.classifyTarget(null, { isRepo: false }), 'no_repository');
  // a detached source is the same place only at the same commit
  const detached = facts({ branch: null });
  assert.equal(T.classifyTarget(detached, facts({ branch: null })), 'ready');
  assert.equal(T.classifyTarget(detached, facts({ branch: null, head: 'b'.repeat(40) })), 'other_branch');
  assert.equal(T.classifyTarget(detached, facts({ branch: 'main' })), 'other_branch');
  assert.equal(
    T.classifyTarget({ isRepo: true, remote: 'https://github.com/a/b' }, { isRepo: true, remote: 'https://github.com/a/b' }),
    'ready',
  );
});

test('codeLines: the handoff says what is known and nothing else', () => {
  assert.deepEqual(T.codeLines({ source: null }), []);
  assert.deepEqual(T.codeLines({ source: { isRepo: false }, target: facts() }), []);
  const ready = T.codeLines({ source: facts({ dirty: 2 }), target: facts({ dirty: 1 }) });
  assert.deepEqual(ready, [
    'Repository: https://github.com/a/b',
    `Branch: feat/x at ${SHA.slice(0, 12)}`,
    'This directory is a clone of that repository on that branch; run `git fetch` if the commit is missing.',
    'This directory has 1 uncommitted file of its own.',
    '2 uncommitted files on the previous host were not carried over.',
  ]);
  const other = T.codeLines({ source: facts({ head: null, dirty: 1 }), target: facts({ branch: 'main', dirty: 3 }) });
  assert.match(other.join('\n'), /Branch: feat\/x$/m);
  assert.match(other.join('\n'), /on branch main, not feat\/x; run `git fetch` and check feat\/x out/);
  assert.match(other.join('\n'), /3 uncommitted files of its own/);
  assert.match(other.join('\n'), /1 uncommitted file on the previous host/);
  assert.match(T.codeLines({ source: facts(), target: facts({ branch: null }) }).join('\n'), /on no branch, not feat\/x/);
  assert.match(T.codeLines({ source: facts(), target: facts({ remote: 'https://h/z/z' }) }).join('\n'), /another repository/);
  assert.match(T.codeLines({ source: facts(), target: { isRepo: false } }).join('\n'), /not a Git repository/);
  // a detached source names its commit; a source with no origin names none
  const detached = T.codeLines({ source: facts({ branch: null, remote: null }), target: null });
  assert.deepEqual(detached, [`Commit: ${SHA.slice(0, 12)} (no branch checked out)`]);
  assert.match(T.codeLines({ source: facts({ branch: null }), target: facts({ branch: 'main' }) }).join('\n'), /not the same commit/);
  assert.deepEqual(T.codeLines({ source: facts({ branch: null, head: null, remote: null }) }), []);
});

test('codeLines: facts without a changed-file count say nothing about changes', () => {
  const lines = T.codeLines({
    source: { isRepo: true, remote: 'https://github.com/a/b', branch: 'main' },
    target: { isRepo: true, remote: 'https://github.com/a/b', branch: 'main' },
  });
  assert.deepEqual(lines, [
    'Repository: https://github.com/a/b',
    'Branch: main',
    'This directory is a clone of that repository on that branch; run `git fetch` if the commit is missing.',
  ]);
});

test('the handoff text carries the repository lines, the target folder and a partial note together', () => {
  const base = { turns: [], fromLabel: 'Codex', cwd: '/work/b', partial: true };
  const out = continueHandoff({ ...base, code: { source: facts(), target: facts({ branch: 'main' }) } });
  assert.match(out.text, /Directory: \/work\/b\nRepository: https:\/\/github.com\/a\/b\nBranch: feat\/x at /);
  assert.match(out.text, /not feat\/x/);
  assert.ok(out.text.indexOf('Repository:') < out.text.indexOf('may be missing earlier turns'));
  assert.ok(!continueHandoff(base).text.includes('Repository:'));
});

// ---- the Host side, over real git ----
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-code-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const roots = path.join(base, 'roots');
fs.mkdirSync(roots);
const origin = path.join(base, 'origin');
fs.mkdirSync(origin);
git(origin, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(origin, 'a.txt'), 'a');
git(origin, 'add', '.');
git(origin, 'commit', '-qm', 'one');
git(origin, 'branch', 'feat/x');
const hostFs = createHostFs({ roots: [roots] });
const host = createHostGit({ hostFs });
const refusal = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e instanceof HostRefusal && e.code === code);

test('Host inspect: a real clone is read with its branch, commit and changes; a plain folder is not a repository; the roots bound it', async () => {
  const dest = path.join(roots, 'clone');
  const cloned = await host.clone({ key: 'key-branch-001', url: origin, dest, branch: 'feat/x' });
  assert.deepEqual(cloned, { path: dest, existed: false });
  assert.equal(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/x');
  const clean = await host.inspect({ path: dest });
  assert.deepEqual(clean, { isRepo: true, remote: null, branch: 'feat/x', head: git(dest, 'rev-parse', 'HEAD'), dirty: 0 });
  fs.writeFileSync(path.join(dest, 'new.txt'), 'x');
  assert.equal((await host.inspect({ path: dest })).dirty, 1);
  const plain = path.join(roots, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await host.inspect({ path: plain }), { isRepo: false });
  // a chat's folder outside the roots is still read
  assert.deepEqual(await host.inspect({ path: base }), { isRepo: false });
  await refusal(host.inspect({ path: path.join(plain, 'x') }), 'directory_missing');
  await refusal(host.inspect({ path: 'relative' }), 'invalid_path');
  await refusal(host.inspect({ path: path.join(roots, 'nope') }), 'directory_missing');
});

test('B2: a clone of a branch the remote lacks fails whole, and leaves no folder the picker would list', async () => {
  await refusal(host.clone({ key: 'key-nobranch-1', url: origin, dest: path.join(roots, 'ghost'), branch: 'no-such' }), 'clone_failed');
  assert.ok(!fs.readdirSync(roots).some((n) => n.startsWith('ghost') || n.includes('.clone-')));
});

test('I1: a branch that looks like an option or is not a branch name is refused before git clones', async () => {
  for (const [i, branch] of ['-x', '--upload-pack=touch', 'a..b', 'a b'].entries())
    await refusal(host.clone({ key: `key-badbr-00${i}`, url: origin, dest: path.join(roots, 'bad'), branch }), 'invalid_path');
  assert.ok(!fs.existsSync(path.join(roots, 'bad')));
});

test('W: a new key for the same repository on the same branch is a no-op however its address is written; another branch or repository there is refused', async () => {
  const dest = path.join(roots, 'again');
  fs.mkdirSync(dest);
  git(dest, 'init', '-q', '-b', 'feat/x');
  git(dest, 'remote', 'add', 'origin', 'https://tok@github.com/a/b.git');
  const same = await host.clone({ key: 'key-again-001', url: 'git@github.com:a/b.git', dest, branch: 'feat/x' });
  assert.deepEqual(same, { path: dest, existed: true });
  assert.equal((await host.clone({ key: 'key-again-002', url: 'https://github.com/a/b', dest })).existed, true);
  await refusal(host.clone({ key: 'key-again-003', url: 'https://github.com/a/b', dest, branch: 'main' }), 'invalid_path');
  await refusal(host.clone({ key: 'key-again-004', url: 'https://github.com/a/c', dest, branch: 'feat/x' }), 'invalid_path');
  // a folder whose origin is not an address names no repository, so nothing matches it
  git(dest, 'remote', 'set-url', 'origin', '/srv/local');
  await refusal(host.clone({ key: 'key-again-005', url: '/srv/local', dest }), 'invalid_path');
});

// ---- the app side ----
function app(o: { inspect?: (h: string, p: string) => Promise<unknown>; clone?: (h: string, r: any) => Promise<any> } = {}) {
  const reports: string[] = [];
  const clones: any[] = [];
  const inspects: string[] = [];
  const t = createCodeTransfer({
    inspect: async (h: string, p: string) => {
      inspects.push(`${h}:${p}`);
      if (o.inspect) return o.inspect(h, p);
      return facts();
    },
    clone: async (h: string, r: any) => {
      clones.push([h, r]);
      return o.clone ? o.clone(h, r) : { path: r.dest, existed: false };
    },
    newKey: () => 'key-minted-01',
    report: (m: string) => reports.push(m),
  });
  return { t, reports, clones, inspects };
}

test('readSource: the source folder as the Host reads it; a failure is reported and read as unknown, never thrown (I1)', async () => {
  const ok = app();
  assert.deepEqual(await ok.t.readSource({ sourceHostId: 'A', cwd: '/w' }), facts());
  assert.deepEqual(ok.inspects, ['A:/w']);
  const down = app({
    inspect: async () => {
      throw new Error('Host A is away');
    },
  });
  assert.equal(await down.t.readSource({ sourceHostId: 'A', cwd: '/w' }), null);
  assert.match(down.reports[0], /could not be read: Host A is away/);
  // an answer this app cannot read is not a repository
  const odd = app({ inspect: async () => 'weird' });
  assert.deepEqual(await odd.t.readSource({ sourceHostId: 'A', cwd: '/w' }), { isRepo: false });
});

test('check: the picked folder against the source; a folder the Host refuses is refused, not called empty (B2)', async () => {
  const same = app();
  assert.deepEqual(await same.t.check({ source: facts(), targetHostId: 'B', targetPath: '/t' }), { state: 'ready', target: facts() });
  const none = app({ inspect: async () => ({ isRepo: false }) });
  assert.equal((await none.t.check({ source: facts(), targetHostId: 'B', targetPath: '/t' })).state, 'no_repository');
  const gone = app({
    inspect: async () => {
      throw Object.assign(new Error('That folder does not exist on this host.'), { code: 'directory_missing' });
    },
  });
  await assert.rejects(gone.t.check({ source: facts(), targetHostId: 'B', targetPath: '/t' }), (e: any) => e.code === 'directory_missing');
});

test('cloneSource: the source repository on its branch, then the folder checked; only the public address is sent', async () => {
  const a = app();
  const source = facts({ remote: 'https://github.com/a/b' });
  const res = await a.t.cloneSource({ source, targetHostId: 'B', dest: '/roots/b' });
  assert.deepEqual(a.clones, [['B', { key: 'key-minted-01', url: 'https://github.com/a/b', dest: '/roots/b', branch: 'feat/x' }]]);
  assert.deepEqual([res.path, res.existed, res.state], ['/roots/b', false, 'ready']);
  assert.deepEqual(a.inspects, ['B:/roots/b']);
  // a detached source clones the default branch and says so
  const detached = app({ inspect: async () => facts({ branch: 'main' }) });
  const d = await detached.t.cloneSource({ source: facts({ branch: null }), targetHostId: 'B', dest: '/roots/b', key: 'key-given-001' });
  assert.equal(detached.clones[0][1].branch, undefined);
  assert.equal(detached.clones[0][1].key, 'key-given-001');
  assert.equal(d.state, 'other_branch');
});

test('cloneSource: nothing to clone from, or a clone that fails, is refused with a reason and nothing is checked (B2)', async () => {
  const a = app();
  for (const [source, code] of [
    [null, 'unknown_source'],
    [{ isRepo: false }, 'unknown_source'],
    [facts({ remote: null }), 'no_remote'],
  ] as const)
    await assert.rejects(
      a.t.cloneSource({ source, targetHostId: 'B', dest: '/d' }),
      (e: any) => e.name === 'ContinueRefusal' && e.code === code,
    );
  assert.deepEqual(a.clones, []);
  const failing = app({
    clone: async () => {
      throw Object.assign(new Error('Repository not found.'), { code: 'clone_failed' });
    },
  });
  await assert.rejects(failing.t.cloneSource({ source: facts(), targetHostId: 'B', dest: '/d' }), (e: any) => e.code === 'clone_failed');
  assert.deepEqual(failing.inspects, []);
});

test('localInspect reads a folder on this Mac with the app git runner and its time limit', async () => {
  const seen: [string[], string, number | undefined][] = [];
  const run = localInspect(async (args: string[], cwd: string, timeout?: number) => {
    seen.push([args, cwd, timeout]);
    return { ok: false, stdout: '', stderr: '' };
  });
  assert.deepEqual(await run('/Users/me/proj'), { isRepo: false });
  assert.deepEqual(seen, [[['rev-parse', '--is-inside-work-tree'], '/Users/me/proj', 10_000]]);
});

test('a real folder on this Mac is read the same way the Host reads it', async () => {
  const run = localInspect(async (args: string[], cwd: string) => {
    try {
      return { ok: true, stdout: git(cwd, ...args), stderr: '' };
    } catch (e) {
      return { ok: false, stdout: '', stderr: String(e) };
    }
  });
  const got = await run(origin);
  assert.equal(got.isRepo, true);
  assert.equal(got.branch, 'main');
  assert.equal(got.remote, null);
  assert.match(got.head, /^[0-9a-f]{40}/);
  const unborn = path.join(base, 'unborn');
  fs.mkdirSync(unborn);
  git(unborn, 'init', '-q', '-b', 'dev');
  assert.deepEqual(await run(unborn), { isRepo: true, remote: null, branch: 'dev', head: null, dirty: 0 });
});
