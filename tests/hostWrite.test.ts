// The Host's writes of a chat's folder (host/src/hostWrite.mjs, #5050): commit and discard with real git, the same steps as this Mac's Changes pane, a folder inside a repository kept to itself, hardened git, an audit line before each write with no content in it, and refusals outside the roots, outside a work tree and past the time bound.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostWrite } from '../host/src/hostWrite.mjs';
// @ts-ignore: plain ESM without declarations
import gitWriteMethods from '../host/src/methods/gitWrite.mjs';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-write-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trimEnd();
};
let n = 0;
const repo = () => {
  const dir = path.join(root, `r${n++}`);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  g(dir, 'init', '-q', '--initial-branch=main');
  for (const [k, v] of [
    ['user.name', 't'],
    ['user.email', 't@example.invalid'],
    ['commit.gpgsign', 'false'],
  ])
    g(dir, 'config', k, v);
  for (const f of ['a.txt', 'b.txt', 'sub/c.txt', 'top.txt']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  return dir;
};
const put = (dir: string, f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
const lines: any[] = [];
const audit = { governed: (e: any) => (lines.push(e), true) };
const write: any = createHostWrite({ hostFs, audit });

test('every change is committed with the message; the work tree is clean after, and the audit line holds no content', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'changed SECRET-BODY\n');
  put(dir, 'new.txt', 'fresh\n');
  lines.length = 0;
  const r = await write.commit({ path: dir, message: 'SECRET-MESSAGE', files: null }, 'desktop');
  assert.equal(r.ok, true, r.stderr);
  assert.equal(g(dir, 'status', '--porcelain'), '');
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'SECRET-MESSAGE');
  assert.deepEqual(lines, [{ kind: 'git.write', by: { kind: 'desktop' }, what: { kind: 'commit' } }]);
  assert.doesNotMatch(JSON.stringify(lines), /SECRET|a\.txt|new\.txt/);
});

test('only the ticked files are committed; the others stay as they were, staged or not', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'a2\n');
  put(dir, 'b.txt', 'b2\n');
  g(dir, 'add', 'b.txt');
  g(dir, 'rm', '-q', 'top.txt');
  put(dir, 'new.txt', 'n\n');
  const r = await write.commit({ path: dir, message: 'two', files: [{ path: 'a.txt' }, { path: 'top.txt', isDeleted: true }] }, 'phone');
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(g(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['M\ta.txt', 'D\ttop.txt'].sort());
  assert.deepEqual(g(dir, 'status', '--porcelain').split('\n').sort(), ['?? new.txt', 'M  b.txt'].sort());
});

