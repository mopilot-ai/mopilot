// The background Host on this Mac (H1): the same install steps over a local channel, its socket reached directly, its row and note, adding, updating and removing it behind host.local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundle, machine } from './support/host-install-kit.ts';

const require = createRequire(import.meta.url);
const L = require('../electron/host/localHost.cjs');
const { createInstaller } = require('../electron/host/install.cjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');
const { installProc } = require('../electron/platform/ports/proc.cjs');
const { EventEmitter } = require('node:events');

test('the install steps run for this Mac: its own id and name, no key sign-in, every command local', async () => {
  const m = machine({ 'uname -sm': { stdout: 'Darwin arm64\n' } });
  const added: any[] = [];
  const keyAccess = {
    probe: async () => assert.fail('no ssh'),
    ensure: async () => assert.fail('no key'),
  };
  const out = await createInstaller({
    channel: m.channel,
    bundle,
    registry: { add: (h: any) => added.push(h) },
    keyAccess,
  }).install(L.localAddress('me'));
  assert.equal(out.ok, true);
  assert.equal(out.id, L.LOCAL_ID);
  assert.ok(!out.steps.some((s: any) => s.id === 'key'));
  assert.equal(added[0].id, 'this-mac-host');
  assert.equal(added[0].name, 'This Mac · keeps running');
  assert.equal(added[0].address, 'local:me');
  assert.ok(m.commands().some((c: string) => c.includes('launchctl bootstrap')));
  assert.equal(L.isLocal('local:me'), true);
  assert.equal(L.isLocal('me@box'), false);
  assert.equal(L.isLocal(undefined), false);
  assert.equal(L.localAddress(), `local:${os.userInfo().username}`);
});

test('a local channel runs a shell command with its input and reports every outcome', async () => {
  const run = L.createLocalChannel({ env: () => process.env });
  assert.deepEqual(await run('local:x', 'echo out; echo err >&2'), {
    code: 0,
    stdout: 'out\n',
    stderr: 'err\n',
  });
  assert.equal((await run('local:x', 'cat', Buffer.from('typed'))).stdout, 'typed');
  assert.equal((await run('local:x', 'exit 3')).code, 3);
  const slow = await L.createLocalChannel({ timeoutMs: 20 })('local:x', 'sleep 5');
  assert.equal(slow.code, -1);
  assert.match(slow.stderr, /Timed out/);
  assert.equal((await L.createLocalChannel({ env: () => ({ PATH: '/nonexistent' }) })('local:x', 'ls')).code, 127);
});

test('a local channel whose shell cannot start, or fails, is a result', async () => {
  const fake = (spawn: any) => {
    const previous = installProc({ spawn } as any);
    return () => installProc(previous);
  };
  let undo = fake(() => {
    throw new Error('no fork');
  });
  assert.deepEqual(await L.createLocalChannel()('local:x', 'true'), {
    code: -1,
    stdout: '',
    stderr: 'no fork',
  });
  undo();
  undo = fake(() => {
    const c: any = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => undefined;
    setImmediate(() => {
      c.stderr.emit('data', Buffer.from('bad'));
      c.emit('error', new Error('exec failed'));
      c.emit('close', null);
    });
    return c;
  });
  assert.deepEqual(await L.createLocalChannel()('local:x', 'true'), {
    code: -1,
    stdout: '',
    stderr: 'bad\nexec failed',
  });
  undo();
});

test('routing sends a local address to this Mac and any other to ssh; the pool reaches a local socket directly', async () => {
  const seen: string[] = [];
  const route = L.routeChannel(
    async () => (seen.push('ssh'), { code: 0, stdout: '', stderr: '' }),
    async () => (seen.push('local'), { code: 0, stdout: '', stderr: '' }),
  );
  await route('me@box', 'x');
  await route('local:me', 'x');
  assert.deepEqual(seen, ['ssh', 'local']);
  let closed = 0;
  const pool = L.localPool({
    get: (t: any) => ({
      acquire: () => ({ socketPath: `tunnel:${t.destination}` }),
    }),
    closeAll: () => closed++,
  });
  const lease = pool.get({ destination: 'local:me', remoteSocket: '/h/host.sock' }).acquire();
  assert.equal(lease.socketPath, '/h/host.sock');
  assert.equal(await lease.ready, true);
  assert.equal(lease.release(), undefined);
  // the whole shape every tunnel has: the path switch and the connection read the state, listen for changes and may fail it
  const tunnel = pool.get({ destination: 'local:me', remoteSocket: '/h/host.sock' });
  assert.deepEqual([tunnel.localSocket, tunnel.state, tunnel.reason, tunnel.latencyMs], ['/h/host.sock', 'online', '', null]);
  assert.equal(typeof tunnel.onState(() => undefined), 'function');
  assert.equal(tunnel.onState(() => undefined)(), undefined);
  assert.equal(tunnel.fail('broken'), undefined);
  assert.equal(pool.get({ destination: 'me@box', remoteSocket: '/x' }).acquire().socketPath, 'tunnel:me@box');
  pool.closeAll();
  assert.equal(closed, 1);
  L.localPool({ get: () => null }).closeAll();
});

