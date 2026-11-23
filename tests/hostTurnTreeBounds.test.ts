// The bounds and the failures of what the Host keeps of each turn (host/src/hostTurnTree.mjs, #5255), with real git: which untracked files a snapshot leaves out and how that reads in the diff, the ids a stored file may name, one bound for a patch, a configuration git cannot read, the sweep of old snapshot folders and the file's size in bytes. The repository left alone, the turns' diffs and their persistence are in tests/hostTurnTree.test.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostTurnTree } from '../host/src/hostTurnTree.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostRead, neutralizeFilters } from '../host/src/hostRead.mjs';

/** The service, typed loosely: its answers are read field by field here. */
const make = (o: any): any => createHostTurnTree(o);

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-turn-bounds-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
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
  g(dir, 'init', '-q', '--initial-branch=main');
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(dir, f), `${f}\n`);
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  return dir;
};
const put = (dir: string, f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
const start = (t: any, chat: string, turnId: string) => t.onEvent({ kind: 'turnStart', key: chat, turnId });
const end = (t: any, turnId: string) => t.onEvent({ kind: 'turnEnd', turnId, stopReason: 'end_turn' });

test('untracked files over a size, or past a total, are left out of a snapshot; every other file is in it', async () => {
  const dir = repo();
  const t = make({ hostFs, untracked: { file: 200, total: 400 } });
  t.note('chat13', dir);
  start(t, 'chat13', 'big-untracked');
  await t.diff({ path: dir, turnId: 'big-untracked' });
  put(dir, 'huge.bin', 'x'.repeat(500));
  for (const name of ['s1.txt', 's2 with space.txt', 's3.txt']) put(dir, name, 'y'.repeat(150));
  put(dir, 'a.txt', 'a tracked edit, in whatever size\n'.repeat(40));
  end(t, 'big-untracked');
  const { patch } = await t.diff({ path: dir, turnId: 'big-untracked' });
  assert.doesNotMatch(patch, /huge\.bin/, 'over the file size');
  assert.match(patch, /^diff --git a\/s1\.txt b\/s1\.txt$/m);
  assert.match(patch, /^diff --git a\/s2 with space\.txt b\/s2 with space\.txt$/m);
  assert.doesNotMatch(patch, /s3\.txt/, 'past the total of 400 bytes (two 150-byte files fit)');
  assert.match(patch, /^diff --git a\/a\.txt b\/a\.txt$/m, 'a tracked file is never left out');
});

test('a tampered file of turns cannot name an option as a commit: a head that is no object id drops its turn', async () => {
  const dir = repo();
  const tree = g(dir, 'rev-parse', 'HEAD^{tree}').trim();
  const pwned = path.join(base, 'pwned');
  const file = path.join(base, 'tampered.json');
  const turn = { chat: 'c', cwd: dir, at: 1, start: tree, end: tree, endHead: null };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      turns: [
        { ...turn, turnId: 'evil-start', startHead: { id: `--output=${pwned}`, log: 1 } },
        { ...turn, turnId: 'evil-end', startHead: null, endHead: { id: `--output=${pwned}`, log: 1 } },
        { ...turn, turnId: 'fine', startHead: { id: 'a'.repeat(40), log: 1 } },
      ],
    }),
  );
  const t = make({ hostFs, file });
  assert.equal(t.size(), 2, 'only the turn whose start head is an id stays (the bad end head reads as none)');
  for (const turnId of ['evil-start', 'evil-end', 'fine']) await t.diff({ path: dir, turnId });
  assert.equal(fs.existsSync(pwned), false);
});