test('a commit refused or failed by git is an answer with its words; a merge under way refuses a partial commit in a sentence', async () => {
  const dir = repo();
  const nothing = await write.commit({ path: dir, message: 'x', files: null }, 'desktop');
  assert.equal(nothing.ok, false);
  assert.match(nothing.stderr, /nothing|clean/i);
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${g(dir, 'rev-parse', 'HEAD')}\n`);
  put(dir, 'a.txt', 'a3\n');
  const refused = await write.commit({ path: dir, message: 'x', files: [{ path: 'a.txt' }] }, 'desktop');
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.match(refused.stderr, /merge, rebase, cherry-pick or revert/);
  assert.equal(JSON.stringify(refused).includes('warning'), false);
});

test('a folder inside a repository commits and discards only its own files', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'outside\n');
  put(dir, 'sub/c.txt', 'inside\n');
  put(dir, 'sub/d.txt', 'new inside\n');
  put(dir, 'z.txt', 'new outside\n');
  const sub = path.join(dir, 'sub');
  assert.equal((await write.discard({ path: sub, file: 'd.txt' }, 'desktop')).ok, true);
  assert.equal(fs.existsSync(path.join(sub, 'd.txt')), false);
  assert.equal((await write.discard({ path: sub, file: 'c.txt' }, 'desktop')).ok, true);
  assert.equal(fs.readFileSync(path.join(sub, 'c.txt'), 'utf8'), 'sub/c.txt\n');
  put(dir, 'sub/c.txt', 'inside again\n');
  assert.equal((await write.discard({ path: sub, file: null }, 'desktop')).ok, true);
  assert.equal(fs.readFileSync(path.join(sub, 'c.txt'), 'utf8'), 'sub/c.txt\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'outside\n', 'a file outside the folder is left');
  assert.equal(fs.existsSync(path.join(dir, 'z.txt')), true);
  put(dir, 'sub/c.txt', 'content to commit, longer\n');
  assert.equal((await write.commit({ path: sub, message: 'in sub', files: [{ path: 'c.txt' }] }, 'desktop')).ok, true);
  assert.equal(g(dir, 'status', '--porcelain', '--', 'sub'), '');
  assert.match(g(dir, 'status', '--porcelain'), /a\.txt/);
  put(dir, 'sub/c.txt', 'content to commit all, longer still\n');
  assert.equal((await write.commit({ path: sub, message: 'all in sub', files: null }, 'desktop')).ok, true);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'all in sub');
});

test('discard restores tracked files, removes untracked ones, and discard all does both', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'x\n');
  put(dir, 'b.txt', 'y\n');
  g(dir, 'add', 'b.txt');
  put(dir, 'new.txt', 'n\n');
  assert.equal((await write.discard({ path: dir, file: 'a.txt' }, 'desktop')).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal((await write.discard({ path: dir, file: 'new.txt' }, 'desktop')).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  put(dir, 'new2.txt', 'n\n');
  assert.equal((await write.discard({ path: dir, file: null }, 'desktop')).ok, true);
  assert.equal(g(dir, 'status', '--porcelain'), '');
});

test('a folder that is no repository, outside the roots or missing is refused with its code, and nothing is audited', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  lines.length = 0;
  await assert.rejects(write.commit({ path: plain, message: 'm', files: null }, 'desktop'), { code: 'not_a_repository' });
  await assert.rejects(write.discard({ path: plain, file: null }, 'desktop'), { code: 'not_a_repository' });
  await assert.rejects(write.discard({ path: base, file: null }, 'desktop'), { code: 'outside_roots' });
  await assert.rejects(write.discard({ path: path.join(root, 'gone'), file: null }, 'desktop'), { code: 'directory_missing' });
  assert.deepEqual(lines, []);
});

test('a record that is required and cannot be written stops the write before git changes anything', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'keep\n');
  const refusing: any = createHostWrite({
    hostFs,
    audit: {
      governed: () => {
        throw Object.assign(new Error('no record'), { code: 'audit_unavailable' });
      },
    },
  });
  await assert.rejects(refusing.discard({ path: dir, file: 'a.txt' }, 'desktop'), { code: 'audit_unavailable' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'keep\n');
  // a Host with no record at all still writes
  const bare: any = createHostWrite({ hostFs });
  assert.equal((await bare.discard({ path: dir, file: 'a.txt' }, 'desktop')).ok, true);
});

test('git past its time bound is a coded refusal, and a write waits for the one before it in the same folder', async () => {
  const dir = repo();
  const stuck: any = createHostWrite({ hostFs, run: async () => ({ ok: false, stdout: '', stderr: '', signal: 'SIGTERM' }) as any });
  await assert.rejects(stuck.commit({ path: dir, message: 'm', files: null }, 'desktop'), { code: 'write_timed_out' });
  const order: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const real = (await import('../host/src/hostGit.mjs')) as any;
  const slow: any = createHostWrite({
    hostFs,
    run: async (args: string[], o: any) => {
      if (args[0] === 'ls-files') {
        order.push('start');
        await gate;
        order.push('end');
      }
      return real.runGit(args, o);
    },
  });
  const first = slow.discard({ path: dir, file: null }, 'desktop');
  const second = slow.discard({ path: dir, file: null }, 'desktop');
  while (!order.length) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, ['start'], 'the second waits');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
  // a failed write does not block the next
  const failing: any = createHostWrite({ hostFs, run: async () => ({ ok: false, stdout: '', stderr: '', signal: 'SIGTERM' }) as any });
  await assert.rejects(failing.discard({ path: dir, file: null }, 'desktop'));
  await assert.rejects(failing.discard({ path: dir, file: null }, 'desktop'), { code: 'write_timed_out' });
});

test('a commit that was made but whose index could not be updated afterwards says so', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'warned, and longer\n');
  const real = (await import('../host/src/hostGit.mjs')) as any;
  const odd: any = createHostWrite({
    hostFs,
    run: async (args: string[], o: any) =>
      args[0] === 'reset' ? { ok: false, stdout: '', stderr: 'locked', signal: null } : real.runGit(args, o),
  });
  const r = await odd.commit({ path: dir, message: 'warned', files: [{ path: 'a.txt' }] }, 'desktop');
  assert.equal(r.ok, true);
  assert.match(r.warning, /Committed, but/);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'warned');
});

test('a hook of the repository does not run on the Host', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${path.join(dir, 'HOOK-RAN')}\nexit 1\n`, { mode: 0o755 });
  put(dir, 'a.txt', 'h\n');
  const r = await write.commit({ path: dir, message: 'hooked', files: null }, 'desktop');
  assert.equal(r.ok, true, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'HOOK-RAN')), false);
});

