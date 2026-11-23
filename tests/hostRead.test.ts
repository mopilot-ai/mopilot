// The Host's read-only view of a chat's folder (host/src/hostRead.mjs, #4103): the branch and changes of its repository, read with hardened git, bounded in time and size, and only inside the roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostRead, MAX_STATUS_FILES } from '../host/src/hostRead.mjs';
// @ts-ignore: plain ESM without declarations
import { runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
import { parseUnifiedDiff } from '../src/lib/diff.ts';
import { BRANCH_COMPARISON_GIT_ENV } from '../shared/gitComparisonBase.mjs';
import { repoOf } from '../src/lib/hostRepo.ts';

/** The totals of files with their added and removed lines. */
const totals = (files: { added: number; removed: number }[]) => [
  files.reduce((a, f) => a + f.added, 0),
  files.reduce((a, f) => a + f.removed, 0),
];

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-read-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const read: any = createHostRead({ hostFs: createHostFs({ roots: [root] }) });
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

test('a folder that is no repository says so; a repository lists its branch, remote and changes against main', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await read.status({ path: plain }), { isRepo: false });
  const dir = repo();
  g(dir, 'remote', 'add', 'origin', 'https://user:secret@example.com/o/r.git?token=x');
  g(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n3\n');
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 0]));
  g(dir, 'add', 'b.bin');
  g(dir, 'commit', '-qm', 'two');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'c\n');
  const s = await read.status({ path: dir });
  assert.equal(s.isRepo, true);
  assert.equal(s.branch, 'feature');
  assert.match(s.head, /^[0-9a-f]{40}$/);
  assert.equal(s.remote, 'https://example.com/o/r.git', 'a remote shows without its credentials or query');
  assert.equal(s.truncated, false);
  assert.deepEqual(
    [...s.files].sort((a: any, b: any) => a.path.localeCompare(b.path)),
    [
      { path: 'a.txt', added: 1, removed: 0 },
      { path: 'b.bin', added: 0, removed: 0, binary: true },
      { path: 'new.txt', added: 1, removed: 0, untracked: true, counted: true },
      { path: 'sub/c.txt', added: 1, removed: 0, untracked: true, counted: true },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
});

test('the base is origin’s default branch when the repository has one, and HEAD when it has no main, master or origin', async () => {
  const upstream = repo();
  const clone = path.join(root, `clone${n++}`);
  g(root, 'clone', '-q', upstream, clone);
  g(clone, 'checkout', '-qb', 'work');
  fs.appendFileSync(path.join(clone, 'a.txt'), 'more\n');
  assert.deepEqual(
    (await read.status({ path: clone })).files,
    [{ path: 'a.txt', added: 1, removed: 0 }],
    'against origin/main from origin/HEAD',
  );
  const odd = path.join(root, `odd${n++}`);
  fs.mkdirSync(odd);
  g(odd, 'init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(odd, 'x'), '1\n');
  g(odd, 'add', '.');
  g(odd, 'commit', '-qm', 'x');
  fs.appendFileSync(path.join(odd, 'x'), '2\n');
  assert.deepEqual((await read.status({ path: odd })).files, [{ path: 'x', added: 1, removed: 0 }], 'against HEAD: no other base');
});

test('a repository with no commit has a branch and untracked files; a detached head has no branch', async () => {
  const dir = path.join(root, 'fresh');
  fs.mkdirSync(dir);
  g(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'x'), '1\n');
  const s = await read.status({ path: dir });
  assert.deepEqual([s.isRepo, s.head, s.files], [true, null, [{ path: 'x', added: 1, removed: 0, untracked: true, counted: true }]]);
  const d = repo();
  g(d, 'checkout', '-q', '--detach');
  assert.equal((await read.status({ path: d })).branch, null);
});

