// Pairing in main's machines service (electron/host/machines.cjs) over a real remote Host through a tunnel: a standing connection made before the pairing is ended by it, so the first message after pairing is accepted and a Mac the Host never knew is still refused with the Host's code (#5103).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const HOST_ID = 'abababababababababababababababab';

/** A machine whose Host answers `unknown_client` to the proof of a key until `host.pair` is answered. */
function world(t: any) {
  const w = hostWorld(t);
  const host = { paired: false };
  w.net.handlers['host.challenge'] = () => ({ nonce: 'n-1', hostId: HOST_ID });
  w.net.handlers['host.auth'] = () => {
    if (!host.paired) throw Object.assign(new Error('This app is not paired with this Host.'), { code: 'unknown_client' });
    return { fingerprint: 'f' };
  };
  w.net.handlers['host.hello'] = () => S.helloParams();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = () => ({ harnesses: [], capabilities: {} });
  const registry = createRegistry({ file: path.join(dir, 'r.json'), status: async () => status() });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  const tunnel = w.tunnel();
  const m = createMachines({
    safeStorage: keySafe,
    dir,
    allowed: () => true,
    watch: () => undefined,
    registry,
    installer: {},
    pool: { get: () => tunnel },
    call: async (_r: any, method: string) => {
      if (method === 'host.challenge') return { nonce: 'n-2', hostId: HOST_ID };
      if (method === 'host.pair') return (host.paired = true), { fingerprint: 'f' };
      return status();
    },
    connect: w.net.connect,
  });
  t.after(() => m.dispose());
  /** How many connections to the Host said hello. */
  const attaches = () => w.net.sockets.filter((s: any) => s.written.some((x: any) => x.method === 'host.hello')).length;
  return { ...w, m, host, attaches };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

test('a connection made before the pairing is ended by it: the first message after pairing is accepted', async (t) => {
  const w = world(t);
  const before = w.m.hostFor('ssh:box');
  void before.connect().catch(() => undefined);
  await settle();
  await assert.rejects(before.send('a', { text: 'hi' }, { key: 'k-0000001' }), (e: any) => e.code === 'unknown_client');
  await w.m.pair('ssh:box', 'abcd-efgh-jkmn');
  await assert.rejects(before.send('a', { text: 'hi' }, { key: 'k-0000002' }), /disposed/, 'the old connection is gone');
  const after = w.m.hostFor('ssh:box');
  assert.notEqual(after, before);
  void after.connect().catch(() => undefined);
  await settle();
  assert.deepEqual(await after.send('a', { text: 'hi' }, { key: 'k-0000003' }), 'ok');
  assert.equal(w.attaches(), 2, 'a new connection agreed and proved the key');
});

test('a Mac the Host never paired is refused with the Host’s code, and a failed pairing keeps the connection', async (t) => {
  const w = world(t);
  const standing = w.m.hostFor('ssh:box');
  void standing.connect().catch(() => undefined);
  await settle();
  await assert.rejects(w.m.pair('ssh:box', ''), /Enter the pairing code/);
  assert.equal(w.m.hostFor('ssh:box'), standing);
  await assert.rejects(standing.send('a', { text: 'hi' }, { key: 'k-0000001' }), (e: any) => e.code === 'unknown_client');
});
