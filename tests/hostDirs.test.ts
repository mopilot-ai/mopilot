// The Host's directory methods over its socket (host/src/server.mjs + cli.mjs, package 2.7): fs.list, git.clone, git.worktree, and directory_missing at send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit, runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
import { createRequire } from 'node:module';
import { line } from './support/host-line.ts';
import { waitFor } from './support/waitFor.ts';
import { keySafe } from './support/hostKeySafe.ts';

const { loadIdentity, pairWith } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-dirs-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
let n = 0;
const fresh = () => createPaths({ dataDir: path.join(base, `d${n++}`), env: {} });
const key = 'key-12345678';

test('the directory methods answer over the socket; refusals carry a code, bad params do not', async () => {
  const sent: unknown[] = [];
  const runs: string[][] = [];
  const hostFs = createHostFs({ roots: [root] });
  const run = async (args: string[]) => {
    runs.push(args);
    if (args[0] === 'clone') fs.mkdirSync(args[args.length - 1]);
    if (args[0] === 'worktree') fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { ok: args[0] !== 'rev-parse', stdout: '', stderr: '' };
  };
  const paths = fresh();
  const server = await startServer({
    paths,
    runtime: { send: async (p: unknown) => (sent.push(p), { ok: true }) } as any,
    dirs: { hostFs, hostGit: createHostGit({ hostFs, run: run as any }) },
  });
  try {
    const ask = (method: string, params: object) => callHost(paths.socketPath, method, params) as Promise<any>;
    assert.deepEqual(
      (await ask('fs.list', { path: root })).result.entries.map((e: any) => e.name),
      ['repo'],
    );
    assert.deepEqual(await ask('fs.list', { path: base }), {
      id: 1,
      error: 'That folder is outside what this host shares.',
      code: 'outside_roots',
    });
    assert.equal((await ask('fs.list', { path: '' })).code, undefined);
    assert.equal((await ask('git.clone', { key, url: 'https://github.com/a/b.git', dest: path.join(root, 'b') })).result.existed, false);
    // the folder is read where it is; a folder outside the roots is refused with its code, and a branch to clone is checked by the parser
    assert.deepEqual((await ask('git.inspect', { path: path.join(root, 'repo') })).result, { isRepo: false });
    assert.deepEqual((await ask('git.inspect', { path: path.join(root, 'repo'), sidebar: true })).result, { sidebar: true });
    assert.equal((await ask('git.inspect', { path: path.join(base, 'gone') })).code, 'directory_missing');
    assert.equal(
      (await ask('git.clone', { key, url: 'https://github.com/a/b.git', dest: path.join(root, 'c'), branch: '-x' })).code,
      undefined,
    );
    assert.equal(
      (await ask('git.clone', { key: 'key-87654321', url: 'https://github.com/a/b.git', dest: path.join(root, 'c'), branch: 'feat/x' }))
        .result.existed,
      false,
    );
    assert.ok(runs.some((a) => a.includes('--branch=feat/x')));
    // the carry methods are served here too; the fake git has no changes to carry
    const carry = { key: 'key-carry-001', path: path.join(root, 'repo') };
    assert.equal((await ask('git.carryPush', carry)).code, 'nothing_to_carry');
    assert.equal(
      (await ask('git.carryApply', { ...carry, branch: 'mopilot/carry/abcdefgh', commit: 'a'.repeat(40), parent: 'b'.repeat(40) })).code,
      'carry_no_repository',
    );
    assert.deepEqual((await ask('git.carryDrop', { path: carry.path, branch: 'mopilot/carry/abcdefgh' })).result, { dropped: true });
    const wt = await ask('git.worktree', { key, repo: path.join(root, 'repo'), branch: 'x' });
    assert.equal(wt.result?.existed, false, JSON.stringify(wt));
    // a folder from another Host means nothing here
    assert.equal((await ask('send', { key, text: 'hi', cwd: path.join(root, 'gone') })).code, 'directory_missing');
    assert.equal((await ask('send', { key, text: 'hi', cwd: path.join(root, 'repo') })).result.ok, true);
    // outside the browsing roots is still a real folder to run in
    assert.equal((await ask('send', { key, text: 'hi', cwd: base })).result.ok, true);
    assert.equal((await ask('send', { key, text: 'hi', cwd: path.join(root, 'repo', '..', 'repo') + '/x' })).code, 'directory_missing');
    assert.equal((await ask('send', { key, text: 'hi' })).result.ok, true);
    assert.equal(sent.length, 3);
  } finally {
    await server.close();
  }
});

