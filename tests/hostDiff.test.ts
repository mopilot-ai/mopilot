// The Host's patch view of a chat's folder (host/src/hostRead.mjs diff, #4105): what changed against HEAD or the base branch inside that folder, untracked files as new files, read with the repository's filters neutralized, cut at the output bound, only inside the roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostRead, MAX_UNTRACKED_BYTES, MAX_UNTRACKED_PATCHES } from '../host/src/hostRead.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-diff-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const read: any = createHostRead({ hostFs });
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
let n = 0;
const repo = () => {
  const dir = path.join(root, `r${n++}`);
  fs.mkdirSync(dir);
  g(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  return dir;
};

test('uncommitted changes are against HEAD, branch changes against main; both list new files, with paths relative to the folder', async () => {
  const dir = repo();
  g(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n');
  g(dir, 'commit', '-qam', 'two');
  fs.appendFileSync(path.join(dir, 'a.txt'), '4\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
  const un = await read.diff({ path: dir, scope: 'uncommitted' });
  assert.equal(un.isRepo, true);
  assert.match(un.patch, /^diff --git a\/a\.txt b\/a\.txt$/m);
  assert.match(un.patch, /^\+4$/m);
  assert.doesNotMatch(un.patch, /^\+3$/m, 'the committed line is not uncommitted');
  assert.match(un.patch, /^diff --git a\/new\.txt b\/new\.txt$/m);
  assert.match(un.patch, /^\+fresh$/m);
  assert.deepEqual([un.truncated, un.unreadable], [false, false]);
  const br = await read.diff({ path: dir, scope: 'branch' });
  assert.match(br.patch, /^\+3$/m, 'the committed line is a branch change');
  assert.match(br.patch, /^\+4$/m);
  assert.match(br.patch, /^\+fresh$/m);
});

test('the files in conflict are named as git lists them, inside the folder only; none when nothing is unmerged', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'sub');
  assert.deepEqual((await read.diff({ path: dir, scope: 'uncommitted' })).conflicted, []);
  for (const f of ['a.txt', 'sub/b.txt']) fs.writeFileSync(path.join(dir, f), 'stashed\n');
  g(dir, 'stash', 'push', '-q');
  for (const f of ['a.txt', 'sub/b.txt']) fs.writeFileSync(path.join(dir, f), 'committed\n');
  g(dir, 'commit', '-qam', 'other');
  assert.equal(spawnSync('git', ['stash', 'pop', '-q'], { cwd: dir }).status, 1);
  // the status the real Host reads says UU for both; the pane is told the same two files
  assert.match(g(dir, 'status', '--porcelain'), /^UU a\.txt\nUU sub\/b\.txt/);
  const all = await read.diff({ path: dir, scope: 'uncommitted' });
  assert.deepEqual([...all.conflicted].sort(), ['a.txt', 'sub/b.txt']);
  assert.match(all.patch, /^diff --git a\/a\.txt b\/a\.txt$/m, 'the conflicted file is still in the patch');
  assert.deepEqual((await read.diff({ path: path.join(dir, 'sub'), scope: 'uncommitted' })).conflicted, ['b.txt']);
  // as on this Mac, the uncommitted scope (the one that commits) is where conflicts are named
  assert.deepEqual((await read.diff({ path: dir, scope: 'branch' })).conflicted, []);
});

test('a repository with no commit gives only its new files; a folder that is no repository says so', async () => {
  const dir = path.join(root, 'fresh');
  fs.mkdirSync(dir);
  g(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'x'), '1\n');
  const r = await read.diff({ path: dir, scope: 'branch' });
  assert.match(r.patch, /^\+1$/m);
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await read.diff({ path: plain, scope: 'uncommitted' }), { isRepo: false });
});

test('a repository cannot make the read run its code, and one above the folder says nothing of files outside it', async () => {
  const dir = repo();
  const marker = path.join(base, 'diff-ran');
  const script = path.join(base, 'diff.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  g(dir, 'config', 'filter.a.clean', script);
  g(dir, 'config', 'diff.evil.textconv', script);
  g(dir, 'config', 'diff.external', script);
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt filter=a diff=evil\nnew.txt filter=a diff=evil\n');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  const r = await read.diff({ path: dir, scope: 'uncommitted' });
  assert.match(r.patch, /^\+more$/m);
  assert.equal(fs.existsSync(marker), false, 'nothing the repository named was run');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'in.txt'), 'in\n');
  g(dir, 'add', 'sub/in.txt');
  g(dir, 'commit', '-qm', 'sub');
  fs.appendFileSync(path.join(sub, 'in.txt'), 'edited\n');
  const only = await read.diff({ path: sub, scope: 'uncommitted' });
  assert.match(only.patch, /^\+edited$/m);
  assert.match(only.patch, /^diff --git a\/in\.txt b\/in\.txt$/m, 'relative to the folder');
  assert.doesNotMatch(only.patch, /more|a\.txt/, 'nothing outside the folder');
});