test('a repository cannot make the read run its code: fsmonitor, a text filter and an external diff stay unrun', async () => {
  const dir = repo();
  const marker = path.join(base, 'ran');
  const script = path.join(base, 'evil.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  g(dir, 'config', 'core.fsmonitor', script);
  g(dir, 'config', 'diff.evil.textconv', script);
  g(dir, 'config', 'diff.external', script);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n2\n9\n');
  const s = await read.status({ path: dir });
  assert.equal(s.files.find((f: any) => f.path === 'a.txt')?.added, 1);
  assert.equal(fs.existsSync(marker), false, 'nothing the repository named was run');
});

test('a repository’s clean filter, long-running filter and an included file’s filter stay unrun', async () => {
  const dir = repo();
  for (const f of ['b.txt', 'c.txt']) fs.writeFileSync(path.join(dir, f), 'x\n');
  g(dir, 'add', 'b.txt', 'c.txt');
  g(dir, 'commit', '-qm', 'more');
  // the filters come after the files are committed: the repository's own config now names programs for them
  const marker = path.join(base, 'filter-ran');
  const script = path.join(base, 'filter.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  g(dir, 'config', 'filter.a.clean', script);
  g(dir, 'config', 'filter.b.process', script);
  g(dir, 'config', 'filter.b.required', 'true');
  // a filter defined in a file the repository's config includes
  const included = path.join(base, 'included.cfg');
  fs.writeFileSync(included, `[filter "c"]\n\tclean = ${script}\n`);
  g(dir, 'config', 'include.path', included);
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'a.txt filter=a\nb.txt filter=b\nc.txt filter=c\n');
  fs.rmSync(marker, { force: true });
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.appendFileSync(path.join(dir, f), 'y\n');
  const s = await read.status({ path: dir });
  assert.deepEqual(
    s.files
      .filter((f: any) => !f.untracked)
      .map((f: any) => f.path)
      .sort(),
    ['a.txt', 'b.txt', 'c.txt'],
    'the edits are listed',
  );
  assert.equal(fs.existsSync(marker), false, 'no filter the repository named was run');
});

test('a repository above the folder says nothing of files outside it', async () => {
  const up = repo();
  const sub = path.join(up, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'in.txt'), 'in\n');
  g(up, 'add', 'sub/in.txt');
  g(up, 'commit', '-qm', 'sub');
  fs.appendFileSync(path.join(up, 'a.txt'), 'outside\n');
  fs.appendFileSync(path.join(sub, 'in.txt'), 'edited\n');
  fs.writeFileSync(path.join(up, 'untracked-outside.txt'), 'u\n');
  fs.writeFileSync(path.join(sub, 'untracked-inside.txt'), 'u\n');
  const s = await read.status({ path: sub });
  assert.deepEqual(
    [...s.files].sort((a: any, b: any) => a.path.localeCompare(b.path)),
    [
      { path: 'in.txt', added: 1, removed: 0 },
      { path: 'untracked-inside.txt', added: 1, removed: 0, untracked: true, counted: true },
    ],
  );
});

test('a file named like a flag is a path, and a folder outside the roots or behind a link out of them is refused', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '--output=x'), 'flag\n');
  const s = await read.status({ path: dir });
  assert.equal(
    s.files.some((f: any) => f.path === '--output=x'),
    true,
  );
  assert.equal(fs.existsSync(path.join(dir, 'x')), false, 'the name was never read as an option');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  await assert.rejects(read.status({ path: outside }), (e: any) => e.code === 'outside_roots');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link);
  await assert.rejects(read.status({ path: link }), (e: any) => e.code === 'outside_roots', 'the real path decides');
  await assert.rejects(read.status({ path: path.join(root, 'gone') }), (e: any) => e.code === 'directory_missing');
  await assert.rejects(read.status({ path: 'relative' }), (e: any) => e.code === 'invalid_path');
});

test('a run that times out is a coded refusal; output past its bound or too many files is cut and said so; an unreadable diff says so', async () => {
  const dir = repo();
  const scripted = (over: (args: string[]) => any): any =>
    createHostRead({
      hostFs: createHostFs({ roots: [root] }),
      run: (async (args: string[], opts: { env: Record<string, string> }) => {
        if (args.includes('--numstat') && !args.includes('--no-index')) {
          assert.equal(opts.env.GIT_NO_LAZY_FETCH, '1');
          assert.equal(opts.env.GIT_ALLOW_PROTOCOL, '');
        }
        return args.includes('config') ? { ok: false, stdout: '', stderr: '', code: 1 } : over(args);
      }) as any,
    });
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  const no = { ok: false, stdout: '', stderr: '' };
  const hung = scripted(() => ({ ...no, signal: 'SIGTERM' }));
  await assert.rejects(hung.status({ path: dir }), (e: any) => e.code === 'read_timed_out');
  const sha = 'a'.repeat(40);
  const answers = (diff: any, others: any) => (args: string[]) => {
    if (args.includes('--is-inside-work-tree')) return ok('true\n');
    if (args.includes('--verify')) return ok(`${sha}\n`);
    if (args.includes('merge-base')) return ok(`${sha}\n`);
    if (args.includes('--numstat')) return diff;
    if (args.includes('--others')) return others;
    return no;
  };
  const many = Array.from({ length: MAX_STATUS_FILES + 5 }, (_, i) => `1\t1\tf${i}`).join('\0');
  const bigDiff = await scripted(answers(ok(`${many}\0`), ok(''))).status({ path: dir });
  assert.deepEqual([bigDiff.files.length, bigDiff.truncated], [MAX_STATUS_FILES, true]);
  const cutDiff = await scripted(answers({ ...no, stdout: '2\t0\tp\0', cut: true }, ok(''))).status({ path: dir });
  assert.deepEqual([cutDiff.files, cutDiff.truncated], [[{ path: 'p', added: 2, removed: 0 }], true]);
  const bad = await scripted(answers(no, ok(''))).status({ path: dir });
  assert.deepEqual([bad.unreadable, bad.files], [true, []]);
  const manyOthers = Array.from({ length: MAX_STATUS_FILES + 1 }, (_, i) => `u${i}`).join('\0');
  const untrackedFlood = await scripted(answers(ok(''), ok(`${manyOthers}\0`))).status({ path: dir });
  assert.deepEqual([untrackedFlood.files.length, untrackedFlood.truncated], [MAX_STATUS_FILES, true]);
  const cutOthers = await scripted(answers(ok('1\t0\tq\0'), { ...no, stdout: 'u\0', cut: true })).status({ path: dir });
  assert.deepEqual([cutOthers.files.length, cutOthers.truncated], [2, true]);
  // an unreadable diff still names the branch and remote git read; a clean-run listing of untracked files that failed lists none
  const named =
    (diff: any, others: any, branch = ok('feature\n'), remote = ok('https://example.com/o/r.git\n')) =>
    (args: string[]) =>
      args.includes('--short') ? branch : args.includes('get-url') ? remote : answers(diff, others)(args);
  const unreadable = await scripted(named(no, ok(''))).status({ path: dir });
  assert.deepEqual([unreadable.unreadable, unreadable.branch, unreadable.remote], [true, 'feature', 'https://example.com/o/r.git']);
  const emptyBranch = await scripted(named(no, ok(''), ok('\n'))).status({ path: dir });
  assert.equal(emptyBranch.branch, null, 'an empty branch name is none');
  const full = await scripted(named(ok('1\t0\tz\0'), no, ok('\n'))).status({ path: dir });
  assert.deepEqual([full.files, full.branch, full.remote], [[{ path: 'z', added: 1, removed: 0 }], null, 'https://example.com/o/r.git']);
  // a row that is no numstat row is skipped
  const odd = await scripted(answers(ok('junk\0'), ok(''))).status({ path: dir });
  assert.deepEqual(odd.files, []);
});

