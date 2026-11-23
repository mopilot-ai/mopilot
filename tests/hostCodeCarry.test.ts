// Carrying uncommitted changes to the target Host (shared/host/codeCarry.mjs, host/src/hostGit.mjs carry methods, electron/host/codeTransfer.cjs carryChanges; package 3.5 "later"), over real git and a bare remote: the source is never touched, the target gets the changes uncommitted or stays as it was, and the temporary branch goes away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
import {
  base,
  run,
  roots,
  hostFs,
  host,
  key,
  refusal,
  branches,
  SHA_A,
  SHA_B,
  SHA_C,
  applyBase,
  req,
  code,
  dirtySource,
  where,
  script,
  app,
  world,
  ids,
  HostRefusal,
  createHostGit,
} from './support/carryKit.ts';
const require = createRequire(import.meta.url);
const C = require('../shared/host/codeCarry.mjs');
const T = require('../shared/host/codeTransfer.mjs');
const S = require('../shared/host/schema.mjs');

test('the source keeps its branch, index and files; the target gets the changes uncommitted, untracked files included', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'one changed\n');
  fs.writeFileSync(path.join(w.source, 'new.txt'), 'brand new\n');
  run(w.source, 'add', 'b.txt'); // a staged no-op, to prove the real index is untouched
  fs.writeFileSync(path.join(w.source, 'b.txt'), 'two staged\n');
  run(w.source, 'add', 'b.txt');
  const before = {
    head: run(w.source, 'rev-parse', 'HEAD'),
    status: run(w.source, 'status', '--porcelain=v1'),
    index: run(w.source, 'diff', '--cached'),
  };
  const k = key('ok');
  const pushed = await host.carryPush({ key: k, path: w.source, untracked: ['new.txt'] });
  assert.deepEqual([pushed.sourceBranch, pushed.parent, pushed.files, pushed.skipped], ['main', before.head, 3, []]);
  assert.match(pushed.branch, /^mopilot\/carry\/carry-ok-/);
  assert.deepEqual(branches(w.remote), [pushed.branch]);
  assert.deepEqual(
    {
      head: run(w.source, 'rev-parse', 'HEAD'),
      status: run(w.source, 'status', '--porcelain=v1'),
      index: run(w.source, 'diff', '--cached'),
    },
    before,
  );
  assert.equal(fs.readdirSync(path.join(w.source, '.git')).filter((f) => f.includes('carry')).length, 0);
  const applied = await host.carryApply({ key: k, path: w.target, ...pushed });
  assert.equal(applied.files, 3);
  assert.equal(fs.readFileSync(path.join(w.target, 'a.txt'), 'utf8'), 'one changed\n');
  assert.equal(fs.readFileSync(path.join(w.target, 'new.txt'), 'utf8'), 'brand new\n');
  assert.equal(run(w.target, 'rev-parse', 'HEAD'), before.head);
  assert.equal(run(w.target, 'diff', '--cached'), '');
  assert.deepEqual(await host.carryDrop({ path: w.source, branch: pushed.branch }), { dropped: true });
  assert.deepEqual(branches(w.remote), []);
});

test('W: the same key twice shares one push and one apply', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'x\n');
  const k = key('twice');
  const [a, b] = await Promise.all([host.carryPush({ key: k, path: w.source }), host.carryPush({ key: k, path: w.source })]);
  assert.deepEqual(a, b);
  const first = await host.carryApply({ key: k, path: w.target, ...a });
  assert.deepEqual(await host.carryApply({ key: k, path: w.target, ...a }), first);
});

