// A machine's port forwarded to this Mac (electron/host/machines.cjs `forwardPort`; package 2.6): the address comes from the machine's record, the port is checked, the gate applies, and the forwards go with the machine, the gate and the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');

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

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-forward-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gate = { allowed: true, fns: new Set<(ok: boolean) => void>() };
  const asked: any[] = [];
  const closed: string[] = [];
  const log = { disposed: 0 };
  const forwards = {
    forward: async (target: any) => (asked.push(target), { localPort: 41000 }),
    closeMachine: (id: string) => void closed.push(id),
    dispose: () => void log.disposed++,
  };
  const registry: any = {
    list: () => [record],
    resolved: () => true,
    onChange: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
    check: async () => undefined,
    remove: () => undefined,
  };
  const m = createMachines({
    dir,
    registry,
    installer: {} as any,
    allowed: () => gate.allowed,
    watch: (fn: any) => (gate.fns.add(fn), () => undefined),
    pool: { get: () => ({}) } as any,
    forwards,
  });
  t.after(() => m.dispose());
  return { m, gate, asked, closed, log };
}

test("a machine's port is forwarded to the address on its record, and the answer is the Mac's port", async (t) => {
  const { m, asked } = setup(t);
  assert.deepEqual(await m.forwardPort('ssh:box', 5173), { localPort: 41000 });
  assert.deepEqual(asked, [{ machine: 'ssh:box', destination: 'me@box', sshArgs: [], remotePort: 5173 }]);
});

test('B: a machine not in the list, a port that is not one, and a closed gate are refused with their own codes, and nothing is forwarded', async (t) => {
  const { m, gate, asked } = setup(t);
  await assert.rejects(async () => m.forwardPort('ssh:nowhere', 80), { code: 'unknown_machine' });
  for (const bad of [0, 65536, 1.5, -1, '80', null, undefined, Number.NaN]) {
    await assert.rejects(async () => m.forwardPort('ssh:box', bad), { code: 'bad_port' }, String(bad));
  }
  gate.allowed = false;
  await assert.rejects(async () => m.forwardPort('ssh:box', 80), { code: 'not_allowed' });
  assert.deepEqual(asked, []);
});

test('A3: a machine removed takes its forwards, even when it never had a connection; so does Host access closing and the app closing', async (t) => {
  const { m, gate, closed, log } = setup(t);
  m.remove('ssh:box');
  assert.deepEqual(closed, ['ssh:box']);
  gate.fns.forEach((fn) => fn(false));
  assert.equal(log.disposed, 1);
  m.dispose();
  assert.equal(log.disposed, 2);
});

test('A3: the first connection made to a machine does not take down a port already forwarded from it', async (t) => {
  const { m, closed } = setup(t);
  await m.forwardPort('ssh:box', 5173);
  m.hostFor('ssh:box');
  assert.deepEqual(closed, [], 'a connection beginning is not a machine leaving');
});
