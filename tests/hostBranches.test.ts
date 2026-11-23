// The Host's branch calls behind a new chat on a machine (#5099): the branch list (host/src/hostRead.mjs), the switch to a picked branch (host/src/hostWrite.mjs), a worktree that starts from a picked branch (host/src/hostGit.mjs) and their handlers, with real git in folders inside the roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
// @ts-ignore: plain ESM without declarations
import { createHostFs, HostRefusal } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostRead, MAX_BRANCHES } from '../host/src/hostRead.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostWrite } from '../host/src/hostWrite.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import gitBranchMethods from '../host/src/methods/gitBranch.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-branches-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const read: any = createHostRead({ hostFs });
const lines: any[] = [];
const write: any = createHostWrite({ hostFs, audit: { governed: (e: any) => (lines.push(e), true) } });
const hostGit: any = createHostGit({ hostFs });
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
let n = 0;
/** A repository with `main` and `dev` (one commit ahead), checked out on main; `sub/` holds a file. */
const repo = () => {
  const dir = path.join(root, `r${n++}`);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  g(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'c\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  g(dir, 'checkout', '-qb', 'dev');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dev\n');
  g(dir, 'commit', '-qam', 'two');
  g(dir, 'checkout', '-q', 'main');
  return dir;
};

test('branches: a folder that is no repository says so, a repository lists its branches with where its top folder is', async () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await read.branches({ path: plain }), { isRepo: false });
  const dir = repo();
  assert.deepEqual(await read.branches({ path: dir }), {
    isRepo: true,
    current: 'main',
    default: null,
    branches: ['dev', 'main'],
    commits: true,
    top: dir,
    sub: '',
  });
  // a folder inside the repository names the top folder and its own place in it
  const inside = await read.branches({ path: path.join(dir, 'sub') });
  assert.equal(inside.top, dir);
  assert.equal(inside.sub, 'sub');
  // a refused folder is the Host's own refusal
  await assert.rejects(read.branches({ path: base }), { code: 'outside_roots' });
});

test("branches: origin's default is listed first and a repository with no commit says no worktree can start there", async () => {
  const dir = repo();
  const origin = path.join(base, 'origin.git');
  g(base, 'init', '-q', '--bare', origin);
  g(dir, 'remote', 'add', 'origin', origin);
  g(dir, 'push', '-q', 'origin', 'main', 'dev');
  g(dir, 'remote', 'set-head', 'origin', 'main');
  g(dir, 'checkout', '-q', 'dev');
  const list = await read.branches({ path: dir });
  assert.equal(list.default, 'main');
  assert.equal(list.current, 'dev');
  assert.deepEqual(list.branches, ['main', 'dev']);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  g(empty, 'init', '-q');
  assert.deepEqual(await read.branches({ path: empty }), {
    isRepo: true,
    current: 'main',
    default: null,
    branches: [],
    commits: false,
    top: empty,
    sub: '',
  });
});

test('branches: a repository with more branches than one answer holds is cut at the bound', async () => {
  const dir = repo();
  const sha = g(dir, 'rev-parse', 'HEAD');
  const input = Array.from({ length: MAX_BRANCHES + 5 }, (_, i) => `create refs/heads/b${i} ${sha}\n`).join('');
  const r = spawnSync('git', ['update-ref', '--stdin'], { cwd: dir, input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await read.branches({ path: dir })).branches.length, MAX_BRANCHES);
});

test('switch: a clean folder moves to the branch, the branch it is on is left as it is, and each write is audited without a name in it', async () => {
  const dir = repo();
  lines.length = 0;
  const done = await write.switchBranch({ path: dir, branch: 'dev' }, 'desktop');
  assert.deepEqual(done, { ok: true, stderr: '' });
  assert.equal(g(dir, 'branch', '--show-current'), 'dev');
  assert.deepEqual((await write.switchBranch({ path: dir, branch: 'dev' }, 'desktop')).ok, true);
  assert.deepEqual(lines[0], { kind: 'git.write', by: { kind: 'desktop' }, what: { kind: 'switch' } });
  assert.doesNotMatch(JSON.stringify(lines), /dev/);
});

test("switch: a change the branch would collide with is refused in a sentence and nothing moves; a missing branch is git's words", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'mine\n');
  const refused = await write.switchBranch({ path: dir, branch: 'dev' }, 'phone');
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.match(refused.stderr, /Can't switch to "dev": there are uncommitted changes on "main"/);
  assert.equal(g(dir, 'branch', '--show-current'), 'main');
  g(dir, 'checkout', '-q', 'a.txt');
  const missing = await write.switchBranch({ path: dir, branch: 'nope' }, 'phone');
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /Can't switch to "nope"|Failed to switch to "nope"/);
  const bad = await write.switchBranch({ path: dir, branch: '-x' }, 'phone');
  assert.match(bad.stderr, /Invalid branch name/);
});

