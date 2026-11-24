// Main's machines service (electron/host/machines.cjs) and its IPC (electron/app/ipc/host.cjs): heartbeats only while Host access is open (A3, A5), the list the windows draw, add = install + pair, a failed pairing leaving the machine listed, the code pasted by hand, and requests over a tunnel (B1, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { useFakeProc } from './support/ports/proc.ts';
const require = createRequire(import.meta.url);
import { createMachines, openKeyFile, requestOverSocket } from './support/hostKeySafe.ts';
const { register } = require('../electron/app/ipc/host.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const frames = require('../shared/host/frames.mjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
const dirOf = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function world(t: any, o: { allowed?: boolean; call?: any; installer?: any } = {}) {
  const clock = installFakeClock(t, 1_000_000);
  const gate = { allowed: o.allowed ?? true, fns: new Set<(ok: boolean) => void>() };
  const dir = dirOf(t);
  const changes: any[] = [];
  const steps: any[] = [];
  const calls: any[] = [];
  const call =
    o.call ??
    (async (record: any, method: string, params: any) => {
      calls.push([record.id, method, params]);
      if (method === 'status') return ready;
      if (method === 'host.challenge') return { nonce: 'n', hostId: 'abababababababababababababababab' };
      if (method === 'host.pair') return { fingerprint: 'f' };
      throw new Error('no such method');
    });
  const installs: string[] = [];
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => gate.allowed,
    watch: (fn: any) => gate.fns.add(fn),
    call,
    onChange: (s: any) => changes.push(s),
    onStep: (e: any) => steps.push(e),
    installer: o.installer ?? {
      install: async (destination: string, onStep: any) => {
        installs.push(destination);
        onStep({ id: 'connect', state: 'ok' });
        registryRef.current?.add({ id: `ssh:${destination}`, name: 'box', address: destination, socketPath: '/h/host.sock' });
        return { ok: true, id: `ssh:${destination}`, pairingCode: 'ABCD-EFGH-JKMN', steps: [{ id: 'connect', state: 'ok' }] };
      },
    },
    registry: registryRef.make(dir, call),
  });
  t.after(() => m.dispose());
  return {
    m,
    clock,
    gate,
    dir,
    changes,
    steps,
    calls,
    installs,
    set: (ok: boolean) => ((gate.allowed = ok), [...gate.fns].forEach((f) => f(ok))),
  };
}
/** The registry the fake installer adds to, as the real installer does. */
const registryRef = {
  current: null as any,
  make(dir: string, call: any) {
    this.current = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
    return this.current;
  },
};
const tick = () => new Promise((r) => setImmediate(r));

test('with access open the heartbeat runs and the list shows each machine, its dot, and a one-line note', async (t) => {
  const w = world(t);
  assert.deepEqual(w.m.list(), { machines: [], resolved: true });
  registryRef.current.add({ id: 'h1', name: 'build-box', address: 'me@box', socketPath: '/h/host.sock' });
  assert.deepEqual(w.m.list().resolved, false, 'nothing has answered yet');
  w.clock.advance(30_000);
  await tick();
  assert.deepEqual(w.m.list(), {
    machines: [
      {
        id: 'h1',
        name: 'build-box',
        rawName: 'build-box',
        status: 'online',
        note: 'SSH · Claude Code',
        capabilities: { iab: false, cu: false, desktop: false, bu: false, shell: true },
        agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
        installable: [],
        lastSeen: 1_030_000,
        localNetwork: 'unknown', // an older Host says nothing of the local network, boot or system; nobody waits for a sign-in
        waitingForLogin: null,
        startsAtBoot: 'unknown',
        fileVault: 'unknown',
        ...{ platform: '', address: 'me@box', hostVersion: '' },
      },
    ],
    resolved: true,
  });
  assert.ok(w.changes.length > 0, 'a window is told');
});

test('a machine that needs a sign-in shows amber with its reason; a machine with no agent info says so', async (t) => {
  const w = world(t, { call: async () => ({ harnesses: [{ id: 'codex', detected: true, signedIn: false }], capabilities: {} }) });
  registryRef.current.add({ id: 'h1', name: 'lab', address: 'me@lab', socketPath: '/s' });
  registryRef.current.add({ id: 'h2', name: 'new', address: 'me@new', socketPath: '/s' });
  await w.m.list();
  w.clock.advance(30_000);
  await tick();
  assert.deepEqual(
    w.m.list().machines.map((x: any) => [x.status, x.note]),
    [
      ['attention', 'codex is not signed in on this machine.'],
      ['attention', 'codex is not signed in on this machine.'],
    ],
  );
  registryRef.current.add({ id: 'h3', name: 'raw', address: 'me@raw' });
  assert.equal(w.m.list().machines.at(-1).note, 'Not reached yet.');
  assert.equal(w.m.list().machines.at(-1).status, 'offline');
});

