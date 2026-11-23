// A session with a listed machine (machines.session in electron/host/machines.cjs) and the folder IPC (electron/app/ipc/host.cjs): the gate, an unknown machine, the tunnel held until the session is closed and released once, and the folder calls refused while Host is not allowed (A3, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { register } = require('../electron/app/ipc/host.cjs');
const frames = require('../shared/host/frames.mjs');

const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-session-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const tick = () => new Promise((r) => setImmediate(r));

/** A connection to a Host that connects at once and answers each request from `replies` (an Error there is an error reply). */
class Sock extends EventEmitter {
  destroyed = false;
  /** The methods asked of this connection, in order. */
  log: string[] = [];
  replies: Record<string, any>;
  constructor(replies: Record<string, any>) {
    super();
    this.replies = replies;
    queueMicrotask(() => this.emit('connect'));
  }
  write(b: Buffer) {
    const msg = frames.createDecoder().push(b)[0].message;
    this.log.push(msg.method);
    // a request named `ev` is preceded by an event from the Host
    if (msg.method === 'ev') queueMicrotask(() => this.emit('data', frames.encodeControl({ event: 'progress', key: 'k' })));
    const reply = this.replies[msg.method] ?? {};
    const body = reply instanceof Error ? { error: { message: reply.message, code: 'refused' } } : { result: reply };
    queueMicrotask(() => this.emit('data', frames.encodeControl({ id: msg.id, ...body })));
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function world(t: any, o: { allowed?: boolean; ready?: boolean; session?: any } = {}) {
  const clock = installFakeClock(t, 1_000_000);
  const dir = dirOf(t);
  fs.writeFileSync(
    path.join(dir, 'host-registry.json'),
    JSON.stringify({
      version: 1,
      hosts: [
        { id: 'box', name: 'box', address: 'me@box', socketPath: '/h/host.sock' },
        { id: 'bare', name: 'bare', address: 'me@bare' },
      ],
    }),
  );
  const events: string[] = [];
  const replies: Record<string, any> = {
    'host.challenge': { nonce: 'n', hostId: 'abababababababababababababababab' },
    status: { harnesses: [], capabilities: {} },
  };
  const socks: Sock[] = [];
  const pool = {
    get: (target: any) => ({
      acquire: () => (
        events.push(`acquire ${target.destination}`),
        {
          socketPath: '/local.sock',
          ready: o.ready === false ? new Promise(() => {}) : Promise.resolve(true),
          release: () => events.push('release'),
        }
      ),
    }),
  };
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => o.allowed ?? true,
    watch: () => undefined,
    pool,
    connect: () => (socks.push(new Sock(replies)), socks.at(-1) as any),
    session: o.session,
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  return { m, events, socks, replies, clock, dirOf: dir };
}

test('a session on a listed machine holds the tunnel until it is closed, and releases it once however often it is closed', async (t) => {
  const w = world(t);
  const events: any[] = [];
  const session = await w.m.session('box', (e: any) => {
    events.push(e);
    throw new Error('listener failed');
  });
  await session.call('ev');
  assert.deepEqual(events, [{ event: 'progress', key: 'k' }], 'a throwing listener is reported and the session goes on');
  const before = w.events.filter((e) => e === 'release').length;
  assert.deepEqual(await session.call('status'), { harnesses: [], capabilities: {} });
  session.close();
  session.close();
  assert.equal(w.events.filter((e) => e === 'release').length, before + 1);
  assert.ok(w.socks.at(-1)?.destroyed);
});

test('a session whose connection is refused releases the tunnel and reports why (B2)', async (t) => {
  const w = world(t);
  w.replies['host.challenge'] = new Error('This client is not paired with the Host.');
  await assert.rejects(w.m.session('box'), (e: any) => e.code === 'refused');
  assert.ok(w.events.includes('release'));
});

test('an unknown machine and one without a socket are refused; so is any request while Host is not allowed (A3)', async (t) => {
  let w = world(t);
  await assert.rejects(w.m.session('nope'), (e: any) => e.code === 'unknown_machine');
  await assert.rejects(w.m.session('bare'), /no Host socket/);
  w = world(t, { allowed: false });
  await assert.rejects(w.m.session('box'), (e: any) => e.code === 'not_allowed');
});

test('a tunnel that does not come up in time is released and reported (B2)', async (t) => {
  const w = world(t, { ready: false });
  const opened = w.m.session('box');
  await tick();
  w.clock.advance(15_000);
  await assert.rejects(opened, { message: /Could not reach the machine over SSH/, code: 'host_unreachable' });
  assert.equal(w.events.filter((e) => e === 'release').length >= 1, true);
});

test('the given session factory is used as is (for the folder service)', async (t) => {
  const made: any[] = [];
  const w = world(t, {
    session: async (record: any, onEvent: any) => (made.push([record.id, onEvent]), { call: async () => 1, close: () => undefined }),
  });
  const onEvent = () => undefined;
  const s = await w.m.session('box', onEvent);
  assert.deepEqual(made, [['box', onEvent]]);
  assert.equal(await s.call(), 1);
});

test('IPC: the folder calls are refused while Host is not allowed, make one service for every window, and pass the machine and the request on (A3)', async () => {
  let allowed = false;
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  const calls: any[] = [];
  const broadcasts: any[] = [];
  let made = 0;
  let opts: any;
  const folders = {
    list: async (id: string, q: any) => (calls.push(['list', id, q]), { path: '/p' }),
    search: async (id: string, q: any) => (calls.push(['search', id, q]), { files: ['a.ts'], truncated: false }),
    commands: async (id: string, q: any) => (calls.push(['commands', id, q]), { listed: true, commands: [] }),
    clone: async (id: string, q: any) => (calls.push(['clone', id, q]), { path: '/c', existed: false }),
    worktree: async (id: string, q: any) => (calls.push(['worktree', id, q]), { path: '/w', existed: false }),
    branches: async (id: string, q: any) => (calls.push(['branches', id, q]), { isRepo: false }),
    switchBranch: async (id: string, q: any) => (calls.push(['switchBranch', id, q]), { ok: true, stderr: '' }),
    bind: (chatId: string, q: any) => void calls.push(['bind', chatId, q]),
  };
  const sessionCalls: any[] = [];
  register(
    ipcMain,
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: (...a: any[]) => broadcasts.push(a) },
    {
      create: () => ({
        list: () => ({ machines: [], resolved: true }),
        rotateKey: async () => ({ machines: 0, pending: [] }),
        session: async (id: string, e: any) => (sessionCalls.push([id, e]), 'session'),
      }),
      createFolders: (o: any) => ((opts = o), made++, folders),
      allowed: () => allowed,
    },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  for (const c of [
    'host:fsList',
    'host:gitStatus',
    'host:gitBranches',
    'host:gitSwitch',
    'host:gitDiff',
    'host:gitCommit',
    'host:gitDiscard',
    'host:fsTree',
    'host:fsRead',
    'host:fsSearch',
    'host:commands',
    'host:clone',
    'host:worktree',
    'host:bindFolder',
  ])
    assert.equal((await call(c, 'box', {})).error.code, 'not_allowed');
  assert.equal(made, 0);
  allowed = true;
  assert.deepEqual(await call('host:rotateKey'), { value: { machines: 0, pending: [] } });
  assert.deepEqual(await call('host:fsList', 'box', { path: '/p' }), { value: { path: '/p' } });
  assert.deepEqual(await call('host:fsList'), { value: { path: '/p' } });
  assert.deepEqual(await call('host:fsSearch', 'box', { path: '/p', query: 'a' }), { value: { files: ['a.ts'], truncated: false } });
  assert.deepEqual(await call('host:fsSearch'), { value: { files: ['a.ts'], truncated: false } });
  assert.deepEqual(
    calls.filter((c: any) => c[0] === 'search'),
    [
      ['search', 'box', { path: '/p', query: 'a' }],
      ['search', '', {}],
    ],
  );
  assert.deepEqual(await call('host:commands', 'box', { harness: 'claude' }), { value: { listed: true, commands: [] } });
  assert.deepEqual(await call('host:commands'), { value: { listed: true, commands: [] } });
  assert.deepEqual(
    calls.filter((c: any) => c[0] === 'commands'),
    [
      ['commands', 'box', { harness: 'claude' }],
      ['commands', '', {}],
    ],
  );
  assert.deepEqual(await call('host:clone', 'box', { key: 'k' }), { value: { path: '/c', existed: false } });
  assert.deepEqual(await call('host:clone'), { value: { path: '/c', existed: false } });
  assert.deepEqual(await call('host:worktree', 'box', { key: 'k' }), { value: { path: '/w', existed: false } });
  assert.deepEqual(await call('host:worktree'), { value: { path: '/w', existed: false } });
  assert.deepEqual(await call('host:gitBranches', 'box', { path: '/p' }), { value: { isRepo: false } });
  assert.deepEqual(await call('host:gitSwitch', 'box', { path: '/p', branch: 'dev' }), { value: { ok: true, stderr: '' } });
  assert.deepEqual(
    calls.filter((c: any) => ['branches', 'switchBranch'].includes(c[0])),
    [
      ['branches', 'box', { path: '/p' }],
      ['switchBranch', 'box', { path: '/p', branch: 'dev' }],
    ],
  );
  assert.deepEqual(await call('host:bindFolder', 'c1', { hostId: 'box', folder: '/p' }), { value: undefined });
  assert.deepEqual(await call('host:bindFolder'), { value: undefined });
  assert.equal(made, 1);
  assert.deepEqual(calls[1], ['list', '', {}]);
  // the service gets the machines' sessions, the side map file, and the gate
  assert.equal(await opts.open('box', 'on-event'), 'session');
  assert.deepEqual(sessionCalls, [['box', 'on-event']]);
  assert.equal(opts.store.file, path.join('/ud', 'host-ownership.json'));
  assert.equal(opts.allowed(), true);
  assert.equal(typeof opts.watch, 'function');
  opts.onProgress({ hostId: 'box', key: 'k', phase: 'x', percent: 1 });
  assert.deepEqual(broadcasts, [['host:cloneProgress', { hostId: 'box', key: 'k', phase: 'x', percent: 1 }]]);
});

test('IPC: a refusal keeps its code and message; a bad request is shown, not reported as a crash', async () => {
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  register(
    ipcMain,
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({}) }),
      createFolders: () => ({
        list: async () => {
          throw Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' });
        },
        clone: async () => {
          throw Object.assign(new Error('Pick a folder.'), { name: 'SchemaError' });
        },
      }),
      allowed: () => true,
    },
  );
  assert.deepEqual(await handlers.get('host:fsList')({}, 'box', { path: '/etc' }), {
    error: { message: 'That folder is outside what this host shares.', code: 'outside_roots' },
  });
  assert.deepEqual(await handlers.get('host:clone')({}, 'box', {}), { error: { message: 'Pick a folder.' } });
});