test('a patch of more than 200 changed files is cut once, at a file, and said so', async () => {
  const dir = repo();
  for (let i = 0; i < 250; i++) put(dir, `f${String(i).padStart(3, '0')}.txt`, `old ${i}\n`);
  put(dir, 'brought.txt', 'one\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'many');
  g(dir, 'switch', '-qc', 'side');
  put(dir, 'brought.txt', 'two\n');
  g(dir, 'commit', '-qam', 'side');
  g(dir, 'switch', '-q', 'main');
  const t = make({ hostFs, maxPatch: 9000 });
  t.note('chat14', dir);
  start(t, 'chat14', 'many');
  await t.diff({ path: dir, turnId: 'many' });
  for (let i = 0; i < 250; i++) put(dir, `f${String(i).padStart(3, '0')}.txt`, `new ${i}\n`.repeat(20));
  // the agent switches branch: a move of HEAD that brings brought.txt in, so the files are asked for in batches
  g(dir, 'switch', '-q', 'side');
  end(t, 'many');
  const answer = await t.diff({ path: dir, turnId: 'many' });
  assert.equal(answer.baseline, true);
  assert.equal(answer.truncated, true);
  assert.ok(answer.patch.length <= 9000, `${answer.patch.length}`);
  assert.ok(answer.patch.startsWith('diff --git '));
  const files = answer.patch.split(/^diff --git /m).slice(1);
  assert.ok(files.length > 1 && files.length < 250, `${files.length} files`);
  // every file in it is whole: the last one ends with its last line, not in the middle of one
  assert.ok(answer.patch.endsWith('\n'));
  assert.match(files.at(-1)!, /^a\/f\d{3}\.txt b\/f\d{3}\.txt\n(.*\n)*\+new \d+\n$/);
  assert.doesNotMatch(answer.patch, /brought\.txt/);
});

test('a read of the repository’s filter settings that fails stops the snapshot; "no setting" is no failure', async () => {
  const none = await neutralizeFilters(async () => ({ ok: false, stdout: '', code: 1 }));
  assert.deepEqual(none, {});
  await assert.rejects(
    neutralizeFilters(async () => ({ ok: false, stdout: '', code: 128 })),
    { code: 'unavailable', message: /could not read its configuration/ },
  );
  await assert.rejects(neutralizeFilters(async () => ({ ok: false, stdout: '', code: null })));
  const dir = repo();
  const calls: string[][] = [];
  const run = (args: string[], o: any) => {
    calls.push(args);
    return args.includes('config')
      ? Promise.resolve({ ok: false, stdout: '', stderr: 'bad config', code: 128, signal: null })
      : runGit(args, o);
  };
  const t = make({ hostFs, run });
  t.note('chat15', dir);
  start(t, 'chat15', 'closed');
  assert.deepEqual(await t.diff({ path: dir, turnId: 'closed' }), { isRepo: true, baseline: false });
  assert.equal(
    calls.some((a) => a.includes('add') || a.includes('write-tree')),
    false,
    'nothing was added to any index',
  );
});

test('a Host start takes away the snapshot folders a dead Host left, and only the old ones', async () => {
  const tmp = path.join(base, 'tmp-sweep');
  fs.mkdirSync(tmp);
  for (const name of ['mopilot-turn-old', 'mopilot-turn-new', 'other-old']) fs.mkdirSync(path.join(tmp, name));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ['mopilot-turn-old', 'other-old']) fs.utimesSync(path.join(tmp, name), old, old);
  make({ hostFs, tmpdir: () => tmp });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['mopilot-turn-new', 'other-old']);
  // a folder that is not there is nothing to sweep
  make({ hostFs, tmpdir: () => path.join(base, 'no-such-folder') });
});