test('losing access stops the heartbeat and hides the list, regaining it starts again (A3, A5)', async (t) => {
  const w = world(t);
  registryRef.current.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/s' });
  w.clock.advance(30_000);
  await tick();
  assert.equal(w.m.list().machines.length, 1);
  const before = w.calls.length;
  w.set(false);
  assert.deepEqual(w.m.list().machines, []);
  w.clock.advance(120_000);
  await tick();
  assert.equal(w.calls.length, before, 'no beat without access');
  await assert.rejects(w.m.add('me@box'), (e: any) => e.code === 'not_allowed');
  await assert.rejects(w.m.pair('h1', 'x'), (e: any) => e.code === 'not_allowed');
  assert.throws(
    () => w.m.remove('h1'),
    (e: any) => e.code === 'not_allowed',
  );
  w.set(true);
  w.clock.advance(30_000);
  await tick();
  assert.ok(w.calls.length > before);
});

test('no heartbeat starts when the service is made before access is open', async (t) => {
  const w = world(t, { allowed: false });
  registryRef.current.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/s' });
  w.clock.advance(120_000);
  await tick();
  assert.equal(w.calls.length, 0);
});

test('add installs, pairs with the code the install returned, and the machine goes green', async (t) => {
  const w = world(t);
  const out = await w.m.add('me@box');
  assert.deepEqual([out.ok, out.paired, out.error, out.id], [true, true, '', 'ssh:me@box']);
  assert.deepEqual(
    w.calls.map((c) => c[1]),
    ['host.challenge', 'host.pair', 'status'],
  );
  assert.equal(w.calls[1][2].code, 'ABCDEFGHJKMN', 'the code goes in normalized');
  // L: the machine's Host is known by the name it gave while pairing
  assert.equal(registryRef.current.hostKey('ssh:me@box'), 'abababababababababababababababab');
  assert.equal(w.m.list().machines[0].status, 'online');
  assert.deepEqual(w.steps, [{ destination: 'me@box', step: { id: 'connect', state: 'ok' } }]);
  const key = openKeyFile(path.join(w.dir, 'host-client-key.json'));
  assert.ok(key.publicKey);
});

test('an install that fails is reported and nothing is paired', async (t) => {
  const w = world(t, { installer: { install: async () => ({ ok: false, id: '', error: 'Node 22 or newer is needed', steps: [] }) } });
  const out = await w.m.add('me@box');
  assert.deepEqual([out.ok, out.paired, out.error], [false, false, 'Node 22 or newer is needed']);
  assert.deepEqual(w.calls, []);
});

test('a machine that installed but would not pair stays listed, and the pasted code pairs it later', async (t) => {
  let refuse = true;
  const w = world(t, {
    call: async (_r: any, method: string) => {
      if (method === 'host.challenge') return { nonce: 'n', hostId: 'abababababababababababababababab' };
      if (method === 'host.pair') {
        if (refuse) throw Object.assign(new Error('That is not the pairing code.'), { code: 'wrong_code' });
        return { fingerprint: 'f' };
      }
      return ready;
    },
  });
  const out = await w.m.add('me@box');
  assert.deepEqual([out.ok, out.paired, out.error], [true, false, 'That is not the pairing code.']);
  assert.equal(w.m.list().machines.length, 1);
  await assert.rejects(w.m.pair('ssh:me@box', 'WRONG'), /not the pairing code/);
  refuse = false;
  await w.m.pair('ssh:me@box', 'abcd-efgh-jkmn');
  assert.equal(w.m.list().machines[0].status, 'online');
  await assert.rejects(w.m.pair('nope', 'x'), (e: any) => e.code === 'unknown_machine');
  await assert.rejects(w.m.pair('ssh:me@box', ''), /Enter the pairing code/);
});

test('remove drops a machine and tells the windows', async (t) => {
  const w = world(t);
  await w.m.add('me@box');
  const n = w.changes.length;
  w.m.remove('ssh:me@box');
  assert.deepEqual(w.m.list().machines, []);
  assert.ok(w.changes.length > n);
});