test('switch: a folder that is no repository, outside the roots or missing is refused with its code, and nothing is audited', async () => {
  const plain = path.join(root, 'plain2');
  fs.mkdirSync(plain);
  lines.length = 0;
  await assert.rejects(write.switchBranch({ path: plain, branch: 'dev' }, 'desktop'), { code: 'not_a_repository' });
  await assert.rejects(write.switchBranch({ path: base, branch: 'dev' }, 'desktop'), { code: 'outside_roots' });
  await assert.rejects(write.switchBranch({ path: path.join(root, 'gone'), branch: 'dev' }, 'desktop'), { code: 'directory_missing' });
  assert.deepEqual(lines, []);
});

test('switch: a write from another writer of the same repository waits for the one under way', async () => {
  const dir = repo();
  const order: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  /** A git whose answers are canned; `hold` makes its `symbolic-ref` wait. */
  const fake = (name: string, hold?: Promise<void>) => async (args: string[]) => {
    order.push(`${name}:${args[0]}`);
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { ok: true, stdout: `${dir}\n\n`, stderr: '', signal: null };
    if (args[0] === 'symbolic-ref') {
      await hold;
      return { ok: true, stdout: 'dev\n', stderr: '', signal: null };
    }
    return { ok: true, stdout: '', stderr: '', signal: null };
  };
  const first = createHostWrite({ hostFs, run: fake('a', held) });
  const second = createHostWrite({ hostFs, run: fake('b') });
  const a = first.switchBranch({ path: dir, branch: 'dev' }, 'desktop');
  // the first write is under way (it holds the repository) before the second one asks
  while (!order.includes('a:symbolic-ref')) await new Promise((resolve) => setTimeout(resolve, 5));
  const b = second.switchBranch({ path: dir, branch: 'dev' }, 'phone');
  await new Promise((resolve) => setTimeout(resolve, 100));
  // the second one has looked at the folder, and has not touched the repository yet
  assert.deepEqual(order, ['a:rev-parse', 'a:symbolic-ref', 'b:rev-parse']);
  release();
  await Promise.all([a, b]);
  assert.equal(order.at(-1), 'b:symbolic-ref');
});

test("worktree: a new branch starts from the named branch, from origin's copy when this machine has none, and HEAD without one", async () => {
  const dir = repo();
  const dev = g(dir, 'rev-parse', 'dev');
  const main = g(dir, 'rev-parse', 'main');
  const made = await hostGit.worktree({ key: 'key-from-0001', repo: dir, branch: 'mopilot/one', from: 'dev' });
  assert.equal(made.existed, false);
  assert.equal(g(made.path, 'rev-parse', 'HEAD'), dev);
  assert.equal(g(made.path, 'branch', '--show-current'), 'mopilot/one');
  const head = await hostGit.worktree({ key: 'key-from-0002', repo: dir, branch: 'mopilot/two' });
  assert.equal(g(head.path, 'rev-parse', 'HEAD'), main);
  // a branch only origin has
  const origin = path.join(base, 'origin2.git');
  g(base, 'init', '-q', '--bare', origin);
  g(dir, 'remote', 'add', 'origin', origin);
  g(dir, 'push', '-q', 'origin', 'dev:remote-only');
  g(dir, 'fetch', '-q', 'origin');
  const theirs = await hostGit.worktree({ key: 'key-from-0003', repo: dir, branch: 'mopilot/three', from: 'remote-only' });
  assert.equal(g(theirs.path, 'rev-parse', 'HEAD'), dev);
  // a branch nobody has is the Host's refusal, and no folder is left
  await assert.rejects(
    hostGit.worktree({ key: 'key-from-0004', repo: dir, branch: 'mopilot/four', from: 'nope' }),
    (e: any) => e instanceof HostRefusal && e.code === 'worktree_failed' && /no branch nope/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(`${dir}.worktrees`, 'mopilot%2ffour')), false);
  // a branch that exists is checked out as it is: `from` only starts a new one
  const same = await hostGit.worktree({ key: 'key-from-0005', repo: dir, branch: 'dev', from: 'main' });
  assert.equal(g(same.path, 'rev-parse', 'HEAD'), dev);
});