function fakeMachines(rows: any[]) {
  const calls: string[] = [];
  let listener: () => void = () => undefined;
  return {
    calls,
    rows,
    fire: () => listener(),
    machines: {
      add: async (d: string) => (calls.push(`add ${d}`), { ok: true, paired: true, error: '', id: 'this-mac-host', steps: [] }),
      updateHost: async (id: string) => {
        calls.push(`update ${id}`);
        if (rows[0]?.fail) throw new Error('nope');
      },
      uninstallHost: async (id: string, pw: string) => (calls.push(`uninstall ${id} [${pw}]`), { left: '' }),
      remove: (id: string) => calls.push(`remove ${id}`),
      list: () => ({ machines: rows }),
      onRowChange: (fn: () => void) => ((listener = fn), () => calls.push('off')),
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('add and remove are refused while host.local is off and run when it is on', async () => {
  let on = false;
  const f = fakeMachines([]);
  const host = L.createLocalHost({ machines: f.machines, enabled: () => on });
  await assert.rejects(async () => host.add(), { code: 'off' });
  await assert.rejects(host.remove(), { code: 'off' });
  assert.deepEqual(f.calls, []);
  on = true;
  assert.equal((await host.add()).paired, true);
  await host.remove();
  assert.deepEqual(f.calls, [`add ${L.localAddress()}`, 'uninstall this-mac-host []', 'remove this-mac-host']);
  host.dispose();
  assert.equal(f.calls.at(-1), 'off');
});

test('Remove keeps This Mac listed, with the cause, while its Host is left (a daemon, a Host that cannot say, one another row uses)', async () => {
  for (const [left, cause] of [
    ['daemon', /Keep running is on/],
    ['unsure', /Couldn’t tell whether the Host starts at boot/],
    ['shared', /Another machine in the list is, or may be, this Host/],
  ] as const) {
    const f = fakeMachines([]);
    f.machines.uninstallHost = async () => ({ left }) as any;
    const host = L.createLocalHost({ machines: f.machines, enabled: () => true });
    await assert.rejects(host.remove(), (e: any) => e.code === 'uninstall_incomplete' && cause.test(e.message));
    assert.ok(!f.calls.some((c) => c.startsWith('remove')), 'the row stays');
    host.dispose();
  }
});

test('a Host behind this app’s build is updated once, only while on, and a failed update is reported', async () => {
  let on = true;
  const reported: unknown[] = [];
  const f = fakeMachines([{ id: 'this-mac-host', hostStale: true }]);
  const host = L.createLocalHost({
    machines: f.machines,
    enabled: () => on,
    report: (e: unknown) => reported.push(e),
  });
  f.fire();
  f.fire(); // still updating: no second update
  await tick();
  assert.deepEqual(f.calls, ['update this-mac-host']);
  f.rows[0].update = 'running';
  host.sync();
  f.rows[0].update = undefined;
  f.rows[0].hostStale = undefined;
  host.sync(); // current: nothing
  f.rows.length = 0;
  host.sync(); // no machine: nothing
  f.rows.push({ id: 'this-mac-host', hostStale: true, fail: true });
  on = false;
  host.sync(); // off: nothing
  on = true;
  host.sync();
  await tick();
  assert.equal(f.calls.filter((c) => c.startsWith('update')).length, 2);
  assert.equal((reported[0] as Error).message, 'nope');
  // the default report is silent
  const quiet = fakeMachines([{ id: 'this-mac-host', hostStale: true, fail: true }]);
  L.createLocalHost({ machines: quiet.machines, enabled: () => true }).sync();
  await tick();
});

test('#4923: a Host newer than this app (another, newer MoPilot put it there) is never replaced by this app’s older build', async () => {
  const f = fakeMachines([{ id: 'this-mac-host', hostNewer: true }]);
  const host = L.createLocalHost({ machines: f.machines, enabled: () => true });
  host.sync();
  await tick();
  assert.deepEqual(f.calls, []);
});

test('the machine list gives this Mac’s Host the app-open note and every other machine its own', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ready = {
    harnesses: [{ id: 'claude', detected: true, signedIn: true }],
    capabilities: { shell: true },
  };
  const call = async () => ready;
  const registry = createRegistry({
    file: path.join(dir, 'r.json'),
    status: call,
  });
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => true,
    watch: () => () => undefined,
    call,
    installer: { install: async () => null },
    registry,
  });
  t.after(() => m.dispose());
  registry.add({
    id: L.LOCAL_ID,
    name: L.LOCAL_NAME,
    address: 'local:me',
    socketPath: '/h/host.sock',
    capabilities: {},
    harnesses: ready.harnesses,
  });
  registry.add({
    id: 'ssh:me@box',
    name: 'box',
    address: 'me@box',
    socketPath: '/h/host.sock',
    capabilities: {},
    harnesses: ready.harnesses,
  });
  await registry.check();
  const rows = m.list().machines;
  const local = rows.find((r: any) => r.id === L.LOCAL_ID);
  assert.equal(local.name, 'This Mac · keeps running');
  assert.equal(local.note, 'Browser tools need the app open');
  assert.notEqual(rows.find((r: any) => r.id === 'ssh:me@box').note, L.LOCAL_NOTE);
});