test('without directory wiring the methods are unknown, and send is not checked', async () => {
  const paths = fresh();
  const server = await startServer({ paths, runtime: { send: async () => ({ ok: true }) } as any });
  try {
    assert.match(((await callHost(paths.socketPath, 'fs.list', { path: root })) as any).error, /Unknown method/);
    for (const method of ['git.inspect', 'git.carryPush', 'git.carryApply', 'git.carryDrop'])
      assert.match(((await callHost(paths.socketPath, method, { path: root })) as any).error, /Unknown method/);
    assert.equal(((await callHost(paths.socketPath, 'send', { cwd: '/nope' })) as any).result.ok, true);
  } finally {
    await server.close();
  }
});

test('Git reports the same primary checkout for a subfolder and linked worktree over the Host socket', async () => {
  const checkout = path.join(base, process.platform === 'win32' ? 'projet été' : 'projet été\n\nprimary');
  const source = path.join(checkout, 'src');
  const linked = path.join(base, 'linked');
  const bare = path.join(base, 'bare');
  const emptyBare = path.join(base, 'empty-bare');
  const bareLinked = path.join(
    base,
    process.platform === 'win32' ? 'bare-linked' : 'a-bare\ndetached\n\nworktree linked\ndetached\n\nworktree /fragment',
  );
  const bareSecond = path.join(base, process.platform === 'win32' ? 'bare-second' : 'z-bare\n\nzzz');
  const plain = path.join(base, 'plain');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(plain);
  const primary = fs.realpathSync(checkout);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args]);
  git(checkout, 'init', '-q');
  git(checkout, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-qm', 'Initial');
  git(checkout, 'worktree', 'add', '-q', '--detach', linked);
  git(base, 'clone', '-q', '--bare', checkout, bare);
  git(base, 'init', '-q', '--bare', emptyBare);
  git(bare, 'worktree', 'add', '-q', '--detach', bareLinked);
  git(bare, 'worktree', 'add', '-q', '--detach', bareSecond);
  const bareSource = path.join(bareLinked, 'src');
  fs.mkdirSync(bareSource);
  const paths = fresh();
  const hostFs = createHostFs({ roots: [base] });
  let legacy = false;
  let blockedCommon: string | undefined;
  let blockedTop = false;
  const run: typeof runGit = async (args, options) => {
    if (options?.cwd === plain) assert.equal(options.env?.LC_ALL, 'C');
    if (legacy && args.includes('-z'))
      return { ok: false, stdout: '', stderr: "error: unknown switch `z'", signal: null, spawnFailed: false, code: 129 };
    const result = await runGit(args, options);
    if (legacy && options?.cwd === emptyBare) {
      if (args[0] === 'worktree') return { ...result, ok: true, stdout: `worktree ${emptyBare}\nbare\n\n` };
      if (args.includes('--git-common-dir')) return { ...result, ok: true, stdout: '.\n' };
    }
    if (blockedCommon === options?.cwd && args.includes('--git-common-dir')) return { ...result, ok: false, stderr: 'Git timed out' };
    if (blockedTop && options?.cwd === bareLinked && args.includes('--show-toplevel'))
      return { ...result, ok: false, stderr: 'Git timed out' };
    if (legacy && args[0] === 'worktree' && [bareSource, bareSecond].includes(options?.cwd ?? '')) {
      // Paths that mimic a record header can resolve to a regular directory or to a different repository.
      const linkedRecords = [plain, checkout, bareSource, bareLinked, bareSecond].map(
        (folder) => `worktree ${folder}\nHEAD ${'a'.repeat(40)}\ndetached\n\n`,
      );
      const stdout = `worktree ${bare}\nbare\n\n${linkedRecords.join('')}`;
      return { ...result, stdout };
    }
    if (legacy && args[0] === 'worktree' && options?.cwd === path.join(primary, 'src')) {
      const head = 'a'.repeat(40);
      const stdout = `worktree ${primary}\nHEAD ${head}\nbranch refs/heads/main\n\nworktree ${linked}\nHEAD ${head}\ndetached\n\n`;
      return { ...result, stdout };
    }
    return result;
  };
  const server = await startServer({ paths, dirs: { hostFs, hostGit: createHostGit({ hostFs, run }) } } as any);
  try {
    const find = (folder: string) =>
      callHost(paths.socketPath, 'git.inspect', { path: folder, sidebar: true, checkout: true }) as Promise<any>;
    for (const folder of [checkout, source, linked]) {
      assert.deepEqual((await find(folder)).result, { sidebarCheckout: true, path: primary });
    }
    for (const folder of [emptyBare, plain]) assert.equal((await find(folder)).result.path ?? null, null);
    for (const folder of [bareSource, bareSecond]) {
      assert.deepEqual((await find(folder)).result, { sidebarCheckout: true, path: bareLinked });
    }
    assert.equal((await find(path.join(base, 'gone'))).code, 'directory_missing');
    legacy = true;
    for (const folder of [checkout, source, linked]) {
      assert.deepEqual((await find(folder)).result, { sidebarCheckout: true, path: primary });
    }
    for (const folder of [bareSource, bareSecond]) {
      assert.deepEqual((await find(folder)).result, { sidebarCheckout: true, path: bareLinked });
    }
    assert.deepEqual((await find(emptyBare)).result, { sidebarCheckout: true, path: null });
    blockedCommon = bareSource;
    assert.deepEqual((await find(bareSource)).result, { sidebarCheckout: true });
    blockedCommon = bareLinked;
    assert.deepEqual((await find(bareSource)).result, { sidebarCheckout: true, path: bareSecond });
    blockedCommon = undefined;
    blockedTop = true;
    assert.deepEqual((await find(bareSource)).result, { sidebarCheckout: true, path: bareSecond });
    blockedTop = false;
  } finally {
    await server.close();
  }
  const limited = createHostGit({ hostFs: createHostFs({ roots: [linked] }) });
  assert.deepEqual(await limited.sidebarCheckout({ path: linked }), { sidebarCheckout: true, path: linked });
  assert.deepEqual(await limited.sidebarCheckout({ path: checkout }), { sidebarCheckout: true, path: linked });
  const linkedSource = path.join(linked, 'src');
  fs.mkdirSync(linkedSource);
  const unshared = createHostGit({ hostFs: createHostFs({ roots: [linkedSource] }) });
  assert.deepEqual(await unshared.sidebarCheckout({ path: linkedSource }), { sidebarCheckout: true, path: null });
  const malformed = createHostGit({
    hostFs,
    run: async () => ({
      ok: true,
      stdout: `worktree ${linked}\0unexpected attribute\0\0`,
      stderr: '',
      code: 0,
      signal: null,
      spawnFailed: false,
    }),
  });
  assert.deepEqual(await malformed.sidebarCheckout({ path: linked }), { sidebarCheckout: true, path: undefined });
  const legacyList: typeof runGit = async (args, options) => {
    const result = await run(args, options);
    return args[0] === 'worktree' && !args.includes('-z')
      ? {
          ...result,
          ok: true,
          stdout: `worktree ${bare}\nbare\n\nworktree ${bareSecond}\nHEAD ${'a'.repeat(40)}\ndetached\nprunable stale registration\n\n`,
        }
      : result;
  };
  const oldNarrowed = createHostGit({ hostFs: createHostFs({ roots: [linkedSource] }), run });
  assert.deepEqual(await oldNarrowed.sidebarCheckout({ path: linkedSource }), { sidebarCheckout: true, path: null });
  const bareRegistrations = path.join(bare, 'worktrees');
  fs.writeFileSync(path.join(bareRegistrations, '00-readme'), 'ignored');
  const fakeRegistration = path.join(bareRegistrations, '00-decoy');
  fs.mkdirSync(fakeRegistration);
  const gitdir = path.join(fakeRegistration, 'gitdir');
  fs.writeFileSync(gitdir, `${path.join(checkout, '.git')}\n`);
  const missingLegacy = createHostGit({ hostFs, run: legacyList });
  assert.deepEqual(await missingLegacy.sidebarCheckout({ path: bareSecond }), { sidebarCheckout: true, path: bareLinked });
  fs.writeFileSync(gitdir, 'malformed\n');
  assert.deepEqual(await missingLegacy.sidebarCheckout({ path: bareSecond }), { sidebarCheckout: true, path: bareLinked });
  const unverifiable = createHostGit({ hostFs: createHostFs({ roots: [plain] }), run: legacyList });
  assert.deepEqual(await unverifiable.sidebarCheckout({ path: bareSecond }), { sidebarCheckout: true, path: undefined });
  fs.rmSync(gitdir);
  blockedTop = true;
  assert.deepEqual(await missingLegacy.sidebarCheckout({ path: bareSecond }), { sidebarCheckout: true, path: bareSecond });
  blockedTop = false;
  fs.rmSync(fakeRegistration, { recursive: true });
  const incompleteList: typeof runGit = async (args, options) => {
    const result = await legacyList(args, options);
    return args[0] === 'worktree' && !args.includes('-z') ? { ...result, stdout: 'incomplete listing\n' } : result;
  };
  const incomplete = createHostGit({ hostFs: createHostFs({ roots: [plain] }), run: incompleteList });
  assert.deepEqual(await incomplete.sidebarCheckout({ path: bareSecond }), { sidebarCheckout: true, path: undefined });
  await fs.promises.rename(bareRegistrations, `${bareRegistrations}.saved`);
  fs.writeFileSync(bareRegistrations, 'not a directory');
  const brokenList: typeof runGit = async (args, options) => {
    if (args.includes('--git-common-dir')) return { ok: true, stdout: `${bare}\n`, stderr: '', signal: null, spawnFailed: false, code: 0 };
    return legacyList(args, options);
  };
  await assert.rejects(createHostGit({ hostFs, run: brokenList }).sidebarCheckout({ path: bareSecond }), { code: 'ENOTDIR' });
  const unreadable = new Error('filesystem read failed');
  const broken = createHostGit({
    hostFs: {
      ...hostFs,
      requireDirectory: async () => {
        throw unreadable;
      },
    },
  });
  await assert.rejects(broken.sidebarCheckout({ path: checkout }), unreadable);
});