test('the file’s size bound is in bytes, and a file past it is not read', async () => {
  const dir = repo();
  const file = path.join(base, 'bytes.json');
  const t = make({ hostFs, file, saveDelayMs: 0, maxFileBytes: 1800 });
  // a chat id of 3-byte characters: few characters, many bytes
  const chat = '€'.repeat(150);
  t.note(chat, dir);
  for (let i = 0; i < 5; i++) {
    start(t, chat, `e${i}`);
    await t.diff({ path: dir, turnId: `e${i}` });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(fs.statSync(file).size <= 1800, `${fs.statSync(file).size} bytes`);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).turns.length < 5);
  // a file bigger than the bound was not written by this Host
  const big = path.join(base, 'bigfile.json');
  fs.writeFileSync(big, JSON.stringify({ version: 1, turns: [], pad: 'x'.repeat(2000) }));
  assert.equal(make({ hostFs, file: big, maxFileBytes: 1800 }).size(), 0);
  fs.writeFileSync(big, JSON.stringify({ version: 1, turns: [{ turnId: 'a', chat: 'c', cwd: dir, at: 1, start: null, startHead: null }] }));
  assert.equal(make({ hostFs, file: big, maxFileBytes: 1800 }).size(), 1);
});

test('a file left out of the snapshot on either side is out of the diff on both: grown past the limit, shrunk under it, or too big all along', async () => {
  const dir = repo();
  const limits = { file: 200, total: 100_000 };
  const turn = async (id: string, before: number | null, after: number | null) => {
    const t = make({ hostFs, untracked: limits });
    t.note(`chat-${id}`, dir);
    if (before !== null) put(dir, 'grows.txt', 'x'.repeat(before));
    start(t, `chat-${id}`, id);
    await t.diff({ path: dir, turnId: id });
    if (after === null) fs.rmSync(path.join(dir, 'grows.txt'), { force: true });
    else put(dir, 'grows.txt', 'y'.repeat(after));
    put(dir, `other-${id}.txt`, 'other\n');
    end(t, id);
    const answer = await t.diff({ path: dir, turnId: id });
    fs.rmSync(path.join(dir, 'grows.txt'), { force: true });
    return answer;
  };
  // 100 bytes at the start, 300 at the end: not a deletion
  const grew = await turn('grew', 100, 300);
  assert.doesNotMatch(grew.patch, /grows\.txt/);
  assert.match(grew.patch, /^diff --git a\/other-grew\.txt/m);
  assert.deepEqual(grew.skipped, { count: 1, paths: ['grows.txt'] });
  // 300 at the start, 100 at the end: not a whole new file
  const shrank = await turn('shrank', 300, 100);
  assert.doesNotMatch(shrank.patch, /grows\.txt/);
  assert.deepEqual(shrank.skipped, { count: 1, paths: ['grows.txt'] });
  // too big on both sides: absent, and said
  const big = await turn('big', 300, 400);
  assert.doesNotMatch(big.patch, /grows\.txt/);
  assert.equal(big.skipped.count, 1);
  // small on both sides: shown, nothing said
  const small = await turn('small', 50, 60);
  assert.match(small.patch, /^diff --git a\/grows\.txt b\/grows\.txt/m);
  assert.equal(small.skipped, undefined);
});

test('the files left out are remembered with the turn: a restart keeps the notice and the exclusion', async () => {
  const dir = repo();
  const file = path.join(base, 'skipped.json');
  const t = make({ hostFs, file, saveDelayMs: 0, untracked: { file: 200, total: 100_000 } });
  t.note('chat-keep', dir);
  start(t, 'chat-keep', 'kept-skip');
  await t.diff({ path: dir, turnId: 'kept-skip' });
  put(dir, 'huge.bin', 'x'.repeat(300));
  put(dir, 'small.txt', 's\n');
  end(t, 'kept-skip');
  await t.diff({ path: dir, turnId: 'kept-skip' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).turns[0].endSkipped.map((x: any) => x.name),
    ['huge.bin'],
  );
  const next = make({ hostFs, file });
  const answer = await next.diff({ path: dir, turnId: 'kept-skip' });
  assert.deepEqual(answer.skipped, { count: 1, paths: ['huge.bin'] });
  assert.match(answer.patch, /small\.txt/);
  // a stored list that is no list of names is no list
  const odd = JSON.parse(fs.readFileSync(file, 'utf8'));
  odd.turns[0].skipped = [{ name: 'a'.repeat(5000), sig: '1:1' }];
  odd.turns[0].endSkipped = 'huge.bin';
  fs.writeFileSync(file, JSON.stringify(odd));
  assert.equal((await make({ hostFs, file }).diff({ path: dir, turnId: 'kept-skip' })).skipped, undefined);
});

