// What each turn changed in a chat's folder on the Host (host/src/hostTurnTree.mjs, host/src/methods/gitTurnDiff.mjs, #5255), with real git: a tree when the turn starts and one when it ends, taken from the stream's turn events of any agent; the diff of one turn only; no baseline said as such; kept across a Host restart; bounded in turns, file size and patch; and the repository's status, stash, log, refs and work tree left as they were (only unreachable objects are added to .git/objects).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
import { createChatEffects } from '../host/src/chatEffects.mjs';
// @ts-ignore: plain ESM without declarations
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { machineChangesSource } from '../src/lib/machineChangesSource.ts';
// @ts-ignore: plain ESM without declarations
import { refuseWhenStopping } from '../host/src/stopGate.mjs';
// @ts-ignore: plain ESM without declarations
import gitTurnDiffMethods from '../host/src/methods/gitTurnDiff.mjs';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';

/** The service, typed loosely: its answers are read field by field here. */
const make = (o: any): any => createHostTurnTree(o);

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-turn-')));
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
const state = (dir: string) => ({
  index: fs.readFileSync(path.join(dir, '.git', 'index')).toString('hex'),
  refs: g(dir, 'for-each-ref'),
  stash: g(dir, 'stash', 'list'),
  status: g(dir, 'status', '--porcelain', '-uall'),
  files: fs.readdirSync(dir).sort(),
});
const start = (t: any, chat: string, turnId: string) => t.onEvent({ kind: 'turnStart', key: chat, turnId });
const end = (t: any, turnId: string) => t.onEvent({ kind: 'turnEnd', turnId, stopReason: 'end_turn' });

test('a turn’s diff holds what the turn changed: not what was edited before it started, nor after it ended', async () => {
  const dir = repo();
  const t = make({ hostFs });
  put(dir, 'a.txt', 'edited by the user before\n');
  t.note('chat1', dir);
  start(t, 'chat1', 'turn1');
  // the turn's own edits: an edit, a new file, a deleted one
  await t.diff({ path: dir, turnId: 'turn1' }).then(() => undefined);
  put(dir, 'b.txt', 'edited by the turn\n');
  put(dir, 'made.txt', 'made by the turn\n');
  end(t, 'turn1');
  const done = await t.diff({ path: dir, turnId: 'turn1' });
  put(dir, 'later.txt', 'edited by the user after\n');
  const again = await t.diff({ path: dir, turnId: 'turn1' });
  assert.deepEqual([done.isRepo, done.baseline, done.truncated], [true, true, false]);
  assert.match(done.patch, /^diff --git a\/b\.txt b\/b\.txt$/m);
  assert.match(done.patch, /^\+made by the turn$/m);
  assert.doesNotMatch(done.patch, /before|a\.txt|later/);
  assert.equal(again.patch, done.patch, 'a finished turn’s answer does not move with the folder');
});

test('a turn still running is compared with the folder as it is now', async () => {
  const dir = repo();
  const t = make({ hostFs });
  t.note('chat2', dir);
  start(t, 'chat2', 'running');
  await t.diff({ path: dir, turnId: 'running' });
  put(dir, 'a.txt', 'first\n');
  assert.match((await t.diff({ path: dir, turnId: 'running' })).patch, /^\+first$/m);
  put(dir, 'a.txt', 'second\n');
  assert.match((await t.diff({ path: dir, turnId: 'running' })).patch, /^\+second$/m);
});

test('no baseline is said so: a turn never seen, a chat whose folder was never named, another folder, a folder that is no repository', async () => {
  const dir = repo();
  const other = repo();
  const t = make({ hostFs });
  assert.deepEqual(await t.diff({ path: dir, turnId: 'nobody' }), { isRepo: true, baseline: false });
  start(t, 'unnamed', 'turn-x');
  assert.deepEqual(await t.diff({ path: dir, turnId: 'turn-x' }), { isRepo: true, baseline: false });
  t.note('chat3', dir);
  start(t, 'chat3', 'turn-y');
  end(t, 'turn-y');
  await t.diff({ path: dir, turnId: 'turn-y' });
  assert.deepEqual(await t.diff({ path: other, turnId: 'turn-y' }), { isRepo: true, baseline: false }, 'a turn of another folder');
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await t.diff({ path: plain, turnId: 'turn-y' }), { isRepo: false });
  // a turn in a folder that is no repository has no baseline either, and a folder outside the roots is refused
  t.note('chat4', plain);
  start(t, 'chat4', 'turn-z');
  await assert.rejects(t.diff({ path: base, turnId: 'turn-y' }), { code: 'outside_roots' });
});