test('IPC defaults make the real folder service when none is given', async () => {
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  register(
    ipcMain,
    { app: { getPath: () => os.tmpdir() }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => ({ session: async () => Promise.reject(new Error('no machine')) }), allowed: () => true },
  );
  assert.equal((await handlers.get('host:fsList')({}, 'box', {})).error.message, 'no machine');
});

test('L: a machine paired before Hosts had names keeps the one its Host gives; a later answer under another name is refused and nothing is signed for it', async (t) => {
  const w = world(t);
  const file = (dir: string) =>
    JSON.parse(fs.readFileSync(path.join(dir, 'host-registry.json'), 'utf8')).hosts.find((h: any) => h.id === 'box');
  const s = await w.m.session('box');
  s.close();
  assert.equal(w.m.row('box').hostKey, 'abababababababababababababababab', 'kept at the first proof');
  assert.equal(file(w.dirOf).hostKey, 'abababababababababababababababab', 'and saved');
  // the same name again: fine
  (await w.m.session('box')).close();
  // another Host answering for the machine: no proof is sent
  w.replies['host.challenge'] = { nonce: 'n', hostId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' };
  const sent = () => w.socks.flatMap((x) => x.log);
  await assert.rejects(w.m.session('box'), (e: any) => e.code === 'invalid' && /not the machine this app paired with/.test(e.message));
  assert.equal(
    sent().filter((m) => m === 'host.auth').length,
    2,
    'two proofs were made, for the Host the machine has, and none for the other',
  );
});