test('runGit stops a run that prints past maxBytes and reports the signal of one that times out', async () => {
  const dir = repo();
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `file-with-a-long-name-${i}.txt`), 'x');
  const cut: any = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: dir, maxBytes: 100 });
  assert.equal(cut.cut, true);
  assert.equal(cut.ok, false);
  assert.equal(cut.stdout.length, 100);
  const slow: any = await runGit(['-c', 'alias.s=!sleep 5', 's'], { cwd: dir, timeout: 50 });
  assert.equal(slow.ok, false);
  assert.ok(slow.signal, 'killed by the timeout');
  const fine: any = await runGit(['rev-parse', '--git-dir'], { cwd: dir });
  assert.equal(fine.ok, true);
  assert.equal(fine.signal, null, 'no signal for a run that finished');
  const offline = await runGit(['ls-remote', 'file:///no-remote-needed'], { cwd: dir, env: BRANCH_COMPARISON_GIT_ENV });
  assert.match(offline.stderr, /transport 'file' not allowed/);
});

test('over the socket git.status answers a paired client, and without directory wiring the method is unknown', async () => {
  const dir = repo();
  const paths = createPaths({ dataDir: path.join(base, 'sock'), env: {} });
  const hostFs = createHostFs({ roots: [root] });
  const server = await startServer({ paths, dirs: { hostFs, hostGit: {}, hostRead: createHostRead({ hostFs }) } as any });
  try {
    const ok: any = await callHost(paths.socketPath, 'git.status', { path: dir });
    assert.equal(ok.result.isRepo, true);
    assert.equal(((await callHost(paths.socketPath, 'git.status', { path: '/etc' })) as any).code, 'outside_roots');
    assert.match(((await callHost(paths.socketPath, 'git.status', { path: 7 })) as any).error, /folder/i);
  } finally {
    await server.close();
  }
  const bare = createPaths({ dataDir: path.join(base, 'sock2'), env: {} });
  const unwired = await startServer({ paths: bare });
  try {
    assert.match(((await callHost(bare.socketPath, 'git.status', { path: dir })) as any).error, /Unknown method/);
  } finally {
    await unwired.close();
  }
});

test('the summary totals count the lines of untracked files as the patch shows them, and say how many it left uncounted', async () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, 'a.txt'), '3\n');
  fs.writeFileSync(path.join(dir, 'u1.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(dir, 'u2.txt'), 'c\n');
  // the pane's patch and the summary agree: +4 -0 (one edited line, three new lines)
  const patch = await read.diff({ path: dir, scope: 'branch' });
  assert.deepEqual(totals(parseUnifiedDiff(patch.patch)), [4, 0]);
  const summary = repoOf(await read.status({ path: dir }));
  assert.deepEqual([summary.files, summary.added, summary.removed, summary.untracked], [3, 4, 0, 0]);
  // a file too big to read and a binary one stay uncounted, and the summary says so
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x\n'.repeat(200_000));
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
  const more = repoOf(await read.status({ path: dir }));
  assert.deepEqual([more.added, more.untracked], [4, 2]);
});

test('a new file over the size bound is a header-only row: executable mode kept, an odd name quoted (#5277)', async () => {
  const dir = repo();
  const big = 'z\n'.repeat(140_000);
  fs.writeFileSync(path.join(dir, 'run.sh'), big, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'tab\tname.txt'), big);
  const { patch, truncated } = await read.diff({ path: dir, scope: 'uncommitted' });
  assert.equal(truncated, false);
  assert.deepEqual(
    parseUnifiedDiff(patch).map((f) => [f.path, f.tooLarge, f.mode, f.lines.length]),
    [
      ['run.sh', 280_000, '100755', 0],
      ['tab\tname.txt', 280_000, '100644', 0],
    ],
  );
});