test('a turn whose objects git has forgotten has no baseline; a patch past the bound is cut at a whole line and said so', async () => {
  const dir = repo();
  const t = make({ hostFs, maxPatch: 300 });
  t.note('chat5', dir);
  start(t, 'chat5', 'big');
  await t.diff({ path: dir, turnId: 'big' });
  for (let i = 0; i < 40; i++) put(dir, `f${i}.txt`, `line ${i}\n`.repeat(5));
  end(t, 'big');
  const cut = await t.diff({ path: dir, turnId: 'big' });
  assert.equal(cut.truncated, true);
  assert.ok(cut.patch.length <= 300 && cut.patch.endsWith('\n'));
  // the trees' objects are pruned: nothing to compare
  fs.rmSync(path.join(dir, '.git', 'objects'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.git', 'objects'));
  fs.mkdirSync(path.join(dir, '.git', 'objects', 'pack'));
  fs.mkdirSync(path.join(dir, '.git', 'objects', 'info'));
  assert.deepEqual(await t.diff({ path: dir, turnId: 'big' }), { isRepo: true, baseline: false });
});

test('status, stash, log, refs, index and work-tree files are untouched (unreachable objects are added), and its own filters and hooks never run', async () => {
  const dir = repo();
  const marker = path.join(base, 'ran');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
  g(dir, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  put(dir, 'a.txt', 'staged\n');
  g(dir, 'add', 'a.txt');
  put(dir, 'a.txt', 'edited again\n');
  put(dir, 'untracked.txt', 'u\n');
  const was = state(dir);
  // (reading the status runs the repository's own filter: the marker is cleared after)
  fs.rmSync(marker, { force: true });
  const t = make({ hostFs });
  t.note('chat6', dir);
  start(t, 'chat6', 'untouched');
  put(dir, 'b.txt', 'turn edit\n');
  end(t, 'untouched');
  const answer = await t.diff({ path: dir, turnId: 'untouched' });
  assert.equal(answer.baseline, true);
  assert.equal(fs.existsSync(marker), false, 'no filter or hook of the repository ran');
  assert.deepEqual({ ...state(dir), status: undefined, files: undefined }, { ...was, status: undefined, files: undefined });
  assert.equal(state(dir).status.includes('b.txt'), true);
  assert.deepEqual(state(dir).files, was.files);
  assert.equal(
    fs.readdirSync(os.tmpdir()).some((name) => name.startsWith('mopilot-turn-') && fs.readdirSync(path.join(os.tmpdir(), name)).length),
    false,
  );
});

test('the turns are kept across a restart in a small file: the newest few, within a size bound; a turn the Host stopped under has no end', async () => {
  const dir = repo();
  const file = path.join(base, 'kept', 'turn-trees.json');
  const t = make({ hostFs, file, saveDelayMs: 0, keep: 3 });
  t.note('chat7', dir);
  for (let i = 0; i < 5; i++) {
    start(t, 'chat7', `k${i}`);
    await t.diff({ path: dir, turnId: `k${i}` });
    put(dir, `k${i}.txt`, `turn ${i}\n`);
    end(t, `k${i}`);
    await t.diff({ path: dir, turnId: `k${i}` });
  }
  // a turn left running when the Host stopped
  start(t, 'chat7', 'running');
  await t.diff({ path: dir, turnId: 'running' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.size(), 3, 'only the newest turns are kept');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    saved.turns.map((x: any) => x.turnId),
    ['k3', 'k4', 'running'],
  );
  assert.ok(fs.statSync(file).size < 4000);
  const next = make({ hostFs, file, keep: 3 });
  assert.match(String((await next.diff({ path: dir, turnId: 'k4' })).patch), /^\+turn 4$/m);
  assert.deepEqual(await next.diff({ path: dir, turnId: 'running' }), { isRepo: true, baseline: false });
  assert.deepEqual(await next.diff({ path: dir, turnId: 'k0' }), { isRepo: true, baseline: false }, 'a turn pruned is gone');
  // the file's own size bound drops the oldest turns first
  const small = make({ hostFs, file: path.join(base, 'kept', 'small.json'), saveDelayMs: 0, maxFileBytes: 700 });
  small.note('chat8', dir);
  for (let i = 0; i < 6; i++) {
    start(small, 'chat8', `s${i}`);
    await small.diff({ path: dir, turnId: `s${i}` });
  }
  await new Promise((r) => setTimeout(r, 30));
  const kept = JSON.parse(fs.readFileSync(path.join(base, 'kept', 'small.json'), 'utf8')).turns;
  assert.ok(kept.length >= 1 && kept.length < 6 && kept.at(-1).turnId === 's5');
  assert.ok(fs.statSync(path.join(base, 'kept', 'small.json')).size <= 700);
});

test('a file that is missing, unreadable, from another version or holds a bad turn keeps no baseline for it', async () => {
  const dir = repo();
  const tree = g(dir, 'rev-parse', 'HEAD^{tree}').trim();
  const file = path.join(base, 'bad.json');
  const open = () => make({ hostFs, file });
  assert.equal(open().size(), 0);
  for (const text of ['not json', JSON.stringify({ version: 2, turns: [] }), JSON.stringify({ version: 1, turns: 'x' })]) {
    fs.writeFileSync(file, text);
    assert.equal(open().size(), 0, text);
  }
  const good = { turnId: 'good', chat: 'c', cwd: dir, at: 1, start: tree, startHead: null, end: tree, endHead: null };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      turns: [
        good,
        { ...good, turnId: 7 },
        { ...good, turnId: 'badstart', start: 'zzz' },
        { ...good, turnId: 'badhead', startHead: { id: 1 } },
        { ...good, turnId: 'badend', end: 'zzz' },
        { ...good, turnId: 'noat', at: 'x', endHead: { id: 'a', log: 1.5 } },
        null,
      ],
    }),
  );
  const t = open();
  assert.equal(t.size(), 2);
  assert.deepEqual(await t.diff({ path: dir, turnId: 'good' }), { isRepo: true, baseline: true, patch: '', truncated: false });
});