test('a target behind the source catches up to its commit first; one ahead or diverged is refused and untouched', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'c.txt'), 'three\n');
  run(w.source, 'add', '.');
  run(w.source, 'commit', '-qm', 'two');
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'edited\n');
  const pushed = await host.carryPush({ key: key('behind'), path: w.source, unpushed: 1 });
  const applied = await host.carryApply({ key: key('behind'), path: w.target, ...pushed });
  assert.equal(applied.files, 1);
  assert.equal(run(w.target, 'rev-parse', 'HEAD'), pushed.parent);
  // a target with a commit of its own is not on the source's line
  const d = world();
  fs.writeFileSync(path.join(d.target, 'own.txt'), 'x\n');
  run(d.target, 'add', '.');
  run(d.target, 'commit', '-qm', 'own');
  const ownHead = run(d.target, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(d.source, 'a.txt'), 'edited\n');
  const p2 = await host.carryPush({ key: key('div'), path: d.source });
  await refusal(host.carryApply({ key: key('div'), path: d.target, ...p2 }), C.CARRY_CODES.diverged);
  assert.equal(run(d.target, 'rev-parse', 'HEAD'), ownHead);
  assert.equal(run(d.target, 'status', '--porcelain=v1'), '');
});

test('B2: a push the remote refuses is a coded refusal with no address in it, and nothing is left in the source', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'x\n');
  run(w.source, 'remote', 'set-url', 'origin', path.join(base, 'no-such-remote.git'));
  await refusal(host.carryPush({ key: key('nopush'), path: w.source }), C.CARRY_CODES.pushFailed);
  assert.equal(fs.readdirSync(path.join(w.source, '.git')).filter((f) => f.includes('carry')).length, 0);
  assert.equal(run(w.source, 'status', '--porcelain=v1'), 'M a.txt');
});

test('a clean source, an unborn one and a folder that is not a repository have nothing to carry', async () => {
  const w = world();
  await refusal(host.carryPush({ key: key('clean'), path: w.source }), C.CARRY_CODES.noChanges);
  const unborn = path.join(roots, `unborn${ids.n}`);
  fs.mkdirSync(unborn);
  await refusal(host.carryPush({ key: key('plain'), path: unborn }), C.CARRY_CODES.nothingToCarry);
  run(unborn, 'init', '-q');
  fs.writeFileSync(path.join(unborn, 'f'), 'x');
  await refusal(host.carryPush({ key: key('unb'), path: unborn }), C.CARRY_CODES.nothingToCarry);
  // the target side is bound to the roots, the source side is not; both need a real folder
  await assert.rejects(
    host.carryApply({ key: key('out'), path: base, branch: 'mopilot/carry/abcdefgh', commit: 'a'.repeat(40), parent: 'b'.repeat(40) }),
    (e: any) => e.code === 'outside_roots',
  );
  await assert.rejects(host.carryPush({ key: key('gone'), path: path.join(base, 'gone') }), (e: any) => e.code === 'directory_missing');
  run(w.source, 'remote', 'set-url', 'origin', path.join(base, 'no-such-remote.git'));
  assert.deepEqual(await host.carryDrop({ path: w.source, branch: 'mopilot/carry/never-pushed' }), { dropped: false });
});

test('the target is refused before anything changes: not a repository, dirty, another branch', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'x\n');
  const p = await host.carryPush({ key: key('refuse'), path: w.source });
  const plain = path.join(roots, `plain${ids.n}`);
  fs.mkdirSync(plain);
  await refusal(host.carryApply({ key: key('r1'), path: plain, ...p }), C.CARRY_CODES.noRepository);
  fs.writeFileSync(path.join(w.target, 'mine.txt'), 'x');
  await refusal(host.carryApply({ key: key('r2'), path: w.target, ...p }), C.CARRY_CODES.targetDirty);
  fs.rmSync(path.join(w.target, 'mine.txt'));
  run(w.target, 'checkout', '-q', '-b', 'other');
  await refusal(host.carryApply({ key: key('r3'), path: w.target, ...p }), C.CARRY_CODES.otherBranch);
  assert.equal(run(w.target, 'status', '--porcelain=v1'), '');
});

