// Chat ownership and cloud machines' IPC (electron/app/ipc/hostCloud.cjs, registered by ipc/host.cjs): the owner channels, each cloud channel reaching the service (refused while host.cloud is off), the service made on first use from the machines service, and the wake and the lost-Host check wired into the send path and the continue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { registerHostCloud } = require('../electron/app/ipc/hostCloud.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const crypt = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};

function setup(over: { enabled?: boolean; carry?: any } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-ipc-'));
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', {
    hostId: 'relay:h1',
    ownerHostId: 'relay:h1',
    epoch: 1,
    folder: null,
  });
  const handlers = new Map<string, any>();
  const raw = new Map<string, any>();
  const said: any[] = [];
  const forks: any[] = [];
  const rows = [{ id: 'relay:h1', status: 'offline', cloud: { provider: 'oci', id: 'x', region: 'r' } }];
  const svc = { list: () => ({ machines: rows }), boot: { fork: (onView: any) => (forks.push(onView), { start: async () => ({}) }) } };
  const api = registerHostCloud({
    handle: (c: string, fn: any) => handlers.set(c, fn),
    ipcMain: { handle: (c: string, fn: any) => raw.set(c, fn) },
    service: () => svc,
    deps: () => ({ app: { getPath: () => dir }, broadcastAll: (...a: any[]) => said.push(a) }),
    allowed: () => true,
    safeStorage: () => crypt,
    enabled: () => over.enabled ?? true,
    carry: over.carry,
  });
  return { api, handlers, raw, said, forks, dir, svc };
}

test('the owner channels answer for the chats the ownership file holds', async () => {
  const s = setup();
  assert.deepEqual(await s.raw.get('host:remoteChats')!(), [{ chatId: 'c1', hostId: 'relay:h1' }]);
  assert.equal((await s.raw.get('host:owner')!({}, 'c1')).hostId, 'relay:h1');
});

test('with the flag off every cloud channel is refused by the service, and the wake and the check stand down', async () => {
  const s = setup({ enabled: false });
  for (const [channel, args] of [
    ['host:cloudProviders', []],
    ['host:cloudSetKey', ['oci', {}]],
    ['host:cloudRemoveKey', ['oci']],
    ['host:cloudCheck', ['oci']],
    ['host:cloudOptions', ['oci']],
    ['host:cloudLaunch', [{}]],
    ['host:cloudStop', ['relay:h1']],
    ['host:cloudPlan', ['relay:h1']],
    ['host:cloudDelete', ['relay:h1']],
  ] as const)
    await assert.rejects(
      Promise.resolve().then(() => s.handlers.get(channel)!(...args)),
      (e: any) => e.code === 'not_enabled',
      channel,
    );
  assert.deepEqual(await s.handlers.get('host:cloudWake')!('relay:h1'), { state: 'off' });
  assert.equal(await s.handlers.get('host:cloudLine')!('relay:h1'), null);
  assert.equal(s.handlers.get('host:cloudCancel')!('l_1'), false);
  assert.deepEqual(await s.api.wake('relay:h1'), { state: 'off' });
});

test('with the flag on the channels reach the service: keys, the sheet, plan with the chats on the machine, and a boot of its own per creation', async () => {
  const s = setup();
  assert.equal((await s.handlers.get('host:cloudProviders')!())[0].hasKey, false);
  assert.throws(() => s.handlers.get('host:cloudSetKey')!('oci', {}), /missing/);
  assert.equal(s.handlers.get('host:cloudRemoveKey')!('oci'), false);
  assert.equal((await s.handlers.get('host:cloudCheck')!('oci')).code, 'no_key');
  await assert.rejects(s.handlers.get('host:cloudOptions')!('oci'), (e: any) => e.code === 'no_key');
  await assert.rejects(s.handlers.get('host:cloudLaunch')!(), (e: any) => e.code === 'no_key');
  assert.deepEqual(await s.handlers.get('host:cloudWake')!('nope'), { state: 'not-cloud' });
  await assert.rejects(s.handlers.get('host:cloudStop')!('nope'), (e: any) => e.code === 'not_cloud');
  const plan = s.handlers.get('host:cloudPlan')!('relay:h1');
  assert.deepEqual(plan.chats, [{ chatId: 'c1', title: 'c1', folder: null }]);
  await assert.rejects(
    s.handlers.get('host:cloudDelete')!('relay:h1', { token: plan.token, carry: ['c1'] }),
    (e: any) => e.code === 'no_key',
  );
  await assert.rejects(s.handlers.get('host:cloudDelete')!('relay:h1'), (e: any) => e.code === 'plan_changed' || e.code === 'no_key');
  assert.equal(s.handlers.get('host:cloudLine')!('relay:h1'), null);
  // a stopping Host is told to the window
  const lost = await s.api.lostCheck('relay:h1');
  assert.equal(lost?.code, 'source_unknown');
  assert.deepEqual(await s.api.lostCheck('ssh:box'), null);
});