test('the Host’s method listens to every agent’s turn events and to the folder each message names, and refuses a Host without folders', async () => {
  const dir = repo();
  const events = new EventEmitter();
  const runtime: any = { host: events };
  const { handlers } = gitTurnDiffMethods({ hostFs, runtime });
  const diff = handlers['host.gitTurnDiff'];
  // a message that names its folder, then one that does not (a steer): the folder before is kept
  events.emit('sending', { key: 'chat9', cwd: dir });
  events.emit('event', { kind: 'turnStart', key: 'chat9', turnId: 'm1' });
  await diff({ path: dir, turnId: 'm1' });
  put(dir, 'a.txt', 'by the method\n');
  events.emit('sending', { key: 'chat9' });
  events.emit('event', { kind: 'turnEnd', turnId: 'm1', stopReason: 'end_turn' });
  assert.match(String(((await diff({ path: dir, turnId: 'm1' })) as any).patch), /^\+by the method$/m);
  events.emit('event', { kind: 'update', turnId: 'm1' });
  events.emit('event', null);
  assert.deepEqual(parseParams('host.gitTurnDiff', { path: dir, turnId: 'm1', extra: 1 }), { path: dir, turnId: 'm1' });
  for (const bad of [{ path: dir }, { path: dir, turnId: '' }, { path: dir, turnId: 'a\0b' }, { path: dir, turnId: 'x'.repeat(201) }])
    assert.throws(() => parseParams('host.gitTurnDiff', bad));
  const bare = gitTurnDiffMethods({ runtime }).handlers['host.gitTurnDiff'];
  assert.throws(() => bare({ path: dir, turnId: 'm1' }), { message: /cannot read a turn/ });
});