// ---- the pure module with a scripted git, for the paths real git cannot be made to take ----
test('applyCarry: a fetch that fails, a commit that is not the one sent, and changes that do not apply', async () => {
  await code(
    C.applyCarry(script({ ...applyBase, fetch: { ok: false, stderr: 'fatal: https://tok@host/x.git: no\n' } }).run, req),
    C.CARRY_CODES.fetchFailed,
  );
  const leak = await C.applyCarry(
    script({ ...applyBase, fetch: { ok: false, stderr: 'fatal: unable to access https://user:tok@host/x.git' } }).run,
    req,
  ).catch((e: Error) => e.message);
  assert.ok(!/tok/.test(leak), leak);
  const silent = await C.applyCarry(script({ ...applyBase, fetch: { ok: false } }).run, req).catch((e: Error) => e.message);
  assert.match(silent, /the fetch failed/);
  await code(
    C.applyCarry(script({ ...applyBase, 'rev-parse --verify -q FETCH_HEAD': { ok: true, stdout: SHA_B } }).run, req),
    C.CARRY_CODES.mismatch,
  );
  await code(
    C.applyCarry(script({ ...applyBase, [`rev-parse --verify -q ${SHA_C}^`]: { ok: true, stdout: SHA_B } }).run, req),
    C.CARRY_CODES.mismatch,
  );
  const conflict = script({ ...applyBase, 'cherry-pick': { ok: false, stderr: 'CONFLICT' } });
  await code(C.applyCarry(conflict.run, req), C.CARRY_CODES.conflict);
  assert.deepEqual(conflict.calls.at(-1), ['reset', '--quiet', '--hard', SHA_A]);
});

test('applyCarry: catching up that fails, and a target that is ahead, are diverged; a target that catches up resets back on a conflict', async () => {
  const behind = { ...applyBase, 'rev-parse --verify -q HEAD': { ok: true, stdout: SHA_B }, 'merge-base': { ok: true } };
  await code(C.applyCarry(script({ ...behind, merge: { ok: false } }).run, req), C.CARRY_CODES.diverged);
  await code(C.applyCarry(script({ ...behind, 'merge-base': { ok: false } }).run, req), C.CARRY_CODES.diverged);
  const unborn = { ...applyBase, 'rev-parse --verify -q HEAD': { ok: false } };
  await code(C.applyCarry(script(unborn).run, req), C.CARRY_CODES.diverged);
  const back = script({ ...behind, 'cherry-pick': { ok: false } });
  await code(C.applyCarry(back.run, req), C.CARRY_CODES.conflict);
  assert.deepEqual(back.calls.at(-1), ['reset', '--quiet', '--hard', SHA_B]);
  const ok = script({ ...behind, 'status --porcelain=v1': (a) => ({ ok: true, stdout: a.length ? '' : '' }) });
  assert.deepEqual(await C.applyCarry(ok.run, req), { files: 0 });
});

test('pushCarry: each step that fails is a refusal that names the step, and the temporary index is always removed', async () => {
  const repo = {
    'rev-parse --is-inside-work-tree': { ok: true, stdout: 'true' },
    'symbolic-ref --short -q HEAD': { ok: true, stdout: 'main' },
    'rev-parse --verify -q HEAD': { ok: true, stdout: SHA_A },
    'remote get-url origin': { ok: true, stdout: 'https://github.com/a/b' },
    status: { ok: true, stdout: ' M a\0' },
    'rev-parse --absolute-git-dir': { ok: true, stdout: '/r/.git\n' },
    'write-tree': { ok: true, stdout: 'tree1\n' },
    'commit-tree': { ok: true, stdout: `${SHA_C}\n` },
  };
  const removed: string[] = [];
  const o = {
    key: 'carry-key-0001',
    untracked: [],
    tmpIndex: (d: string) => `${d}/ix`,
    removeIndex: async (f: string) => void removed.push(f),
  };
  const good = await C.pushCarry(script(repo).run, o);
  assert.deepEqual(good, {
    branch: 'mopilot/carry/carry-key-0001',
    commit: SHA_C,
    parent: SHA_A,
    sourceBranch: 'main',
    files: 1,
    skipped: [],
  });
  assert.deepEqual(removed, ['/r/.git/ix']);
  assert.equal(C.carryBranch('a:b c'), 'mopilot/carry/a-b-c');
  for (const [name, patch, c] of [
    ['git dir', { 'rev-parse --absolute-git-dir': { ok: false } }, C.CARRY_CODES.nothingToCarry],
    ['read-tree', { 'read-tree': { ok: false, stderr: 'no' } }, C.CARRY_CODES.nothingToCarry],
    ['add', { add: { ok: false } }, C.CARRY_CODES.nothingToCarry],
    ['write-tree', { 'write-tree': { ok: false } }, C.CARRY_CODES.nothingToCarry],
    ['commit-tree', { 'commit-tree': { ok: true, stdout: 'garbage' } }, C.CARRY_CODES.nothingToCarry],
    ['push', { push: { ok: false, stderr: 'remote: denied to https://u:secret@h/x' } }, C.CARRY_CODES.pushFailed],
  ] as const) {
    removed.length = 0;
    const err = await C.pushCarry(script({ ...repo, ...patch }).run, o).catch((e: any) => e);
    assert.equal(err.code, c, name);
    assert.ok(!/secret/.test(err.message), name);
    assert.equal(removed.length, name === 'git dir' ? 0 : 1, name);
  }
  assert.match(await C.pushCarry(script({ ...repo, push: { ok: false } }).run, o).catch((e: Error) => e.message), /the push failed/);
  assert.match(await C.pushCarry(script({ ...repo, 'commit-tree': { ok: false } }).run, o).catch((e: Error) => e.message), /git failed/);
});

