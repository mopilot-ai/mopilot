// The Host's directory methods over its socket (host/src/server.mjs + cli.mjs, package 2.7): fs.list, git.clone, git.worktree, and directory_missing at send.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit } from '../host/src/hostGit.mjs';
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