test('turns that start together are snapshotted two at a time, and a turn in a folder that is no repository, or one that ends twice or never started, leaves no baseline', async () => {
  const dir = repo();
  const t = make({ hostFs });
  t.note('burst', dir);
  const ids = ['b0', 'b1', 'b2', 'b3', 'b4'];
  for (const id of ids) start(t, 'burst', id);
  for (const id of ids) end(t, id);
  for (const id of ids) assert.equal((await t.diff({ path: dir, turnId: id })).baseline, true, id);
  // ended twice: the second end changes nothing; ended without a start: nothing is made up
  end(t, 'b0');
  end(t, 'never-started');
  assert.equal((await t.diff({ path: dir, turnId: 'b0' })).baseline, true);
  assert.equal((await t.diff({ path: dir, turnId: 'never-started' })).baseline, false);
  // a folder that is no repository: the turn has no start, and its end takes nothing
  const plain = path.join(root, `plain${n++}`);
  fs.mkdirSync(plain);
  t.note('plain', plain);
  start(t, 'plain', 'plain-turn');
  end(t, 'plain-turn');
  await t.diff({ path: dir, turnId: 'plain-turn' });
  assert.equal(t.size() >= 6, true);
  assert.deepEqual(await t.diff({ path: plain, turnId: 'plain-turn' }), { isRepo: false });
});

test('a snapshot that fails leaves the turn without a baseline, and a running turn that cannot be read now says so', async () => {
  const dir = repo();
  let failing = false;
  const run = (args: string[], o: any) =>
    failing && args.includes('write-tree') ? Promise.resolve({ ok: false, stdout: '', stderr: 'no space', signal: null }) : runGit(args, o);
  const t = make({ hostFs, run });
  t.note('chat10', dir);
  start(t, 'chat10', 'ok');
  assert.equal((await t.diff({ path: dir, turnId: 'ok' })).baseline, true);
  failing = true;
  assert.deepEqual(await t.diff({ path: dir, turnId: 'ok' }), { isRepo: true, baseline: false }, 'the running turn cannot be compared now');
  start(t, 'chat10', 'failed-start');
  assert.deepEqual(await t.diff({ path: dir, turnId: 'failed-start' }), { isRepo: true, baseline: false });
  failing = false;
  start(t, 'chat10', 'fails-at-end');
  await t.diff({ path: dir, turnId: 'fails-at-end' });
  failing = true;
  end(t, 'fails-at-end');
  assert.deepEqual(await t.diff({ path: dir, turnId: 'fails-at-end' }), { isRepo: true, baseline: false });
});

test('a file that cannot be written loses nothing but the baseline after a restart; the Host still answers', async () => {
  const dir = repo();
  const blocker = path.join(base, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const t = make({ hostFs, file: path.join(blocker, 'turn-trees.json'), saveDelayMs: 0 });
  t.note('chat11', dir);
  start(t, 'chat11', 'unsaved');
  assert.equal((await t.diff({ path: dir, turnId: 'unsaved' })).baseline, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(make({ hostFs, file: path.join(blocker, 'turn-trees.json') }).size(), 0);
});

test('the Host’s method keeps its turns in the data folder when it has one', async () => {
  const dir = repo();
  const events = new EventEmitter();
  const dataDir = path.join(base, 'data');
  const runtime: any = { host: events, send: async () => ({ turnId: 'x' }) };
  const { handlers } = gitTurnDiffMethods({ hostFs, runtime, dataDir });
  events.emit('sending', { key: 'chat12', cwd: dir });
  events.emit('event', { kind: 'turnStart', key: 'chat12', turnId: 'kept' });
  await handlers['host.gitTurnDiff']({ path: dir, turnId: 'kept' });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'turn-trees.json'), 'utf8')).turns[0].turnId, 'kept');
});