test('I1: the parsers take only a carry branch and full commit ids, and reject anything that could name another ref', () => {
  const ok = { key: 'key-12345678', path: '/p', branch: 'mopilot/carry/abcdefgh', commit: SHA_C, parent: SHA_A };
  assert.deepEqual(S.parseParams('git.carryApply', ok), { ...ok, sourceBranch: null });
  assert.equal(S.parseParams('git.carryApply', { ...ok, sourceBranch: 'feat/x' }).sourceBranch, 'feat/x');
  assert.deepEqual(S.parseParams('git.carryPush', { key: ok.key, path: '/p', extra: 1 }), {
    key: ok.key,
    path: '/p',
    untracked: [],
    unpushed: 0,
  });
  assert.deepEqual(S.parseParams('git.carryPush', { key: ok.key, path: '/p', untracked: ['n.txt'] }).untracked, ['n.txt']);
  for (const untracked of ['n.txt', [5], [''], Array.from({ length: 2001 }, () => 'f')])
    assert.throws(
      () => S.parseParams('git.carryPush', { key: ok.key, path: '/p', untracked }),
      (e: any) => e.code === 'invalid',
    );
  assert.deepEqual(S.parseParams('git.carryPlan', { path: '/p', x: 1 }), { path: '/p' });
  assert.deepEqual(S.parseParams('git.carryDrop', { path: '/p', branch: ok.branch }), { path: '/p', branch: ok.branch });
  const bad = (p: object) =>
    assert.throws(
      () => S.parseParams('git.carryApply', { ...ok, ...p }),
      (e: any) => e.code === 'invalid',
    );
  for (const branch of [
    'main',
    'mopilot/carry/',
    'mopilot/carry/a..b..c..d',
    'mopilot/carry/short',
    'mopilot/carry/abcdefgh.',
    'mopilot/carry/abcdefgh.lock',
    'mopilot/carry/abc defgh',
    'refs/heads/mopilot/carry/abcdefgh',
    5,
  ])
    bad({ branch });
  for (const commit of ['HEAD', 'abc', SHA_C.toUpperCase(), 5, '-x']) bad({ commit });
  bad({ parent: 'main' });
  bad({ sourceBranch: '-x' });
  assert.throws(
    () => S.parseParams('git.carryDrop', { path: '/p', branch: 'main' }),
    (e: any) => e.code === 'invalid',
  );
  assert.throws(() => S.requireFeatures('git.carryPush', { features: [] }), /dedupe/);
  assert.throws(() => S.requireFeatures('git.carryApply', { features: [] }), /dedupe/);
});