test('the total budget takes the smallest files first, whatever order git lists them in', async () => {
  const dir = repo();
  const t = make({ hostFs, untracked: { file: 1000, total: 450 } });
  t.note('chat-budget', dir);
  start(t, 'chat-budget', 'budget');
  await t.diff({ path: dir, turnId: 'budget' });
  // a 300-byte file that git lists first, then two of 100: the two small ones are kept, whichever name sorts first
  put(dir, 'a-big.txt', 'x'.repeat(300));
  put(dir, 'b-small.txt', 'y'.repeat(100));
  put(dir, 'c-small.txt', 'z'.repeat(100));
  end(t, 'budget');
  const answer = await t.diff({ path: dir, turnId: 'budget' });
  assert.doesNotMatch(answer.patch, /a-big/);
  assert.match(answer.patch, /b-small/);
  assert.match(answer.patch, /c-small/);
  assert.deepEqual(answer.skipped, { count: 1, paths: ['a-big.txt'] });
});

test('where git itself cut the diff, the patch ends with the last whole file; a first file alone past the bound is cut at a line', async () => {
  const dir = repo();
  const t = make({ hostFs, maxPatch: 3000 });
  t.note('chat-cut', dir);
  start(t, 'chat-cut', 'cut');
  await t.diff({ path: dir, turnId: 'cut' });
  for (let i = 0; i < 30; i++) put(dir, `c${String(i).padStart(2, '0')}.txt`, `line ${i}\n`.repeat(12));
  end(t, 'cut');
  const bounded = await t.diff({ path: dir, turnId: 'cut' });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.patch.length <= 3000 && bounded.patch.endsWith('\n'));
  const files = bounded.patch.split(/^diff --git /m).slice(1);
  assert.ok(files.length > 1);
  for (const f of files) assert.equal((f.match(/^\+line /gm) ?? []).length, 12, 'every file in it is whole');
  // one file alone past the bound
  const one = make({ hostFs, maxPatch: 100 });
  one.note('chat-one', dir);
  start(one, 'chat-one', 'one');
  await one.diff({ path: dir, turnId: 'one' });
  put(dir, 'only.txt', 'a long line of text\n'.repeat(20));
  end(one, 'one');
  const cutLine = await one.diff({ path: dir, turnId: 'one' });
  assert.equal(cutLine.truncated, true);
  assert.ok(cutLine.patch.length <= 100 && cutLine.patch.endsWith('\n') && cutLine.patch.startsWith('diff --git '));
});

test('a snapshot folder that cannot be removed does not end the sweep', async () => {
  const tmp = path.join(base, 'tmp-sweep-eperm');
  fs.mkdirSync(tmp);
  for (const name of ['mopilot-turn-a', 'mopilot-turn-b']) fs.mkdirSync(path.join(tmp, name));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ['mopilot-turn-a', 'mopilot-turn-b']) fs.utimesSync(path.join(tmp, name), old, old);
  const refusing = {
    ...fs.promises,
    rm: (target: string, o: any) =>
      target.endsWith('mopilot-turn-a')
        ? Promise.reject(Object.assign(new Error('not yours'), { code: 'EPERM' }))
        : fs.promises.rm(target, o),
  };
  make({ hostFs, tmpdir: () => tmp, fsp: refusing });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(tmp), ['mopilot-turn-a']);
});

test('a configuration git cannot read (exit 128) is a refusal in words on a read of the diff', async () => {
  const dir = repo();
  const read = createHostRead({
    hostFs,
    run: ((args: string[]) =>
      Promise.resolve(
        args.includes('config')
          ? { ok: false, stdout: '', stderr: 'fatal: bad config line 1 in file ~/.gitconfig', code: 128, signal: null }
          : { ok: true, stdout: 'true\n', stderr: '' },
      )) as any,
  });
  await assert.rejects(read.diff({ path: dir, scope: 'uncommitted' }), {
    code: 'unavailable',
    message: 'Git on this machine could not read its configuration. Check its ~/.gitconfig and the repository’s .git/config.',
  });
});

