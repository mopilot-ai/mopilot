// A machine's connected Host for its browser (electron/host/machines.cjs `connectedHost`, `onRemoteEnd`, `hostOwnership`; package 2.6): the connection is begun at the first ask and used at the next, requests carry the chat's epoch from the ownership record, and whatever was built on a connection goes when it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { FEATURES } from '../shared/host/schema.mjs';
import { hostWorld, tick } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

const record = {
  id: 'ssh:box',
  name: 'box',
  address: 'me@box',
  socketPath: '/h/host.sock',
  harnesses: [] as any[],
  capabilities: {},
  startup: { atBoot: 'unknown', fileVault: 'unknown' },
  platform: '',
};
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};

function setup(t: any) {
  const w = hostWorld(t);
  // every connection proves the app's key first
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: 'abababababababababababababababab' });
  w.net.handlers['host.auth'] = () => ({ fingerprint: 'f' });
  w.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...FEATURES] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = { allowed: true, fns: new Set<(ok: boolean) => void>() };
  const records: any[] = [record];
  const registry: any = {
    list: () => records,
    resolved: () => true,
    onChange: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    check: async () => undefined,
    remove: () => undefined,
  };
  const ended: string[] = [];
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    registry,
    installer: {} as any,
    allowed: () => gate.allowed,
    watch: (fn: any) => (gate.fns.add(fn), () => undefined),
    pool: { get: () => w.tunnel() } as any,
    connect: w.net.connect,
    onRemoteEnd: (id: string) => void ended.push(id),
  });
  t.after(() => m.dispose());
  const online = async (id = 'ssh:box') => {
    m.connectedHost(id);
    await settle();
    w.clock.advance(1000);
    await settle();
    return m.connectedHost(id);
  };
  return { w, m, dir, gate, ended, records, online };
}

test('the first ask begins the connection and answers none; once the machine answers the same Host comes back', async (t) => {
  const { m, online } = setup(t);
  assert.equal(m.connectedHost('ssh:box'), null);
  const host = await online();
  assert.equal(host.state(), 'online');
  assert.equal(m.connectedHost('ssh:box'), host, 'one connection per machine');
});

test('B2: a machine not in the list, or one that cannot be reached, answers none and does not throw', async (t) => {
  const { m, w } = setup(t);
  assert.equal(m.connectedHost('ssh:nowhere'), null);
  w.net.mode = 'refuse';
  assert.equal(m.connectedHost('ssh:box'), null);
  await settle();
  w.clock.advance(15_000);
  await settle();
  assert.equal(m.connectedHost('ssh:box'), null);
});

test('requests to the machine carry the epoch of the ownership file, read when the request is made', async (t) => {
  const { w, dir, online } = setup(t);
  const host = await online();
  const store = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const seen: any[] = [];
  w.net.handlers['browser.tabs'] = (p: any) => (seen.push(p), { tabs: [] });
  store.set('c1', { hostId: 'ssh:box', ownerHostId: 'ssh:box', epoch: 9 });
  await host.browser.request('browser.tabs', { chatId: 'c1' });
  store.set('c1', { hostId: 'ssh:box', ownerHostId: 'ssh:box', epoch: 10 });
  await host.browser.request('browser.tabs', { chatId: 'c1' });
  assert.deepEqual(
    seen.map((p) => p.epoch),
    [9, 10],
  );
});

test("A3: what was built on a machine's connection is told when the connection ends: the machine left, Host access closed, or the app closed", async (t) => {
  const { m, gate, ended, online } = setup(t);
  assert.deepEqual(ended, []);
  await online();
  m.remove('ssh:box');
  assert.deepEqual(ended, ['ssh:box']);
  // nothing connected: nothing is told
  m.remove('ssh:box');
  assert.deepEqual(ended, ['ssh:box']);
  // access closing ends every connection that is there
  await online();
  gate.allowed = false;
  for (const fn of gate.fns) fn(false);
  assert.deepEqual(ended, ['ssh:box', 'ssh:box']);
  assert.throws(
    () => m.connectedHost('ssh:box'),
    (e: any) => e.code === 'not_allowed',
  );
});

test('closing the app ends the connection that is there', async (t) => {
  const { m, ended, online } = setup(t);
  await online();
  m.dispose();
  assert.deepEqual(ended, ['ssh:box']);
});