test('codeLines: carried changes are said to be carried, and replace the not-carried line', () => {
  const src = { isRepo: true, remote: 'https://github.com/a/b', branch: 'main', head: SHA_A, dirty: 2 };
  const lines = T.codeLines({ source: src, target: { ...src, dirty: 0 }, carried: 2 });
  assert.ok(lines.includes('2 uncommitted files from the previous host were carried over and are uncommitted here.'));
  assert.ok(!lines.some((l: string) => /not carried over/.test(l)));
  assert.match(T.codeLines({ source: src, carried: 1 }).join('\n'), /1 uncommitted file from the previous host/);
});

test('carryChanges: push on the source, apply on the target, then drop the temporary branch', async () => {
  const a = app();
  assert.deepEqual(await a.t.carryChanges({ source: dirtySource, ...where }), { carried: 2, skipped: ['.env'] });
  assert.deepEqual(a.calls, ['push:A:/w:key-minted-01:', `apply:B:/t:mopilot/carry/k:${SHA_C}`, 'drop:A:/w:mopilot/carry/k']);
});

test('M3: the number of unpushed commits the user agreed to is passed to the push; none unless said', async () => {
  const a = app();
  await a.t.carryChanges({ source: dirtySource, ...where });
  await a.t.carryChanges({ source: dirtySource, ...where, unpushed: 2 });
  assert.deepEqual(
    a.pushes.map((p) => p.unpushed),
    [0, 2],
  );
});

test('carryChanges: a source with nothing uncommitted (or unreadable) calls nothing; changes gone by now are zero, not a failure', async () => {
  const a = app();
  for (const source of [null, { isRepo: false }, { ...dirtySource, dirty: 0 }])
    assert.deepEqual(await a.t.carryChanges({ source, ...where }), { carried: 0, skipped: [] });
  assert.deepEqual(a.calls, []);
  const gone = app({ push: () => Promise.reject(Object.assign(new Error('none'), { code: 'no_changes' })) });
  assert.deepEqual(await gone.t.carryChanges({ source: dirtySource, ...where, key: 'key-given-001' }), { carried: 0, skipped: [] });
  assert.deepEqual(gone.calls, ['push:A:/w:key-given-001:']);
});

test("B2: a refused push or apply is the caller's to show; the temporary branch is dropped after a refused apply, and a drop that fails is only reported", async () => {
  const noPush = app({ push: () => Promise.reject(Object.assign(new Error('denied'), { code: 'carry_push_failed' })) });
  await assert.rejects(noPush.t.carryChanges({ source: dirtySource, ...where }), (e: any) => e.code === 'carry_push_failed');
  assert.deepEqual(noPush.calls.length, 1);
  const noApply = app({
    apply: () => Promise.reject(Object.assign(new Error('dirty'), { code: 'target_dirty' })),
    drop: () => Promise.reject(new Error('offline')),
  });
  await assert.rejects(noApply.t.carryChanges({ source: dirtySource, ...where }), (e: any) => e.code === 'target_dirty');
  assert.ok(noApply.calls.some((c) => c.startsWith('drop:')));
  assert.match(noApply.reports[0], /mopilot\/carry\/k was not removed: offline/);
});

test('a failure that is not a refusal passes through unchanged, so the wire reports it as an error', async () => {
  const w = world();
  const boom = createHostGit({
    hostFs,
    run: async () => {
      throw new Error('git is gone');
    },
  });
  await assert.rejects(
    boom.carryPush({ key: key('boom'), path: w.source }),
    (e: any) => !(e instanceof HostRefusal) && /git is gone/.test(e.message),
  );
});