class Sock extends EventEmitter {
  written: any[] = [];
  destroyed = false;
  write(b: Buffer) {
    this.written.push(frames.createDecoder().push(b)[0].message);
  }
  destroy() {
    this.destroyed = true;
  }
}
test("a request over the tunnel resolves the result and rejects with the Host's error and code (B1, B2)", async (t) => {
  const clock = installFakeClock(t);
  const ask = (script: (s: Sock) => void) => {
    const s = new Sock();
    const p = requestOverSocket({ socketPath: '/x' }, 'status', { a: 1 }, () => s as any);
    s.emit('connect');
    script(s);
    return { p, s };
  };
  const reply = (s: Sock, msg: object) => s.emit('data', frames.encodeControl(msg));
  let r = ask((s) => reply(s, { id: 1, result: { ok: 1 } }));
  assert.deepEqual(await r.p, { ok: 1 });
  assert.deepEqual(r.s.written[0], { id: 1, method: 'status', params: { a: 1 } });
  assert.ok(r.s.destroyed);
  r = ask(
    (s) => (
      reply(s, { id: 9, result: 'other' }),
      s.emit('data', frames.encodeBinary({ k: 1 }, Buffer.from('x'))),
      reply(s, { id: 1, error: { message: 'no', code: 'wrong_code' } })
    ),
  );
  await assert.rejects(r.p, (e: any) => e.message === 'no' && e.code === 'wrong_code');
  r = ask((s) => reply(s, { id: 1, error: 'plain' }));
  await assert.rejects(r.p, (e: any) => e.message === 'plain' && e.code === undefined);
  r = ask((s) => reply(s, { id: 1, error: 7, code: 'c' }));
  await assert.rejects(r.p, (e: any) => e.code === 'c');
  r = ask((s) => reply(s, { id: 1, error: {} }));
  await assert.rejects(r.p, /The machine refused/);
  r = ask((s) => s.emit('data', Buffer.from('this is not json\n')));
  await assert.rejects(r.p, /cannot read/);
  r = ask((s) => s.emit('error', new Error('ECONNRESET')));
  await assert.rejects(r.p, /ECONNRESET/);
  r = ask((s) => s.emit('close'));
  await assert.rejects(r.p, /closed the connection/);
  r = ask(() => undefined);
  clock.advance(15_000);
  await assert.rejects(r.p, { message: /did not answer/, code: 'host_unreachable' });
  // a late answer after it settled changes nothing
  const late = ask((s) => s.emit('close'));
  await assert.rejects(late.p);
  reply(late.s, { id: 1, result: 'late' });
});

test('the default request goes through the tunnel pool: a lease, the socket, a release; no socket on record is refused; an unreachable tunnel too (B1, B2)', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = dirOf(t);
  const events: string[] = [];
  let up = true;
  const pool = {
    get: (target: any) => (
      events.push(`get ${target.destination} ${target.remoteSocket}`),
      {
        acquire: () => ({
          socketPath: '/local.sock',
          ready: up ? Promise.resolve(true) : new Promise(() => {}),
          release: () => events.push('release'),
        }),
      }
    ),
  };
  const sock = new Sock();
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    pool,
    connect: () => sock as any,
    installer: { install: async () => ({ ok: false, id: '', error: '', steps: [] }) },
  });
  t.after(() => m.dispose());
  // reach it through the registry's status call
  const reg = createRegistry({ file: path.join(dir, 'host-registry.json') });
  reg.dispose();
  const saved = JSON.stringify({
    version: 1,
    hosts: [
      { id: 'h1', name: 'box', address: 'me@box', socketPath: '/h/host.sock' },
      { id: 'h2', name: 'bare', address: 'me@bare' },
    ],
  });
  fs.writeFileSync(path.join(dir, 'host-registry.json'), saved);
  const again = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    pool,
    connect: () => sock as any,
    installer: { install: async () => ({}) },
  });
  t.after(() => again.dispose());
  await tick();
  sock.emit('connect');
  sock.emit('data', frames.encodeControl({ id: 1, result: ready }));
  await tick();
  await tick();
  assert.deepEqual(events.slice(0, 2), ['get me@box /h/host.sock', 'release']);
  assert.equal(again.list().machines.find((x: any) => x.id === 'h2').note, 'Unreachable: This machine has no Host socket on record.');
  up = false;
  again.dispose();
  fs.writeFileSync(path.join(dir, 'host-registry.json'), saved);
  const third = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    pool,
    connect: () => sock as any,
    installer: { install: async () => ({}) },
  });
  t.after(() => third.dispose());
  await tick();
  clock.advance(15_000);
  await tick();
  await tick();
  assert.match(third.list().machines.find((x: any) => x.id === 'h1').note, /Could not reach the machine over SSH/);
});

