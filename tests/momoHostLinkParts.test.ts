// MoMo's home key, the machines it may use and the router over this Host's machine and the others (host/src/momoTasks/homeKey.mjs, homeMachines.mjs, router.mjs): sealed on disk, found again, routed by id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHomeKey } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { createHomeMachines } from '../host/src/momoTasks/homeMachines.mjs';
// @ts-ignore
import { createMachineRouter } from '../host/src/momoTasks/router.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';

const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sealed = (dir: string) => ({ dir, safeStorage: createFileSafeStorage(path.join(dir, 'k')), now: () => 1 });
const HOST_B = 'b'.repeat(32);
const MACHINE = { id: 'm1', name: 'Studio', link: 'opaque-link', hostId: HOST_B };

test("the home key is made once, sealed on disk, signs a Host's challenge, and leaves memory on drop", async (t) => {
  const o = sealed(tmp(t));
  const key = createHomeKey({ ...o, homeId: () => 'home-a' });
  const pub = await key.publicKey();
  assert.equal(await key.publicKey(), pub, 'one key, made once');
  const id = await key.identity();
  const sig = id.sign('auth', HOST_B, 'n1');
  assert.ok(
    crypto.verify(
      null,
      Buffer.from(`auth\n${HOST_B}\nn1`),
      crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(sig, 'base64'),
    ),
  );
  const raw = fs.readFileSync(path.join(o.dir, 'home-key.json'), 'utf8');
  assert.equal(raw.includes(pub), false, 'the file is sealed, not plain JSON');
  key.drop();
  // a new instance over the same folder is the same key (it moves with the folder)
  assert.equal(await createHomeKey({ ...o, homeId: () => 'home-a' }).publicKey(), pub);
  assert.equal((await key.identity()).publicKey, pub);
});

test('the allowed machines are kept sealed, listed, found and removed', async (t) => {
  const o = sealed(tmp(t));
  const machines = createHomeMachines(o);
  assert.deepEqual(machines.list(), []);
  assert.equal(machines.get('m1'), null);
  await machines.set(MACHINE);
  assert.deepEqual(machines.list(), [MACHINE]);
  assert.deepEqual(machines.get('m1'), MACHINE);
  assert.equal(machines.get('constructor'), null);
  assert.equal(fs.readFileSync(path.join(o.dir, 'task-machines.json'), 'utf8').includes('opaque-link'), false);
  // a name every object already has is never a machine's id, here either
  for (const id of ['__proto__', 'constructor', 'prototype']) await assert.rejects(machines.set({ ...MACHINE, id }), /not a machine id/);
  assert.deepEqual(machines.list(), [MACHINE]);
  await machines.remove('m1');
  assert.deepEqual(machines.list(), []);
});

// ----- the router --------------------------------------------------------------------------------

test('a request goes to the machine that owns the id, always: another machine is never answered by this Host, bound or not', async () => {
  const seen: string[] = [];
  const port = (name: string): any => ({
    list: async () => [{ machineId: name }],
    start: async (r: any) => (seen.push(`${name}:start:${r.machineId}`), { ok: true, sessionId: name }),
    stop: async (m: string) => void seen.push(`${name}:stop:${m}`),
    probe: async (m: string) => (seen.push(`${name}:probe:${m}`), { state: 'running' }),
  });
  const router = createMachineRouter({ local: port('local'), remote: port('remote'), localId: () => 'home-a' });
  assert.deepEqual(await router.list(), [{ machineId: 'local' }, { machineId: 'remote' }]);
  await router.start({ machineId: 'home-a' } as any);
  await router.start({ machineId: 'm1' } as any);
  await router.stop('m1', 's');
  await router.probe('home-a', 's');
  await router.probe('m1', 's');
  assert.deepEqual(seen, ['local:start:home-a', 'remote:start:m1', 'remote:stop:m1', 'local:probe:home-a', 'remote:probe:m1']);
  // this Host is not the running home: no id is its own
  const none = createMachineRouter({ local: port('local'), remote: port('remote'), localId: () => undefined });
  await none.stop('home-a', 's');
  assert.equal(seen.at(-1), 'remote:stop:home-a');
});

test('a key that came with a move is replaced by this home, the old public half is retired, and a Host with no home of its own keeps its key', async (t) => {
  const o = sealed(tmp(t));
  let here: string | undefined = 'home-a';
  const key = createHomeKey({ ...o, homeId: () => here });
  const first = await key.publicKey();
  assert.equal(await key.rotateIfMoved(), false, 'the home that made it keeps it');
  here = 'home-b';
  assert.equal(await key.rotateIfMoved(), true);
  const second = await key.publicKey();
  assert.notEqual(second, first);
  // this Host is no home now: the key it holds came from a home, so it is replaced too, and belongs to no home
  here = undefined;
  assert.equal(await key.rotateIfMoved(), true);
  assert.notEqual(await key.publicKey(), second);
  // a key that belongs to no home is not replaced again
  assert.equal(await key.rotateIfMoved(), false);
});
