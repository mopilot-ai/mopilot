// Clone and worktree keys on the Host's persisted ledger, and the clone's progress sent to the connection that asked (host/src/hostGit.mjs, server.mjs, cli.mjs; package 2.7b): a repeat after a restart gets the first request's folder or refusal without running git (W3), one the Host died in is reported, a key is never another method's, and progress reaches only its own requester (A1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { DIRS_LEDGER_ID, createHostGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { startServer } from '../host/src/server.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-ledger-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
const hostFs = createHostFs({ roots: [root] });
const URL = 'https://github.com/a/b.git';
let n = 0;
const ledgerDir = () => path.join(base, `ledger${n++}`);

/** A git whose clone makes its folder (or fails with `fail`) and reports one progress line; `runs` counts the clones. */
function git(o: { fail?: string } = {}) {
  const runs: string[][] = [];
  const run = async (args: string[], opts: { onLine?: (l: string) => void } = {}) => {
    runs.push(args);
    if (args[0] === 'clone') {
      opts.onLine?.('Receiving objects:  45% (9/20)');
      if (o.fail) return { ok: false, stdout: '', stderr: o.fail };
      fs.mkdirSync(args[args.length - 1], { recursive: true });
    }
    if (args[0] === 'worktree') fs.mkdirSync(args[args.length - 1], { recursive: true });
    return { ok: true, stdout: '', stderr: '' };
  };
  return { run, runs };
}
const hostWith = (dir: string, g = git()) =>
  Object.assign(createHostGit({ hostFs, run: g.run as any, ledger: createLedger(dir, { report: () => undefined }) }), { g });

test('a repeat after a restart returns the first clone and its folder without running git again (W3)', async () => {
  const dir = ledgerDir();
  const first = hostWith(dir);
  const q = { key: 'attempt-001', url: URL, dest: path.join(root, 'b') };
  assert.deepEqual(await first.clone(q), { path: path.join(root, 'b'), existed: false });
  // the Host restarted: a new ledger reads the same files, and nothing is cloned again
  const second = hostWith(dir);
  assert.deepEqual(await second.clone(q), { path: path.join(root, 'b'), existed: false });
  assert.equal(second.g.runs.length, 0);
  // a worktree is kept the same way
  const wt = { key: 'attempt-002', repo: path.join(root, 'repo'), branch: 'feat/x' };
  const made = await first.worktree(wt);
  assert.deepEqual(await hostWith(dir).worktree(wt), made);
});

test('a refused clone replays as the same refusal, with its code, after a restart', async () => {
  const dir = ledgerDir();
  const q = { key: 'attempt-003', url: URL, dest: path.join(root, 'refused') };
  await assert.rejects(hostWith(dir, git({ fail: 'fatal: repository not found' })).clone(q), (e: any) => e.code === 'clone_failed');
  const again = hostWith(dir);
  await assert.rejects(
    again.clone(q),
    (e: any) => e instanceof HostRefusal && e.code === 'clone_failed' && /repository not found/.test(e.message),
  );
  assert.equal(again.g.runs.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'refused')), false, 'no half folder');
});

test('a request the Host died in the middle of is reported as interrupted, never run twice', async () => {
  const dir = ledgerDir();
  const q = { key: 'attempt-004', url: URL, dest: path.join(root, 'interrupted') };
  // the intent is on disk, the effect never settles: the process is gone before it does
  const stuck = createHostGit({
    hostFs,
    run: (async () => new Promise(() => undefined)) as any,
    ledger: createLedger(dir, { report: () => undefined }),
  });
  void stuck.clone(q);
  await new Promise((r) => setTimeout(r, 50));
  const restarted = hostWith(dir);
  await assert.rejects(restarted.clone(q), (e: any) => e instanceof HostRefusal && e.code === 'request_interrupted');
  assert.equal(restarted.g.runs.length, 0);
});

test('a key is one request: reusing it for another method is refused (I1)', async () => {
  const h = hostWith(ledgerDir());
  await h.clone({ key: 'attempt-005', url: URL, dest: path.join(root, 'k') });
  await assert.rejects(h.worktree({ key: 'attempt-005', repo: path.join(root, 'repo'), branch: 'x' }), (e: any) => e.code === 'key_reused');
});

test('the ledger file is the Host-wide pseudo chat; without a ledger the keys are kept in memory as before', async () => {
  const dir = ledgerDir();
  await hostWith(dir).clone({ key: 'attempt-006', url: URL, dest: path.join(root, 'm') });
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(DIRS_LEDGER_ID, 'host:dirs');
  const g = git();
  const plain = createHostGit({ hostFs, run: g.run as any });
  const q = { key: 'attempt-007', url: URL, dest: path.join(root, 'n') };
  await plain.clone(q);
  await plain.clone(q);
  assert.equal(g.runs.filter((a) => a[0] === 'clone').length, 1);
});

test("a clone's progress goes to its caller's listener as well, and a listener that throws stops nothing", async () => {
  const seen: unknown[] = [];
  const g = git();
  const h = createHostGit({
    hostFs,
    run: g.run as any,
    onProgress: () => {
      throw new Error('listener failed');
    },
  });
  await h.clone({ key: 'attempt-008', url: URL, dest: path.join(root, 'p') }, (key: string, p: unknown) => seen.push([key, p]));
  assert.deepEqual(seen, [['attempt-008', { phase: 'Receiving objects', percent: 45 }]]);
});

/** One connection to the Host's line protocol: sends requests, collects every message. */
function connect(socketPath: string) {
  const socket = net.connect(socketPath);
  const got: any[] = [];
  let buffer = '';
  socket.setEncoding('utf8').on('data', (c: string) => {
    buffer += c;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      got.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const ask = (id: number, method: string, params: object) =>
    new Promise<any>((resolve) => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      const t = setInterval(() => {
        const r = got.find((m) => m.id === id);
        if (r) clearInterval(t), resolve(r);
      }, 5);
    });
  return { ask, got, close: () => socket.destroy() };
}

test('over the socket the progress events reach the connection that asked, and no other (A1)', async () => {
  const paths = createPaths({ dataDir: path.join(base, `d${n++}`), env: {} });
  const h = createHostGit({ hostFs, run: git().run as any });
  const server = await startServer({ paths, runtime: { send: async () => ({ ok: true }) } as any, dirs: { hostFs, hostGit: h } });
  const a = connect(paths.socketPath);
  const b = connect(paths.socketPath);
  try {
    const reply = await a.ask(1, 'git.clone', { key: 'attempt-009', url: URL, dest: path.join(root, 'sock') });
    assert.equal(reply.result.existed, false);
    assert.deepEqual(
      a.got.filter((m) => m.event),
      [{ event: 'progress', key: 'attempt-009', phase: 'Receiving objects', percent: 45 }],
    );
    assert.deepEqual(
      b.got.filter((m) => m.event),
      [],
    );
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});