test('a big file that was there all along is out of the diff and not mentioned; one the turn changed is counted', async () => {
  const dir = repo();
  put(dir, 'cache.db', 'd'.repeat(300));
  const limits = { file: 200, total: 100_000 };
  const t = make({ hostFs, untracked: limits });
  t.note('chat-db', dir);
  // a turn that only answered: nothing changed, the file is not news
  start(t, 'chat-db', 'answer-only');
  await t.diff({ path: dir, turnId: 'answer-only' });
  end(t, 'answer-only');
  const quiet = await t.diff({ path: dir, turnId: 'answer-only' });
  assert.deepEqual([quiet.baseline, quiet.patch, quiet.skipped], [true, '', undefined]);
  // a turn that edits a file: that file, and still nothing said of the database
  start(t, 'chat-db', 'edits');
  await t.diff({ path: dir, turnId: 'edits' });
  put(dir, 'a.txt', 'edited\n');
  end(t, 'edits');
  const edits = await t.diff({ path: dir, turnId: 'edits' });
  assert.match(edits.patch, /^diff --git a\/a\.txt/m);
  assert.doesNotMatch(edits.patch, /cache\.db/);
  assert.equal(edits.skipped, undefined);
  // a turn that rewrites it: said (the file's size or time is not the same at both ends)
  start(t, 'chat-db', 'rewrites');
  await t.diff({ path: dir, turnId: 'rewrites' });
  put(dir, 'cache.db', 'e'.repeat(350));
  end(t, 'rewrites');
  const rewrote = await t.diff({ path: dir, turnId: 'rewrites' });
  assert.deepEqual(rewrote.skipped, { count: 1, paths: ['cache.db'] });
  // one that same-size rewrite is told by its time
  start(t, 'chat-db', 'touches');
  await t.diff({ path: dir, turnId: 'touches' });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'cache.db'), later, later);
  end(t, 'touches');
  assert.equal((await t.diff({ path: dir, turnId: 'touches' })).skipped?.count, 1);
});

test('the names of the files left out are kept within a byte bound, and a stored list past it is not read', async () => {
  const dir = repo();
  const file = path.join(base, 'names.json');
  const t = make({ hostFs, file, saveDelayMs: 0, untracked: { file: 1, total: 1_000_000 } });
  t.note('chat-names', dir);
  start(t, 'chat-names', 'names');
  await t.diff({ path: dir, turnId: 'names' });
  for (let i = 0; i < 170; i++) put(dir, `${String(i).padStart(3, '0')}${'n'.repeat(247)}`, 'long name, two bytes\n');
  end(t, 'names');
  await t.diff({ path: dir, turnId: 'names' });
  await new Promise((r) => setTimeout(r, 30));
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).turns[0].endSkipped;
  assert.ok(kept.length > 0 && kept.length < 170, `${kept.length} names`);
  assert.ok(kept.reduce((bytes: number, x: any) => bytes + Buffer.byteLength(x.name), 0) <= 40_000);
  // a stored list whose names together pass the bound, or are one too long, is no list
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.turns[0].endSkipped = Array.from({ length: 50 }, (_, i) => ({ name: `${i}${'x'.repeat(1000)}`.slice(0, 1000), sig: '1:1' }));
  tampered.turns[0].skipped = [{ name: 'y'.repeat(2000), sig: '1:1' }];
  fs.writeFileSync(file, JSON.stringify(tampered));
  const reload = make({ hostFs, file });
  assert.equal(reload.size(), 1);
  assert.equal((await reload.diff({ path: dir, turnId: 'names' })).skipped, undefined);
});