test('a creation gets a boot of its own and its events reach the window', async () => {
  const s = setup();
  s.handlers.get('host:cloudSetKey')!('oci', {
    tenancy: 't',
    user: 'u',
    fingerprint: 'f',
    region: 'r',
    compartmentId: 'c',
    subnetId: 's',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  });
  // the launch fails at the provider call (no network is reached: the key is not a usable key), but its boot and its event were made first
  const run = s.handlers.get('host:cloudLaunch')!({ provider: 'oci', name: 'n', size: 'VM.Standard.A1.Flex:1:6', region: 'r' }).catch(
    (e: any) => e,
  );
  await run;
  assert.equal(s.said[0][0], 'host:cloud');
  assert.equal(s.said[0][1].kind, 'launch');
});

test('the app wires the wake into the send path and the lost-Host check into the continue', async () => {
  const handlers = new Map<string, any>();
  let sendOpts: any;
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn), removeHandler: () => undefined },
    { app: { getPath: () => os.tmpdir() }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined, live: {} },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }),
      createFolders: () => ({}),
      allowed: () => true,
      makeRemoteSend: (o: any) => ((sendOpts = o), () => null),
    },
  );
  await handlers.get('host:machines')!({});
  assert.equal(typeof sendOpts.wake, 'function');
  assert.deepEqual(await sendOpts.wake('relay:h1'), { state: 'off' });
  assert.ok(handlers.has('host:cloudLaunch'));
});

test('without the app services the owner files are looked for in no folder, and without safeStorage the service still stands', async () => {
  const handlers = new Map<string, any>();
  registerHostCloud({
    handle: (c: string, fn: any) => handlers.set(c, fn),
    ipcMain: { handle: () => undefined },
    service: () => ({ list: () => ({ machines: [] }), boot: { fork: () => ({}) } }),
    deps: () => undefined,
    allowed: () => false,
    safeStorage: () => undefined,
    enabled: () => true,
  });
  assert.equal((await handlers.get('host:cloudProviders')!())[0].hasKey, false);
  await assert.rejects(handlers.get('host:cloudDelete')!('x'), (e: any) => e.code === 'not_cloud');
});

test('the machines list carries a cloud record and leaves it off other machines', async (t) => {
  const { createMachines } = require('../electron/host/machines.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => ({ harnesses: [], capabilities: {} }),
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  assert.equal(typeof m.boot.fork, 'function');
  const registry = require('../electron/host/registry.cjs').createRegistry({ file: path.join(dir, 'host-registry.json') });
  t.after(() => registry.dispose());
  registry.add({
    id: 'relay:c',
    name: 'cloud',
    address: 'relay:c',
    cloud: { provider: 'oci', id: 'x', region: 'r', size: 's', network: 'full' },
  });
  registry.add({ id: 'ssh:a', name: 'a', address: 'a' });
  const m2 = createMachines({
    dir,
    registry,
    allowed: () => true,
    watch: () => undefined,
    call: async () => ({}),
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({}) },
  });
  t.after(() => m2.dispose());
  const rows = m2.list().machines;
  assert.equal(rows.find((r: any) => r.id === 'relay:c').cloud.id, 'x');
  assert.equal('cloud' in rows.find((r: any) => r.id === 'ssh:a'), false);
});
