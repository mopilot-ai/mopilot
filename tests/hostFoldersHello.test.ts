// A machine's Changes pane writes (commit, discard) over the REAL Host protocol session (host/src/protocol.mjs), which refuses every versioned request until `host.hello` came first on the connection (#5050): the folder service says hello itself, an older Host is told to update, and the shared rule the fake Hosts follow is the real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore: plain ESM without declarations
import { BEFORE_HELLO, VERSIONED_METHOD } from '../host/src/versionedMethods.mjs';
const require = createRequire(import.meta.url);
const { createHostFolders } = require('../electron/host/folders.cjs');
const { sayHello } = require('../electron/host/helloFirst.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folders-hello-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const quiet = { report: () => undefined };
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trimEnd();
};

const repo = () => {
  const dir = path.join(base, 'root', `r${fs.readdirSync(path.join(base, 'root')).length}`);
  fs.mkdirSync(dir);
  g(dir, 'init', '-q', '--initial-branch=main');
  for (const [k, v] of [
    ['user.name', 't'],
    ['user.email', 't@example.invalid'],
    ['commit.gpgsign', 'false'],
  ])
    g(dir, 'config', k, v);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  return dir;
};
fs.mkdirSync(path.join(base, 'root'));

/** The folder service over a session on the real protocol: one connection per open, as the Host's server makes one per client. */
function world(o: { mutate?: (method: string, params: any) => any } = {}) {
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(base, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(base, 'l'), quiet) });
  const protocol = createProtocol({
    runtime,
    epochs,
    guard,
    status: () => ({ running: true }),
    hostFs: createHostFs({ roots: [path.join(base, 'root')] }),
  });
  const opened: string[] = [];
  const folders = createHostFolders({
    open: async () => {
      const conn = protocol.connection(() => undefined);
      return {
        call: async (method: string, params?: object) => {
          opened.push(method);
          return conn.call(method, o.mutate ? o.mutate(method, params) : params);
        },
        close: () => undefined,
      };
    },
    store: new OwnershipStore(path.join(base, `own-${Math.random()}.json`)),
  });
  return { folders, protocol, opened };
}

test('commit and discard succeed on the real Host protocol: the app says hello before the write', async () => {
  const w = world();
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const discarded = await w.folders.discard('box', { path: dir, file: 'a.txt' });
  assert.equal(discarded.ok, true, discarded.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  const committed = await w.folders.commit('box', { path: dir, message: 'two', files: null });
  assert.equal(committed.ok, true, committed.stderr);
  assert.equal(g(dir, 'log', '-1', '--format=%s'), 'two');
  assert.deepEqual(w.opened, ['host.hello', 'host.gitDiscard', 'host.hello', 'host.gitCommit']);
});

test('the real Host refuses a write on a connection that never said hello, with the sentence no user may see', async () => {
  const { protocol } = world();
  const conn = protocol.connection(() => undefined);
  const dir = repo();
  await assert.rejects(
    conn.call('host.gitCommit', { path: dir, message: 'm', files: null }),
    (e: any) => e.code === 'hello_required' && /^Say hello first/.test(e.message),
  );
});

test('a Host that agreed on no write is an update to make, never a protocol sentence', async () => {
  const w = world({ mutate: (method, params) => (method === 'host.hello' ? { ...params, features: [] } : params) });
  await assert.rejects(
    w.folders.commit('box', { path: repo(), message: 'm', files: null }),
    (e: any) => e.code === 'host_outdated' && /^Update the Host on that machine to commit/.test(e.message),
  );
});

test('the shared rule: the versioned methods need hello, the handshake and the pairing proof do not', () => {
  for (const m of ['host.gitCommit', 'chat.send', 'browser.open', 'desktop.state', 'host.status']) {
    assert.equal(VERSIONED_METHOD.test(m) && !BEFORE_HELLO.has(m), true, m);
  }
  for (const m of ['host.hello', 'host.challenge', 'host.pair', 'host.auth', 'git.status', 'fs.list', 'status']) {
    assert.equal(VERSIONED_METHOD.test(m) && !BEFORE_HELLO.has(m), false, m);
  }
});

test('sayHello without a method only agrees, and with one checks what it needs', async () => {
  const hello = { protocol: { minor: 1, floor: 1 }, features: ['gitWrite'], capabilities: {} };
  const s = { call: async () => hello };
  assert.deepEqual((await sayHello(s)).features.includes('gitWrite'), true);
  await sayHello(s, 'host.gitCommit');
  await assert.rejects(
    sayHello({ call: async () => ({ ...hello, features: [] }) }, 'host.gitCommit'),
    (e: any) => e.code === 'feature_missing',
  );
});
