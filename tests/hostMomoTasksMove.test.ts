// What the home keeps for other machines travels with a real move (host/src/momoServices/tasks.mjs, momoTasks/homeKey.mjs, homeMachines.mjs): after MoMo moves from one Host to another the home key is the same key and the allowed machines are still allowed, both opened with the target's MoMo data key; the old home's copy is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import tasksService from '../host/src/momoServices/tasks.mjs';
// @ts-ignore
import { createHomeMachines } from '../host/src/momoTasks/homeMachines.mjs';
// @ts-ignore
import { keyFingerprint } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { moveHome } from '../shared/momoMove.mjs';
import { fakeSessions } from './support/host/momoTasksWorld.ts';
import { A, B, host } from './support/host/momoMoveWorld.ts';

process.env.MOPILOT_MOMO_HOST_LINK = '1';
const OTHER = { id: 'm1', name: 'Studio mini', link: 'opaque', hostId: 'b'.repeat(32) };

test("a move carries the machines MoMo may use but not its key: the new home makes its own, the old one is retired, and every machine waits for the owner's device", async (t) => {
  const a = await host(t, A);
  const b = await host(t, B);
  for (const h of [a, b]) {
    h.home.workDir = (name: string) => path.join(h.dir, 'data', 'momo-work', name);
    tasksService({
      home: h.home,
      sessions: fakeSessions(),
      now: () => 1_700_000_000_000,
      report: () => undefined,
    });
  }
  await a.home.start(A);
  const tasks = a.home.service('tasks');
  const oldKey = await tasks.homeKey();
  await tasks.allowMachine(OTHER);
  assert.ok(fs.existsSync(path.join(a.momoDir, 'home-key.json')));
  await moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name });
  // the target opens what travelled with ITS data key
  const safeStorage = b.home.data.safeStorage;
  assert.deepEqual(
    createHomeMachines({ dir: b.momoDir, safeStorage, now: () => 1 })
      .list()
      .map((m: any) => m.id),
    ['m1'],
  );
  const contract = await b.home.service('tasks').keyContract();
  assert.notEqual(contract.publicKey, oldKey, 'the new home made a key of its own');
  assert.deepEqual(
    contract.retired.map((r: any) => r.publicKey),
    [oldKey],
    'the old key is retired, to be removed from every machine',
  );
  assert.equal(contract.retired[0].fingerprint, keyFingerprint(oldKey));
  assert.equal(contract.succeeds, keyFingerprint(oldKey), "the new key is registered as the old one's successor");
  assert.deepEqual(
    contract.machines,
    [{ id: 'm1', name: 'Studio mini', hostId: 'b'.repeat(32) }],
    "every machine waits for the owner's device",
  );
  // until then no task starts there, with the real cause
  const out = await b.home
    .service('tasks')
    .create({ title: 't', doneMeans: 'd', origin: 'asked', userStarted: true, where: { machineId: 'm1', harness: 'claude' } });
  assert.match(JSON.stringify(out), /allowed to use|Allow MoMo to use/);
  // the owner's device registered the new key and removed the old one: the machine is used again, and is told this home's lease first
  const calls: string[] = [];
  b.home.service('tasks').bindHostLink({
    dial: async () => ({
      request: async (method: string) => (calls.push(method), method === 'host.challenge' ? { nonce: 'n', hostId: 'b'.repeat(32) } : {}),
      onEvent: () => () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    }),
  });
  await b.home.service('tasks').keyRegistered('m1');
  assert.ok(calls.includes('host.status'), 'its lease reached the machine before any task');
  assert.deepEqual((await b.home.service('tasks').keyContract()).machines, []);
  await b.home.service('tasks').retiredGone(oldKey);
  assert.deepEqual((await b.home.service('tasks').keyContract()).retired, []);
  // the old home no longer holds the key or the list
  assert.equal(fs.existsSync(path.join(a.momoDir, 'home-key.json')), false);
  assert.equal(fs.existsSync(path.join(a.momoDir, 'task-machines.json')), false);
});