test('git’s words are bounded, and a Host given no folder service refuses the methods', async () => {
  const dir = repo();
  const long: any = createHostWrite({
    hostFs,
    run: async (args: string[]) =>
      args[0] === 'rev-parse'
        ? ({ ok: true, stdout: '\n', stderr: '', signal: null } as any)
        : ({ ok: false, stdout: '', stderr: 'x'.repeat(10_000), signal: null } as any),
  });
  assert.equal((await long.discard({ path: dir, file: 'a.txt' }, 'desktop')).stderr.length <= 4000, true);
  const { handlers } = (gitWriteMethods as any)({});
  assert.throws(() => handlers['host.gitCommit']({}, 'desktop'), /cannot change a folder/);
  assert.throws(() => handlers['host.gitDiscard']({}, 'desktop'), /cannot change a folder/);
  const served = (gitWriteMethods as any)({ hostFs }).handlers;
  const done = await served['host.gitDiscard']({ path: dir, file: null }, 'cli');
  assert.equal(done.ok, true);
  assert.equal((await served['host.gitCommit']({ path: dir, message: 'x', files: null }, 'cli')).ok, false);
});

test('the parsers take a folder, a message and files inside it, and refuse anything else', () => {
  const ok = parseParams('host.gitCommit', {
    path: '/srv/app',
    message: 'm',
    files: [{ path: 'a/b.ts', oldPath: 'a/c.ts', isCopy: true, isDeleted: true, extra: 1 }, { path: 'x' }],
  });
  assert.deepEqual(ok, {
    path: '/srv/app',
    message: 'm',
    files: [{ path: 'a/b.ts', oldPath: 'a/c.ts', isCopy: true, isDeleted: true }, { path: 'x' }],
  });
  assert.equal(parseParams('host.gitCommit', { path: '/srv/app', message: 'm', files: null }).files, null);
  const bad = (p: any) => assert.throws(() => parseParams('host.gitCommit', { path: '/srv/app', message: 'm', files: null, ...p }));
  bad({ message: '  ' });
  bad({ message: 5 });
  bad({ message: 'a\0b' });
  bad({ message: 'x'.repeat(20_001) });
  bad({ files: 'a' });
  bad({ files: undefined });
  bad({ files: Array.from({ length: 5001 }, () => ({ path: 'a' })) });
  for (const path of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', '', 'a\0', 'x'.repeat(5000), 7, undefined]) bad({ files: [{ path }] });
  bad({ files: [{ path: 'a', oldPath: '../b' }] });
  bad({ files: [null] });
  assert.throws(() => parseParams('host.gitCommit', { path: '', message: 'm', files: null }));
  assert.deepEqual(parseParams('host.gitDiscard', { path: '/srv/app', file: 'a.ts' }), { path: '/srv/app', file: 'a.ts' });
  assert.deepEqual(parseParams('host.gitDiscard', { path: '/srv/app', file: null }), { path: '/srv/app', file: null });
  assert.deepEqual(parseParams('host.gitDiscard', { path: '/srv/app' }), { path: '/srv/app', file: null });
  assert.throws(() => parseParams('host.gitDiscard', { path: '/srv/app', file: '../up' }));
});

test('a commit of every change refuses while files are in conflict, with the markers unstaged and nothing committed', async () => {
  const dir = repo();
  put(dir, 'a.txt', 'stashed\n');
  put(dir, 'b.txt', 'stashed\n');
  g(dir, 'stash', 'push', '-q');
  put(dir, 'a.txt', 'committed\n');
  put(dir, 'b.txt', 'committed\n');
  g(dir, 'commit', '-qam', 'other');
  assert.equal(spawnSync('git', ['stash', 'pop', '-q'], { cwd: dir }).status, 1);
  const head = g(dir, 'rev-parse', 'HEAD');
  const r = await write.commit({ path: dir, message: 'markers', files: null }, 'desktop');
  assert.deepEqual([r.ok, r.refused, r.stderr], [false, true, 'Resolve conflicts in 2 files first.']);
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
  assert.match(g(dir, 'status', '--porcelain'), /^UU a\.txt\nUU b\.txt/);
});