test('a folder outside the roots or behind a link out of them is refused', async () => {
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  await assert.rejects(read.diff({ path: outside, scope: 'branch' }), (e: any) => e.code === 'outside_roots');
  fs.symlinkSync(outside, path.join(root, 'diff-link'));
  await assert.rejects(read.diff({ path: path.join(root, 'diff-link'), scope: 'branch' }), (e: any) => e.code === 'outside_roots');
});

test('a diff that cannot be read says so; a cut or a flood of new files is said to be truncated and ends at a whole line; a timeout is a coded refusal', async () => {
  const dir = repo();
  const scripted = (over: (args: string[]) => any): any =>
    createHostRead({
      hostFs,
      run: (async (args: string[]) => (args.includes('config') ? { ok: false, stdout: '', stderr: '', code: 1 } : over(args))) as any,
    });
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  const no = { ok: false, stdout: '', stderr: '' };
  const sha = 'a'.repeat(40);
  const answers =
    (diff: any, others: any, untracked: (a: string[]) => any = () => ok('')) =>
    (args: string[]) => {
      if (args.includes('--is-inside-work-tree')) return ok('true\n');
      if (args.includes('--verify')) return ok(`${sha}\n`);
      if (args.includes('merge-base')) return ok(`${sha}\n`);
      if (args.includes('--no-index')) return untracked(args);
      if (args.includes('diff')) return diff;
      if (args.includes('--others')) return others;
      return no;
    };
  const unreadable = await scripted(answers(no, ok(''))).diff({ path: dir, scope: 'uncommitted' });
  assert.deepEqual([unreadable.unreadable, unreadable.patch], [true, '']);
  const cut = await scripted(answers({ ...no, stdout: 'diff --git a/x b/x\n+one\n+tw', cut: true }, ok(''))).diff({
    path: dir,
    scope: 'branch',
  });
  assert.deepEqual([cut.truncated, cut.patch], [true, 'diff --git a/x b/x\n+one\n']);
  const many = Array.from({ length: MAX_UNTRACKED_PATCHES + 4 }, (_, i) => `u${i}`).join('\0');
  const seen: string[] = [];
  const flood = await scripted(
    answers(ok(''), ok(`${many}\0`), (a) => (seen.push(a.at(-1)!), ok(`diff --git a/${a.at(-1)} b/${a.at(-1)}\n`))),
  ).diff({
    path: dir,
    scope: 'uncommitted',
  });
  assert.deepEqual([flood.truncated, seen.length], [true, MAX_UNTRACKED_PATCHES]);
  const cutOthers = await scripted(answers(ok(''), { ...no, stdout: 'u\0', cut: true })).diff({ path: dir, scope: 'uncommitted' });
  assert.equal(cutOthers.truncated, true);
  const failedOthers = await scripted(answers(ok('diff --git a/x b/x\n+1\n'), no)).diff({ path: dir, scope: 'uncommitted' });
  assert.deepEqual([failedOthers.truncated, failedOthers.patch], [false, 'diff --git a/x b/x\n+1\n']);
  const huge = 'x'.repeat(4_000_100);
  const over = await scripted(answers(ok(`${huge}\n`), ok(''))).diff({ path: dir, scope: 'uncommitted' });
  assert.equal(over.truncated, true);
  assert.equal(over.patch, '', 'one line past the bound leaves nothing whole');
  const bigUntracked = await scripted(answers(ok(`${'y'.repeat(4_000_000)}\n`), ok('u\0'), () => ok('never\n'))).diff({
    path: dir,
    scope: 'uncommitted',
  });
  assert.equal(bigUntracked.patch.includes('never'), false, 'no more is read once the patch is full');
  await assert.rejects(
    scripted(() => ({ ...no, signal: 'SIGTERM' })).diff({ path: dir, scope: 'branch' }),
    (e: any) => e.code === 'read_timed_out',
  );
});