test("the handlers read and switch through the Host's folders, and a Host with none says it cannot", async () => {
  const dir = repo();
  const { handlers } = gitBranchMethods({ hostFs });
  assert.equal(((await handlers['host.gitBranches']({ path: dir })) as any).current, 'main');
  assert.equal((await handlers['host.gitSwitch']({ path: dir, branch: 'dev' }, 'desktop')).ok, true);
  assert.equal(g(dir, 'branch', '--show-current'), 'dev');
  const none = gitBranchMethods({}).handlers;
  assert.throws(() => none['host.gitBranches']({ path: dir }), /cannot read or change a folder/);
  assert.throws(() => none['host.gitSwitch']({ path: dir, branch: 'dev' }, 'desktop'), /cannot read or change a folder/);
});

test('through the protocol a connection that said hello reads the branches and switches, as the app does; one without the feature is refused', async () => {
  const dir = repo();
  const quiet = { report: () => undefined };
  const state = fs.mkdtempSync(path.join(base, 'wire-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const epochs = createEpochStore(path.join(state, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(state, 'l'), quiet) });
  const protocol = createProtocol({
    runtime: { host, send: async () => ({ turnId: 't' }), permit: () => true, familyOf: () => 'claude' } as any,
    epochs,
    guard,
    status: () => ({ running: true }),
    hostFs,
  } as any);
  const conn = protocol.connection(() => undefined);
  const hello: any = await conn.call('host.hello', helloParams());
  assert.ok(hello.features.includes('gitBranch'), 'the Host says it has the feature');
  assert.equal(((await conn.call('host.gitBranches', { path: dir })) as any).current, 'main');
  assert.deepEqual(await conn.call('host.gitSwitch', { path: dir, branch: 'dev' }), { ok: true, stderr: '' });
  assert.equal(g(dir, 'branch', '--show-current'), 'dev');
  const old = protocol.connection(() => undefined);
  await old.call('host.hello', { ...helloParams(), features: helloParams().features.filter((f: string) => f !== 'gitBranch') });
  await assert.rejects(old.call('host.gitBranches', { path: dir }), (e: any) => e.code === 'feature_missing');
});

/** One connection to a Host's socket that sends its requests one after another, as the app's session does; the CLI token beside the socket proves it. */
function connect(socketPath: string) {
  const token = fs.readFileSync(`${socketPath}.token`, 'utf8');
  const socket = net.connect(socketPath);
  let buffer = '';
  const waiting = new Map<number, (reply: any) => void>();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const reply = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(reply.id)?.(reply);
    }
  });
  let id = 0;
  return {
    call: (method: string, params: object) =>
      new Promise<any>((resolve) => {
        waiting.set(++id, resolve);
        socket.write(`${JSON.stringify({ id, method, params, token })}\n`);
      }),
    close: () => socket.destroy(),
  };
}

test("on a real Host socket the branch list and the switch are answered after the hello and not before: what the app's folder service sends", async () => {
  const dir = repo();
  const paths = createPaths({ dataDir: path.join(base, 'sock-branches'), env: {} });
  const quiet = { report: () => undefined };
  const state = fs.mkdtempSync(path.join(base, 'wire2-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const epochs = createEpochStore(path.join(state, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(state, 'l'), quiet) });
  const protocol = createProtocol({
    runtime: { host, send: async () => ({ turnId: 't' }), permit: () => true, familyOf: () => 'claude' } as any,
    epochs,
    guard,
    status: () => ({ running: true }),
    hostFs,
  } as any);
  const server = await startServer({ paths, protocol, dirs: { hostFs, hostGit, hostRead: createHostRead({ hostFs }) } as any });
  const client = connect(paths.socketPath);
  try {
    // a connection that has not said hello is refused: the app's folder service says hello first
    const early = await client.call('host.gitBranches', { path: dir });
    assert.match(early.error, /hello/i);
    const hello = await client.call('host.hello', helloParams());
    assert.ok(hello.result.features.includes('gitBranch'), 'the Host says it has the feature');
    const list = await client.call('host.gitBranches', { path: dir });
    assert.equal(list.result.current, 'main');
    assert.deepEqual((await client.call('host.gitSwitch', { path: dir, branch: 'dev' })).result, { ok: true, stderr: '' });
    assert.equal(g(dir, 'branch', '--show-current'), 'dev');
    // the worktree call is the line protocol's own, and takes the start branch
    const made = await client.call('git.worktree', { key: 'key-sock-0001', repo: dir, branch: 'mopilot/sock', from: 'main' });
    assert.equal(g(made.result.path, 'rev-parse', 'HEAD'), g(dir, 'rev-parse', 'main'));
  } finally {
    client.close();
    await server.close();
  }
});
