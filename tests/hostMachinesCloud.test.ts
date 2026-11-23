// A cloud machine's row in the machines list (electron/host/machines.cjs, plan C2): its record with how long it may idle and run, and, while it answers, what its Host said of its idle stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const ready = { harnesses: [{ id: 'claude', detected: true, signedIn: true }], capabilities: { shell: true } };
const tick = () => new Promise((r) => setImmediate(r));

/** The machines service over a registry whose Host answers with what `said()` returns. */
function world(t: any, said: () => unknown) {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-cloud-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = async (_r: any, method: string) => (method === 'status' ? said() : null);
  const registry = createRegistry({ file: path.join(dir, 'host-registry.json'), status: (r: any) => call(r, 'status') });
  const m = createMachines({
    dir,
    root: dir,
    allowed: () => true,
    watch: () => undefined,
    call,
    onChange: () => undefined,
    onStep: () => undefined,
    installer: { install: async () => ({ ok: false }) },
    registry,
  });
  t.after(() => m.dispose());
  return { m, registry, clock };
}

test('a cloud machine’s row carries its record and, while it answers, what its Host said of its idle stop (plan C2)', async (t) => {
  const idle = { idleMinutes: 45, stopping: true, hoursToday: 1.5, reason: 'idle' };
  let said: any = { ...ready, cloud: idle };
  const w = world(t, () => said);
  w.registry.add({
    id: 'c1',
    name: 'dev-cloud',
    address: 'relay:c1',
    socketPath: '',
    cloud: { provider: 'oci', id: 'ocid1.i', region: 'us-phoenix-1', size: 'a1', idleMinutes: 45, hoursPerDay: 6 },
  });
  w.clock.advance(30_000);
  await tick();
  const row = w.m.list().machines[0];
  assert.deepEqual(row.cloud, {
    provider: 'oci',
    id: 'ocid1.i',
    region: 'us-phoenix-1',
    size: 'a1',
    network: 'full',
    idleMinutes: 45,
    hoursPerDay: 6,
  });
  assert.deepEqual(row.cloudState, idle);
  // a state that is not whole is none, and a Host that says little gets the defaults for the rest
  said = { ...ready, cloud: { stopping: true } };
  w.clock.advance(30_000);
  await tick();
  assert.equal(w.m.list().machines[0].cloudState, null);
  said = { ...ready, cloud: { idleMinutes: 30, hoursToday: 'x', reason: 'other' } };
  w.clock.advance(30_000);
  await tick();
  assert.deepEqual(w.m.list().machines[0].cloudState, { idleMinutes: 30, stopping: false, hoursToday: 0 });
});
