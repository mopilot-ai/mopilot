// Who may allow and remove MoMo's home on a Host (host/src/hostClients.mjs, pairing.mjs): only an owner's paired desktop or phone, only while the host-link switch is on, audited with the device that did it, and its removal reaches the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createHostClients } from '../host/src/hostClients.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
import { tmpDir } from './support/hostClientsWorld.ts';
import { keySafe } from './support/hostKeySafe.ts';

const { loadIdentity } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
process.env.MOPILOT_MOMO_HOST_LINK = '1';

// ----- the Host's client table: who may allow and remove a home ---------------------------------

function table(t: any) {
  const dir = tmpDir(t);
  const pairing = createPairing({ configDir: path.join(dir, 'config') });
  const removed: string[] = [];
  // told of every client forgotten, by whichever path
  pairing.onForgotten((f: string, kind: string) => void removed.push(`${kind}:${f}`));
  const clients = createHostClients({ pairing, connected: () => false, close: () => undefined });
  const key = (n: string) => loadIdentity(path.join(dir, `${n}.json`), keySafe).publicKey;
  return { pairing, clients, removed, key };
}
const who = (kind: string, fingerprint = 'w'.repeat(64)) => ({ fingerprint, name: kind, kind }) as any;

test('only a paired desktop or phone allows a home; the CLI, a home and an unknown kind may not', (t) => {
  const { clients, pairing, key } = table(t);
  const add = (kind: string, n: string) =>
    (clients.call as any)('host.clientAdd', { publicKey: key(n), kind: 'home', name: 'MoMo on Studio' }, who(kind));
  for (const kind of ['cli', 'home'])
    assert.throws(
      () => add(kind, `k-${kind}`),
      (e: any) => e.code === 'forbidden',
    );
  assert.equal(pairing.paired(), 0);
  const fp = add('phone', 'k-phone').fingerprint;
  assert.equal(pairing.list().find((c: any) => c.fingerprint === fp)?.kind, 'home');
  assert.equal((add('desktop', 'k-desktop') as any).fingerprint.length, 64);
  // the old rules for every other kind are unchanged: a phone still cannot add a desktop
  assert.throws(
    () => (clients.call as any)('host.clientAdd', { publicKey: key('k2'), kind: 'desktop' }, who('phone')),
    (e: any) => e.code === 'forbidden',
  );
  assert.ok((clients.call as any)('host.clientAdd', { publicKey: key('k3'), kind: 'phone' }, who('desktop')).fingerprint);
});

test('allowing MoMo is audited with the device that allowed it', (t) => {
  const dir = tmpDir(t);
  const events: any[] = [];
  const pairing = createPairing({ configDir: path.join(dir, 'config'), audit: (e: any) => void events.push(e) });
  const clients = createHostClients({ pairing, connected: () => false, close: () => undefined });
  const publicKey = loadIdentity(path.join(dir, 'h.json'), keySafe).publicKey;
  (clients.call as any)('host.clientAdd', { publicKey, kind: 'home', name: 'MoMo' }, who('phone', 'p'.repeat(64)));
  assert.equal(events[0].kind, 'client.added');
  assert.equal(events[0].by.kind, 'home');
  assert.deepEqual(events[0].what, { addedBy: 'p'.repeat(64) });
});

test('a home is removed by a desktop or phone, which stops its sessions; a phone still cannot remove a desktop', (t) => {
  const { clients, pairing, key, removed } = table(t);
  const home = pairing.add(key('h'), { kind: 'home', name: 'MoMo' });
  const desktop = pairing.add(key('d'), { kind: 'desktop', name: 'Mac' });
  assert.throws(
    () => clients.call('host.clientRemove', { fingerprint: desktop }, who('phone')),
    (e: any) => e.code === 'forbidden',
  );
  assert.throws(
    () => clients.call('host.clientRemove', { fingerprint: home }, who('home', 'z'.repeat(64))),
    (e: any) => e.code === 'forbidden',
  );
  assert.deepEqual(clients.call('host.clientRemove', { fingerprint: home }, who('phone')), { removed: true });
  assert.deepEqual(removed, [`home:${home}`]);
  assert.deepEqual(clients.call('host.clientRemove', { fingerprint: home }, who('desktop')), { removed: false });
  // a desktop's removal is told as a desktop's, and a removal by the CLI's path is told too
  assert.deepEqual(clients.call('host.clientRemove', { fingerprint: desktop }, who('desktop')), { removed: true });
  assert.deepEqual(removed, [`home:${home}`, `desktop:${desktop}`]);
  const again = pairing.add(key('h2'), { kind: 'home', name: 'MoMo' });
  assert.equal(pairing.remove(again), true);
  assert.equal(removed.at(-1), `home:${again}`);
});

test('MoMo may be allowed on a machine only while the host-link switch is on there, and only by an owner device', (t) => {
  const { clients, key } = table(t);
  const before = process.env.MOPILOT_MOMO_HOST_LINK;
  try {
    delete process.env.MOPILOT_MOMO_HOST_LINK;
    assert.throws(
      () => (clients.call as any)('host.clientAdd', { publicKey: key('off'), kind: 'home', name: 'MoMo' }, who('desktop')),
      (e: any) => e.code === 'forbidden',
    );
    process.env.MOPILOT_MOMO_HOST_LINK = '1';
    assert.ok((clients.call as any)('host.clientAdd', { publicKey: key('on'), kind: 'home', name: 'MoMo' }, who('desktop')).fingerprint);
  } finally {
    if (before === undefined) delete process.env.MOPILOT_MOMO_HOST_LINK;
    else process.env.MOPILOT_MOMO_HOST_LINK = before;
  }
});