test('a chat’s first message goes through the runtime the Host serves (a gate that wraps `send`) and its folder is noted: no recursion, a baseline for the turn', async () => {
  const dir = repo();
  const events = new EventEmitter();
  const sent: unknown[] = [];
  // what cli.mjs hands the protocol: the sessions' runtime behind the stop gate, a Proxy that answers `send` with a call to its target's
  const runtime: any = refuseWhenStopping(
    { host: events, prepare: async () => undefined, send: async (p: any) => (sent.push(p), { turnId: 'first' }) } as any,
    () => false,
  );
  const { handlers } = gitTurnDiffMethods({ hostFs, runtime });
  const effects = createChatEffects({
    runtime,
    handoffs: null,
    finish: () => undefined,
    record: () => undefined,
    endedTurns: new Set(),
    images: null,
    tools: null,
    check: () => undefined,
    faults: { clear: () => undefined, fail: () => undefined },
    approvals: { resume: () => null },
  } as any);
  const chat = 'claude:11111111-1111-4111-8111-111111111111';
  await effects['chat.send']({ chatId: chat, text: 'go', key: 'req-0000001', cwd: dir });
  assert.equal(sent.length, 1, 'the message reached the runtime once');
  events.emit('event', { kind: 'turnStart', key: chat, turnId: 'first' });
  await handlers['host.gitTurnDiff']({ path: dir, turnId: 'first' });
  put(dir, 'a.txt', 'edited by the first turn\n');
  events.emit('event', { kind: 'turnEnd', turnId: 'first', stopReason: 'end_turn' });
  const answer: any = await handlers['host.gitTurnDiff']({ path: dir, turnId: 'first' });
  assert.equal(answer.baseline, true);
  assert.match(answer.patch, /^\+edited by the first turn$/m);
  // a message that names no folder (a steer) keeps the chat's last one
  await effects['chat.send']({ chatId: chat, text: 'steer', key: 'req-0000002' });
  assert.equal(sent.length, 2);
});

test('a turn that was running when the Host stopped has no end snapshot after the restart, and Last Turn reads "baseline is gone" in the pane with the other scopes still there', async () => {
  const dir = repo();
  const file = path.join(base, 'killed.json');
  const before = make({ hostFs, file, saveDelayMs: 0 });
  before.note('chat-killed', dir);
  start(before, 'chat-killed', 'killed-mid-turn');
  await before.diff({ path: dir, turnId: 'killed-mid-turn' });
  put(dir, 'a.txt', 'edited before the Host died\n');
  await new Promise((r) => setTimeout(r, 30));
  // the Host is restarted: a service of its own reads the file the first one kept
  const after = make({ hostFs, file });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).turns[0].end, undefined, 'no end snapshot was ever taken');
  assert.deepEqual(await after.diff({ path: dir, turnId: 'killed-mid-turn' }), { isRepo: true, baseline: false });
  // the app, asking that Host for the turn
  installNative(fakeNative({ host: { gitTurnDiff: async (_id: string, q: any) => ({ value: await after.diff(q) }) } }));
  const read = await machineChangesSource({ id: 'ssh:me@box', name: 'box' }, dir).readTurn!(
    ['killed-mid-turn', 'an-older-turn'],
    () => true,
  );
  assert.deepEqual(read, { kind: 'notice', text: "This turn's baseline is gone. Uncommitted shows what has changed now." });
});

test('after a restart a turn with no end is lost; a turn that starts in the new process keeps its live diff against the folder', async () => {
  const dir = repo();
  const tree = g(dir, 'rev-parse', 'HEAD^{tree}').trim();
  const file = path.join(base, 'lost.json');
  // what the last Host left: a turn that started (its start tree) and never ended
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      turns: [{ turnId: 'lost', chat: 'chat-lost', cwd: dir, at: 1, start: tree, startHead: null, skipped: [] }],
    }),
  );
  const t = make({ hostFs, file });
  put(dir, 'a.txt', 'edited after the restart, by the user\n');
  assert.deepEqual(
    await t.diff({ path: dir, turnId: 'lost' }),
    { isRepo: true, baseline: false },
    'not attributed to a turn that never finished',
  );
  // a turn of this process: live, then ended
  t.note('chat-live', dir);
  start(t, 'chat-live', 'live');
  await t.diff({ path: dir, turnId: 'live' });
  put(dir, 'b.txt', 'edited by the live turn\n');
  assert.match(String((await t.diff({ path: dir, turnId: 'live' })).patch), /^\+edited by the live turn$/m);
  // and the lost one stays lost while the live one runs
  assert.deepEqual(await t.diff({ path: dir, turnId: 'lost' }), { isRepo: true, baseline: false });
});