test('IPC: the list and every action are refused while Host is not allowed; the service is made only when a window first asks', async (t) => {
  let allowed = false;
  const handlers = new Map<string, any>();
  const ipcMain = { handle: (c: string, fn: any) => handlers.set(c, fn) };
  let made = 0;
  const svc: any = {
    list: () => ({ machines: [{ id: 'a' }], resolved: true }),
    add: async (d: string) => ({ ok: true, d }),
    pair: async (id: string, code: unknown) => ({ id, code }),
    remove: (id: string) => id,
  };
  const broadcasts: any[] = [];
  let opts: any;
  register(
    ipcMain,
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({ PATH: '/x' }) }, broadcastAll: (...a: any[]) => broadcasts.push(a) },
    { create: (o: any) => ((opts = o), made++, svc), allowed: () => allowed },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  assert.equal(await call('host:access'), false);
  assert.deepEqual(await call('host:machines'), { machines: [], resolved: true });
  for (const c of ['host:add', 'host:pair', 'host:remove']) assert.equal((await call(c, 'x', 'y')).error.code, 'not_allowed');
  assert.equal(made, 0);
  allowed = true;
  assert.equal(((await call('host:machines')) as any).machines[0].id, 'a');
  assert.deepEqual(await call('host:add', 'me@box'), { value: { ok: true, d: 'me@box' } });
  assert.deepEqual(await call('host:add'), { value: { ok: true, d: '' } });
  assert.deepEqual(await call('host:pair', 'h', 'c'), { value: { id: 'h', code: 'c' } });
  assert.deepEqual(await call('host:pair'), { value: { id: '', code: undefined } });
  assert.deepEqual(await call('host:remove', 'h'), { value: 'h' });
  assert.deepEqual(await call('host:remove'), { value: '' });
  assert.equal(made, 1, 'one service for every window');
  assert.equal(opts.dir, '/ud');
  assert.deepEqual(opts.env(), { PATH: '/x' });
  opts.onChange({ machines: [] });
  opts.onStep({ destination: 'd' });
  assert.deepEqual(broadcasts, [
    ['host:machines', { machines: [] }],
    ['host:installStep', { destination: 'd' }],
  ]);
  // a failure carries its message and code; an unexpected one is reported, its text kept
  svc.add = async () => {
    throw Object.assign(new Error('boom'), { code: 'unknown_machine' });
  };
  assert.deepEqual(await call('host:add', 'x'), { error: { message: 'boom', code: 'unknown_machine' } });
  svc.add = async () => {
    throw 'plain';
  };
  assert.equal((await call('host:add', 'x')).error.message, 'Something went wrong.');
  svc.add = async () => {
    throw new Error('disk full');
  };
  assert.deepEqual(await call('host:add', 'x'), { error: { message: 'disk full' } });
});

test('defaults: the registry reports a corrupt file, an install runs ssh in the process environment, a request connects a real socket, and a disposed service ignores the gate', async (t) => {
  installFakeClock(t, 1_000_000);
  const dir = dirOf(t);
  fs.writeFileSync(path.join(dir, 'host-registry.json'), '{corrupt');
  const spawned: any[] = [];
  useFakeProc(t, {
    spawn: (_bin: string, _args: string[], opts: any) => {
      spawned.push(opts.env);
      throw new Error('no ssh here');
    },
  });
  const gate: ((ok: boolean) => void)[] = [];
  const pool = {
    get: () => ({
      acquire: () => ({ socketPath: path.join(dir, 'no-such.sock'), ready: Promise.resolve(true), release: () => undefined }),
    }),
  };
  let closed = 0;
  const m = createMachines({ dir, allowed: () => true, watch: (fn: any) => gate.push(fn), pool: { ...pool, closeAll: () => closed++ } });
  assert.deepEqual(m.list(), { machines: [], resolved: true, registryUnreadable: true }, 'the list reports the unreadable registry');
  const out = await m.add('me@box');
  assert.equal(out.ok, false);
  assert.equal(spawned[0], process.env, 'ssh runs in the environment it was given, the process one by default');
  // a machine with a socket is asked over a real (absent) socket and the failure becomes its note
  fs.writeFileSync(
    path.join(dir, 'host-registry.json'),
    JSON.stringify({ hosts: [{ id: 'h', name: 'h', address: 'me@h', socketPath: '/s' }] }),
  );
  const second = createMachines({ dir, allowed: () => true, watch: () => undefined, pool });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(second.list().machines[0].note, /Unreachable/);
  m.dispose();
  assert.equal(closed, 1, 'quitting stops ssh whoever holds a lease');
  const n = m.list().machines.length;
  gate[0](false);
  assert.equal(m.list().machines.length, n);
  second.dispose();
});