test('over the socket git.diff answers a paired client and refuses a scope that is none; without wiring it is unknown', async () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'a.txt'), '3\n');
  const paths = createPaths({ dataDir: path.join(base, 'sock'), env: {} });
  const server = await startServer({ paths, dirs: { hostFs, hostGit: {}, hostRead: read } as any });
  try {
    const ok: any = await callHost(paths.socketPath, 'git.diff', { path: dir, scope: 'uncommitted' });
    assert.match(ok.result.patch, /^\+3$/m);
    assert.match(((await callHost(paths.socketPath, 'git.diff', { path: dir, scope: 'all' })) as any).error, /uncommitted or branch/);
    assert.match(((await callHost(paths.socketPath, 'git.diff', { path: dir })) as any).error, /uncommitted or branch/);
    assert.equal(((await callHost(paths.socketPath, 'git.diff', { path: '/etc', scope: 'branch' })) as any).code, 'outside_roots');
  } finally {
    await server.close();
  }
  const bare = createPaths({ dataDir: path.join(base, 'sock2'), env: {} });
  const unwired = await startServer({ paths: bare });
  try {
    assert.match(((await callHost(bare.socketPath, 'git.diff', { path: dir, scope: 'branch' })) as any).error, /Unknown method/);
  } finally {
    await unwired.close();
  }
});

test('a filter whose name holds an equals sign, set in the repository or in a file it includes, is neutralized too, for the patch and for the status', async () => {
  const dir = repo();
  const marker = path.join(base, 'eq-ran');
  const script = path.join(base, 'eq.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  g(dir, 'config', 'filter.x=y.clean', script);
  const included = path.join(base, 'eq-included.cfg');
  fs.writeFileSync(included, `[filter "q=r"]\n\tclean = ${script}\n`);
  g(dir, 'config', 'include.path', included);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=x=y\n*.dat filter=q=r\n');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'edited\n');
  fs.writeFileSync(path.join(dir, 'n.txt'), 'n\n');
  fs.writeFileSync(path.join(dir, 'n.dat'), 'd\n');
  const r = await read.diff({ path: dir, scope: 'uncommitted' });
  assert.match(r.patch, /^\+edited$/m);
  assert.match(r.patch, /^\+n$/m);
  const s = await read.status({ path: dir });
  assert.equal(
    s.files.some((f: any) => f.path === 'a.txt'),
    true,
  );
  assert.equal(fs.existsSync(marker), false, 'no filter the repository named was run');
});

test('an untracked file cut at the bound says the patch is cut, and one too big to read is a row with no lines', async () => {
  const dir = repo();
  const scripted = (run: any, lstat?: any): any =>
    createHostRead({
      hostFs,
      run: (args: string[]) => (args.includes('config') ? { ok: false, stdout: '', stderr: '', code: 1 } : run(args)),
      fsp: lstat ? ({ ...fs.promises, lstat } as any) : fs.promises,
    });
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  const sha = 'a'.repeat(40);
  const answers = (untracked: any) => async (args: string[]) => {
    if (args.includes('--is-inside-work-tree')) return ok('true\n');
    if (args.includes('--verify')) return ok(`${sha}\n`);
    if (args.includes('--no-index')) return untracked;
    if (args.includes('diff')) return ok('');
    if (args.includes('--others')) return ok('big.txt\0');
    return { ok: false, stdout: '', stderr: '' };
  };
  const cut = await scripted(
    answers({ ok: false, stdout: 'diff --git a/big.txt b/big.txt\n+aaaa\n+bb', stderr: '', cut: true }),
    async () => ({ size: 10 }),
  ).diff({
    path: dir,
    scope: 'uncommitted',
  });
  assert.deepEqual([cut.truncated, cut.patch], [true, 'diff --git a/big.txt b/big.txt\n+aaaa\n']);
  const asked: string[] = [];
  const big = await scripted(
    async (args: string[]) => (args.includes('--no-index') ? asked.push('read') : 0, answers(ok('x\n'))(args)),
    async () => ({
      size: MAX_UNTRACKED_BYTES + 1,
    }),
  ).diff({ path: dir, scope: 'uncommitted' });
  // a row with its size and no lines, never read, and not a cut (#5277)
  assert.deepEqual(
    [big.truncated, big.patch, asked],
    [false, `diff --git a/big.txt b/big.txt\nnew file mode 100644\nLarge file, not shown: ${MAX_UNTRACKED_BYTES + 1} bytes\n`, []],
  );
  // a file that vanished meanwhile is read as empty, not an error
  const gone = await scripted(answers(ok('diff --git a/big.txt b/big.txt\n')), async () => {
    throw new Error('ENOENT');
  }).diff({ path: dir, scope: 'uncommitted' });
  assert.equal(gone.patch, 'diff --git a/big.txt b/big.txt\n');
});
