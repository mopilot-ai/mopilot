// The owner's policy on this Mac (electron/host/ownerPolicy.cjs and its IPC, plan U2): kept in a private file, refused whole when invalid, sent to every machine when it changes and to one as its connection is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOwnerPolicy } = require('../electron/host/ownerPolicy.cjs');
const { policyCalls } = require('../electron/host/remotePolicy.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const setup = (hosts: Record<string, any>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-policy-'));
  const reported: Error[] = [];
  const file = path.join(dir, 'p.json');
  const policy = createOwnerPolicy({
    file,
    hostFor: (id: string) => hosts[id] ?? null,
    machineIds: () => Object.keys(hosts),
    report: (e: Error) => reported.push(e),
  });
  return { dir, file, policy, reported };
};

test('with nothing kept the defaults are the document; a corrupt file holds the defaults too', () => {
  const { policy, file, dir } = setup({});
  assert.equal(policy.get().permissionMax, 'full-access');
  fs.writeFileSync(file, '{nope');
  assert.equal(policy.get().permissionMax, 'full-access');
  fs.writeFileSync(file, '[]');
  assert.equal(policy.get().permissionMax, 'full-access');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set keeps the document privately and sends it to each machine; failures are told apart', async () => {
  const sent: any[] = [];
  const hosts = {
    ok: { policy: async (p: any) => (sent.push(p.doc), { generation: 'g1' }) },
    old: {
      policy: async () => {
        throw Object.assign(new Error('old'), { code: 'feature_missing' });
      },
    },
    broken: {
      policy: async () => {
        throw new Error('boom');
      },
    },
    away: null,
    noMethod: {},
  };
  const { policy, file, reported, dir } = setup(hosts);
  const out = await policy.set({ version: 1, permissionMax: 'default', junk: 1 });
  assert.equal(out.doc.permissionMax, 'default');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(policy.get().permissionMax, 'default');
  assert.deepEqual(
    sent.map((d) => d.permissionMax),
    ['default'],
  );
  assert.deepEqual(out.machines, [
    { id: 'ok', ok: true, generation: 'g1' },
    { id: 'old', ok: false, code: 'feature_missing' },
    { id: 'broken', ok: false, code: 'failed' },
    { id: 'away', ok: false, code: 'offline' },
    { id: 'noMethod', ok: false, code: 'offline' },
  ]);
  assert.equal(reported.length, 1, 'only the failure that is not an older Host is reported');
  await assert.rejects(policy.set({ version: 1, permissionMax: 'root' }), (e: any) => e.code === 'invalid');
  assert.equal(policy.get().permissionMax, 'default', 'an invalid document leaves the kept one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cloud machine’s document carries its cloud block, and no other machine’s does (plan C2)', async (t) => {
  const sent: Record<string, any> = {};
  const host = (id: string) => ({ policy: async (p: any) => ((sent[id] = p.doc), { generation: 'g' }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-policy-cloud-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cloud: Record<string, any> = { c1: { idleMinutes: 45, hoursPerDay: 6 }, c2: { idleMinutes: 30, hoursPerDay: null } };
  const policy = createOwnerPolicy({
    file: path.join(dir, 'p.json'),
    hostFor: (id: string) => host(id),
    machineIds: () => ['c1', 'c2', 'ssh1'],
    cloudOf: (id: string) => cloud[id] ?? null,
    report: () => undefined,
  });
  await policy.set({ version: 1, permissionMax: 'default' });
  assert.deepEqual(sent.c1.cloud, { idleMinutes: 45, hoursPerDay: 6 });
  assert.deepEqual(sent.c2.cloud, { idleMinutes: 30 }, 'no cap is no key');
  assert.equal('cloud' in sent.ssh1, false);
  assert.equal(sent.c1.permissionMax, 'default', 'the rest of the document is the owner’s');
  assert.equal('cloud' in policy.get(), false, 'the owner’s own document never holds it');
});

test('a connection being made is waited for before the document goes to it: a Host nobody connected to yet takes it once it answers (plan U2)', async () => {
  const { policy, dir } = setup({});
  const order: string[] = [];
  let up: () => void = () => undefined;
  const connecting = new Promise<void>((resolve) => (up = resolve));
  const host = {
    connect: () => connecting.then(() => void order.push('up')),
    policy: async () => (order.push('policy'), { generation: 'g' }),
  };
  const pending = policy.push('m1', host);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'nothing is sent to a connection that is not up');
  up();
  assert.deepEqual(await pending, { id: 'm1', ok: true, generation: 'g' });
  assert.deepEqual(order, ['up', 'policy']);
  // a connection that never comes up says why, and nothing is sent
  const down = {
    connect: () => Promise.reject(Object.assign(new Error('gone'), { code: 'host_unreachable' })),
    policy: async () => assert.fail('sent'),
  };
  assert.deepEqual(await policy.push('m1', down), { id: 'm1', ok: false, code: 'host_unreachable' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push sends to a connection being made without asking for another', async () => {
  const { policy, dir } = setup({});
  const got: any[] = [];
  const res = await policy.push('m1', { policy: async (p: any) => (got.push(p), { generation: 'gg' }) });
  assert.deepEqual(res, { id: 'm1', ok: true, generation: 'gg' });
  assert.equal(got[0].doc.version, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('policyCalls sends host.policy over the control channel', async () => {
  const calls: any[] = [];
  const { policy } = policyCalls((m: string, p: object) => (calls.push([m, p]), Promise.resolve({ generation: 'x' })));
  assert.deepEqual(await policy({ doc: { version: 1 } }), { generation: 'x' });
  assert.deepEqual(calls, [['host.policy', { doc: { version: 1 } }]]);
});

test('the IPC reads and replaces the document and a new connection is sent it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-policy-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const pushed: any[] = [];
  let onRemoteHost: any;
  const machineHost = { policy: async (p: any) => (pushed.push(p.doc), { generation: 'g' }) };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: (o: any) => {
        onRemoteHost = o.onRemoteHost;
        return {
          list: () => ({ machines: [{ id: 'm1' }], resolved: true }),
          hostFor: () => machineHost,
          row: () => null,
          onRowChange: () => () => undefined,
        };
      },
      createFolders: () => ({}),
      allowed: () => true,
    },
  );
  const call = (c: string, ...a: unknown[]) => handlers.get(c)({}, ...a);
  assert.equal((await call('host:ownerPolicy')).value.permissionMax, 'full-access');
  const set = await call('host:setOwnerPolicy', { version: 1, permissionMax: 'default' });
  assert.deepEqual(set.value.machines, [{ id: 'm1', ok: true, generation: 'g' }]);
  assert.equal((await call('host:ownerPolicy')).value.permissionMax, 'default');
  assert.equal((await call('host:setOwnerPolicy', { version: 3 })).error.code, 'invalid');
  // a connection made later is sent the kept document
  await call('host:machines');
  onRemoteHost('m1', machineHost);
  await new Promise((r) => setImmediate(r));
  assert.equal(pushed.at(-1).permissionMax, 'default');
});

test('the IPC gives a cloud machine’s settings from the machines list to the push', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-policy-ipc3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const sent: Record<string, any> = {};
  const hostOf = (id: string) => ({ policy: async (p: any) => ((sent[id] = p.doc), { generation: 'g' }) });
  const svc: any = {
    list: () => ({ machines: [{ id: 'c1', cloud: { idleMinutes: 20, hoursPerDay: null } }, { id: 'm1' }], resolved: true }),
    hostFor: hostOf,
    row: () => null,
    onRowChange: () => () => undefined,
  };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => svc, createFolders: () => ({}), allowed: () => true },
  );
  await handlers.get('host:setOwnerPolicy')({}, { version: 1 });
  assert.deepEqual(sent.c1.cloud, { idleMinutes: 20 });
  assert.equal('cloud' in sent.m1, false);
});

test('the IPC reports a machine that fails and treats a service without hostFor as offline', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-policy-ipc2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map<string, any>();
  const svc: any = { list: () => ({ machines: [{ id: 'm1' }], resolved: true }), row: () => null };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    { create: () => svc, createFolders: () => ({}), allowed: () => true },
  );
  const call = (c: string, ...a: unknown[]) => handlers.get(c)({}, ...a);
  assert.deepEqual((await call('host:setOwnerPolicy', { version: 1 })).value.machines, [{ id: 'm1', ok: false, code: 'offline' }]);
  await call('host:machines');
  svc.hostFor = () => ({
    policy: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual((await call('host:setOwnerPolicy', { version: 1 })).value.machines, [{ id: 'm1', ok: false, code: 'failed' }]);
});