test('IPC: addLocal and removeLocal follow the host.local flag, and a Host behind the app’s build is updated and a failure noted', async () => {
  const { register } = require('../electron/app/ipc/host.cjs');
  const handlers = new Map<string, any>();
  const calls: string[] = [];
  let on = false;
  const quits: (() => void)[] = [];
  let fire: () => void = () => undefined;
  const svc: any = {
    list: () => ({
      machines: [{ id: 'this-mac-host', hostStale: true }],
      resolved: true,
    }),
    add: async (d: string) => (calls.push(`add ${d}`), { ok: true }),
    updateHost: async () => {
      calls.push('update');
      throw new Error('stuck');
    },
    uninstallHost: async () => (calls.push('uninstall'), { left: '' }),
    remove: () => calls.push('remove'),
    onRowChange: (fn: () => void) => ((fire = fn), () => undefined),
    dispose: () => undefined,
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    {
      app: { getPath: () => '/ud', once: (_e: string, fn: () => void) => quits.push(fn) },
      shellEnv: { childEnv: () => ({}) },
      broadcastAll: () => undefined,
    },
    { create: () => svc, allowed: () => true, localOn: () => on },
  );
  const call = (c: string) => handlers.get(c)({});
  assert.equal((await call('host:addLocal')).error.code, 'off');
  on = true;
  assert.deepEqual(await call('host:addLocal'), { value: { ok: true } });
  assert.deepEqual(await call('host:removeLocal'), { value: undefined });
  fire();
  await tick();
  await tick();
  assert.deepEqual(calls, [`add ${L.localAddress()}`, 'uninstall', 'remove', 'update']);
  for (const quit of quits) quit();
});

test('IPC: without a test override the host.local flag decides, and it ships on', async () => {
  const { register } = require('../electron/app/ipc/host.cjs');
  const { DEFAULTS } = require('../electron/platform/flags.cjs');
  assert.equal(DEFAULTS['host.local'], true);
  const handlers = new Map<string, any>();
  const calls: string[] = [];
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({
        onRowChange: () => () => undefined,
        list: () => ({ machines: [], resolved: true }),
        add: async (d: string) => (calls.push(d), { ok: true }),
      }),
      allowed: () => true,
    },
  );
  // the shipped default lets the call through to the install: nothing refuses it as `off`
  assert.deepEqual(await handlers.get('host:addLocal')({}), { value: { ok: true } });
  assert.deepEqual(calls, [L.localAddress()]);
});