test('over the Host socket: push, apply and drop succeed for a real folder and answer what they did', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'over the wire\n');
  const paths = createPaths({ dataDir: path.join(base, `d${ids.n++}`), env: {} });
  const server = await startServer({ paths, runtime: { send: async () => ({ ok: true }) } as any, dirs: { hostFs, hostGit: host } });
  try {
    const ask = (method: string, params: object) => callHost(paths.socketPath, method, params) as Promise<any>;
    const pushed = (await ask('git.carryPush', { key: 'key-wire-0001', path: w.source })).result;
    assert.equal(pushed.files, 1);
    const { branch, commit, parent, sourceBranch } = pushed;
    assert.equal(
      (await ask('git.carryApply', { key: 'key-wire-0001', path: w.target, branch, commit, parent, sourceBranch })).result.files,
      1,
    );
    assert.deepEqual((await ask('git.carryDrop', { path: w.source, branch })).result, { dropped: true });
  } finally {
    await server.close();
  }
});

/** git in `cwd` as a carry's runner, calling `after` with the arguments of each command once it ran. */
const gitIn =
  (cwd: string, after: (args: string[]) => void = () => undefined) =>
  async (args: string[], o: { env?: Record<string, string> } = {}) => {
    try {
      const stdout = execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...o.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout, stderr: '' };
    } catch (e: any) {
      return { ok: false, stdout: '', stderr: String(e.stderr ?? e) };
    } finally {
      after(args);
    }
  };
const carryOpts = (k: string) => ({
  key: k,
  untracked: [] as string[],
  tmpIndex: (d: string) => `${d}/carry-ix`,
  removeIndex: async (f: string) => void fs.rmSync(f, { force: true }),
});

test('M3: commits origin lacks are published with the changes only when the user was told how many', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'c.txt'), 'local only\n');
  run(w.source, 'add', '.');
  run(w.source, 'commit', '-qm', 'not pushed yet');
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'edited\n');
  // the plan says how many, and where: the address of origin without any credentials
  run(w.source, 'remote', 'set-url', '--push', 'origin', 'https://user:tok3n@example.com/r.git');
  const plan = await C.planCarry(gitIn(w.source));
  assert.deepEqual([plan.unpushed, plan.remote, plan.files], [1, 'https://example.com/r.git', 1]);
  assert.deepEqual(plan.changed, ['a.txt'], 'the modified file is named, not only new ones');
  run(w.source, 'remote', 'set-url', '--push', 'origin', w.remote);
  // not told, or told of fewer: refused before anything is pushed
  for (const told of [undefined, 0]) {
    await refusal(
      host.carryPush({ key: key('unp'), path: w.source, ...(told === undefined ? {} : { unpushed: told }) }),
      C.CARRY_CODES.unpushed,
    );
    assert.deepEqual(branches(w.remote), []);
  }
  // told: pushed, and the branch carries the unpushed commit
  const pushed = await host.carryPush({ key: key('unp-ok'), path: w.source, unpushed: 1 });
  assert.deepEqual(branches(w.remote), [pushed.branch]);
  assert.equal(run(w.remote, 'rev-list', '--count', pushed.branch, '--not', 'main'), '2');
  // told of more than there are is fine
  const w2 = world();
  fs.writeFileSync(path.join(w2.source, 'a.txt'), 'edited\n');
  assert.equal((await C.planCarry(gitIn(w2.source))).unpushed, 0);
  await host.carryPush({ key: key('unp-more'), path: w2.source, unpushed: 5 });
  // a count git cannot give is a refusal, and a plan then says none
  const broken = { ok: false, stdout: '', stderr: 'x' };
  const wrap = (cwd: string) => async (args: string[], o?: any) => (args[0] === 'rev-list' ? broken : gitIn(cwd)(args, o));
  assert.equal((await C.planCarry(wrap(w2.source))).unpushed, 0);
  await code(C.pushCarry(wrap(w2.source), { ...carryOpts('carry-nocount-1'), unpushed: 1 }), C.CARRY_CODES.nothingToCarry);
  assert.equal(S.parseParams('git.carryPush', { key: 'key-12345678', path: '/p' }).unpushed, 0);
  assert.equal(S.parseParams('git.carryPush', { key: 'key-12345678', path: '/p', unpushed: 3 }).unpushed, 3);
  for (const bad of [-1, 1.5, '2', {}])
    assert.throws(() => S.parseParams('git.carryPush', { key: 'key-12345678', path: '/p', unpushed: bad }), /number of commits/);
});