test('capabilities(id): what the machine declared; a machine that is not listed can do nothing', async (t) => {
  const w = world(t);
  registryRef.current.add({ id: 'h1', name: 'build-box', address: 'me@box', socketPath: '/h/host.sock' });
  w.clock.advance(30_000);
  await tick();
  assert.deepEqual(w.m.capabilities('h1'), { iab: false, cu: false, desktop: false, bu: false, shell: true });
  assert.deepEqual(w.m.capabilities('gone'), { iab: false, cu: false, desktop: false, bu: false, shell: false });
});

test('IPC: live.hostCapabilitiesOf is no limit for a local chat or while Host is off, and the owner machine’s capabilities for a remote chat', async (t) => {
  let allowed = false;
  const dir = dirOf(t);
  const live: any = {};
  const svc: any = {
    list: () => ({ machines: [], resolved: true }),
    capabilities: (id: string) => ({ iab: true, cu: false, bu: false, shell: id === 'box' }),
  };
  let made = 0;
  register(
    { handle: () => undefined },
    { live, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => (made++, svc), allowed: () => allowed },
  );
  assert.equal(live.hostCapabilitiesOf('c1'), null, 'gate closed');
  assert.equal(made, 0);
  allowed = true;
  assert.equal(live.hostCapabilitiesOf('c1'), null, 'a chat nobody moved is local');
  assert.equal(made, 0, 'no service for a local chat');
  const { OwnershipStore } = require('../electron/host/ownership.cjs');
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'box', ownerHostId: 'box', epoch: 1 });
  assert.deepEqual(live.hostCapabilitiesOf('c1'), { iab: true, cu: false, bu: false, shell: true }, 'read again, not cached');
  register({ handle: () => undefined }, undefined, { create: () => svc, allowed: () => true });
});

test('hostFor: one connection per machine in the list, none for a stranger or a machine with no socket, ended with the machine and with the gate', async (t) => {
  const w = world(t);
  registryRef.current.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/s' });
  registryRef.current.add({ id: 'h2', name: 'raw', address: 'me@raw' });
  const a = w.m.hostFor('h1');
  assert.equal(w.m.hostFor('h1'), a, 'one connection for every caller');
  assert.equal(a.hostInfo().id, 'h1');
  assert.equal(w.m.hostFor('nope'), null);
  assert.equal(w.m.hostFor('h2'), null, 'a socket is never guessed');
  assert.equal(w.m.row('h1').id, 'h1');
  assert.equal(w.m.row('nope'), undefined);
  let told = 0;
  const off = w.m.onRowChange(() => void told++);
  registryRef.current.add({ id: 'h3', name: 'third', address: 'me@third', socketPath: '/s3' });
  assert.equal(told, 1, 'a change of the registry reaches a row listener');
  off();
  registryRef.current.remove('h3');
  assert.equal(told, 1, 'a listener that stopped is not told');
  w.m.remove('h1');
  await assert.rejects(a.subscribe('c'), /disposed/, 'removing the machine ends its connection');
  registryRef.current.add({ id: 'h1', name: 'box', address: 'me@box', socketPath: '/s' });
  const b = w.m.hostFor('h1');
  assert.notEqual(b, a);
  w.set(false);
  assert.equal(w.m.hostFor('h1'), null, 'no connection while Host access is off');
  await assert.rejects(b.subscribe('c'), /disposed/);
  w.set(true);
  const c = w.m.hostFor('h1');
  w.m.dispose();
  await assert.rejects(c.subscribe('c'), /disposed/);
  assert.equal(w.m.hostFor('h1'), null, 'nor after the service ends');
});