/** Runs `serve` in-process with `env`, asks it `method`, then stops it with SIGTERM. */
async function serveAndAsk(env: NodeJS.ProcessEnv, method: string, params: object) {
  const dir = path.join(base, `s${n++}`);
  const signals = new EventEmitter() as unknown as NodeJS.Process;
  const printed: string[] = [];
  const done = main(['serve', '--data-dir', dir], { env, signals, out: (l) => printed.push(l), err: () => {} });
  const paths = createPaths({ dataDir: dir, env: {} });
  await waitFor(() => printed.some((l) => l.startsWith('Pairing code: ')), 'the pairing code');
  // the Host serves directories only to a client it paired
  const conn = line(paths.socketPath);
  try {
    await pairWith(
      conn.request,
      loadIdentity(path.join(base, `app${n}.json`), keySafe),
      printed.find((l) => l.startsWith('Pairing code: '))?.slice(14),
    );
    return (await conn.call(method, params)) as any;
  } finally {
    conn.close();
    signals.emit('SIGTERM');
    await done;
  }
}

test('serve takes its roots from MOPILOT_HOST_ROOTS, else the home folder', async () => {
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  const env = { MOPILOT_HOST_ROOTS: [root, other].join(path.delimiter) };
  assert.equal((await serveAndAsk(env, 'fs.list', { path: other })).result.path, other);
  assert.equal((await serveAndAsk(env, 'fs.list', { path: base })).code, 'outside_roots');
  assert.equal((await serveAndAsk({ MOPILOT_HOST_ROOTS: '' }, 'fs.list', { path: '/' })).code, 'outside_roots');
});