test('M3: only the paths of the plan are staged: a secret or a new file that appears after the plan is not in the commit', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'edited\n');
  let planned = false;
  const racing = gitIn(w.source, (args) => {
    // right after the status the plan was read from, a secret and a new file appear
    if (!planned && args.includes('-uall')) {
      planned = true;
      fs.writeFileSync(path.join(w.source, '.env'), 'TOKEN=1\n');
      fs.writeFileSync(path.join(w.source, 'late.txt'), 'late\n');
    }
  });
  const pushed = await C.pushCarry(racing, carryOpts('carry-race-001'));
  assert.equal(planned, true);
  assert.deepEqual(run(w.source, 'ls-tree', '-r', '--name-only', pushed.commit).split('\n'), ['a.txt', 'b.txt']);
  assert.equal(run(w.source, 'diff', '--name-only', 'HEAD', pushed.commit), 'a.txt');
});

test('M3: a rename carries its old name with it, so the target loses the file; a long list is staged in chunks', async () => {
  const w = world();
  run(w.source, 'mv', 'b.txt', 'renamed.txt');
  const pushed = await C.pushCarry(gitIn(w.source), carryOpts('carry-rename-01'));
  assert.equal(
    run(w.source, 'diff', '--name-status', '--no-renames', 'HEAD', pushed.commit).split('\n').sort().join('|'),
    'A\trenamed.txt|D\tb.txt',
  );
  const many = world();
  const names = Array.from({ length: 450 }, (_, i) => `f${i}.txt`);
  for (const n of names) fs.writeFileSync(path.join(many.source, n), n);
  const adds: string[][] = [];
  const all = await C.pushCarry(
    gitIn(many.source, (args) => args[0] === 'add' && adds.push(args)),
    { ...carryOpts('carry-many-0001'), untracked: names },
  );
  assert.equal(all.files, 450);
  assert.equal(adds.length, 3, '200 + 200 + 50');
});

test('M3: if what is staged is not within the plan, the carry stops before a commit is made', async () => {
  const repo = {
    'rev-parse --is-inside-work-tree': { ok: true, stdout: 'true' },
    'symbolic-ref --short -q HEAD': { ok: true, stdout: 'main' },
    'rev-parse --verify -q HEAD': { ok: true, stdout: SHA_A },
    'remote get-url origin': { ok: true, stdout: 'https://github.com/a/b' },
    status: { ok: true, stdout: ' M a\0' },
    'rev-list': { ok: true, stdout: '0\n' },
    'rev-parse --absolute-git-dir': { ok: true, stdout: '/r/.git\n' },
    'diff-index': { ok: true, stdout: 'a\0.env\0' },
  };
  const s = script(repo);
  await code(C.pushCarry(s.run, carryOpts('carry-extra-001')), C.CARRY_CODES.changed);
  assert.ok(!s.calls.some((c) => c[0] === 'commit-tree' || c[0] === 'push'));
  await code(C.pushCarry(script({ ...repo, 'diff-index': { ok: false } }).run, carryOpts('carry-extra-002')), C.CARRY_CODES.changed);
});

test('M3: the refusal says how many commits, in the singular and the plural; a plan with no address for origin says none', async () => {
  const w = world();
  for (const n of ['one', 'two']) {
    fs.writeFileSync(path.join(w.source, `${n}.txt`), n);
    run(w.source, 'add', '.');
    run(w.source, 'commit', '-qm', n);
  }
  fs.writeFileSync(path.join(w.source, 'a.txt'), 'edited\n');
  await assert.rejects(host.carryPush({ key: key('plural'), path: w.source }), /^.*2 unpushed commits will be pushed to origin/);
  const noUrl = async (args: string[], o?: any) =>
    args[0] === 'remote' && args.includes('--push') ? { ok: false, stdout: '', stderr: 'x' } : gitIn(w.source)(args, o);
  const plan = await C.planCarry(noUrl);
  assert.deepEqual([plan.unpushed, plan.remote], [2, '']);
});
