// A Host that lost its phone links says so on the Mac's machine page (#4721): host.status `push.skipped` → the registry record → the row → the machine's line ("No phone linked · push is off"), on the Mac and on the phone alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PUSH_OFF_HINT, machineLine } from '../shared/host/machineLine.mjs';
import { parseMachineList } from '../src/lib/hostMachines.ts';
import { machineStatus } from '../src/lib/machineStatus.ts';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

const said = (push: unknown) => ({
  harnesses: [{ id: 'claude', detected: true, signedIn: true }],
  capabilities: { shell: true },
  platform: 'linux',
  ...(push === undefined ? {} : { push }),
});

test('the row carries the cards the Host found no phone for while it answers, and the registry forgets them when the Host says none or is read from disk', async (t) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-push-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reply: any = said({ phones: 0, skipped: 2, lastSkippedAt: 5 });
  const file = path.join(dir, 'host-registry.json');
  const registry = createRegistry({ file, status: async () => reply });
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => reply,
    registry,
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock' });
  assert.equal(m.list().machines[0].pushSkipped ?? 0, 0, 'nothing is said before the Host answers');
  await registry.check();
  clock.advance(0);
  assert.equal(m.list().machines[0].pushSkipped ?? 0, 2);
  // a Host older than this says nothing, and one with a phone linked again says none: nothing is claimed
  for (const push of [undefined, { phones: 1, skipped: 0, lastSkippedAt: null }, { skipped: -1 }, { skipped: 'many' }, 'x']) {
    reply = said(push);
    await registry.check();
    clock.advance(0);
    assert.equal(m.list().machines[0].pushSkipped ?? 0, 0, JSON.stringify(push));
  }
  // what is said is not kept across a restart of the app: the Host is asked again
  reply = said({ skipped: 3 });
  await registry.check();
  clock.advance(0);
  assert.equal(m.list().machines[0].pushSkipped ?? 0, 3);
  const again = createRegistry({ file, status: async () => null });
  const row = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => reply,
    registry: again,
    installer: { install: async () => ({}) },
  });
  t.after(() => row.dispose());
  assert.equal(row.list().machines[0].pushSkipped ?? 0, 0);
  // an offline machine says nothing of it
  reply = null;
  await registry.check();
  clock.advance(120_000);
  assert.equal(m.list().machines[0].status, 'offline');
  assert.equal(m.list().machines[0].pushSkipped ?? 0, 0);
});

test('a machine that is ready but has cards no phone could take says so, on the Mac’s page and the phone’s; an agent that needs signing in keeps its own line', () => {
  const base = {
    status: 'online',
    note: 'x',
    agents: [{ id: 'claude', label: 'Claude Code', state: 'ready' }],
    installable: [],
    lastSeen: null,
    localNetwork: 'unknown',
    waitingForLogin: null,
  } as any;
  const off = { dot: 'warn', text: 'No phone linked · push is off', title: PUSH_OFF_HINT };
  // the phone's line carries no tooltip; the Mac's page puts the hint on it (src/lib/machineStatus.ts)
  assert.deepEqual(machineLine({ ...base, pushSkipped: 2 }, 0, 'phone'), { dot: 'warn', text: off.text });
  assert.equal(machineLine({ ...base, pushSkipped: 2 }, 0).text, off.text);
  assert.equal(machineLine({ ...base, pushSkipped: 0 }, 0).text, 'Online · Claude Code');
  assert.equal(machineLine(base, 0).text, 'Online · Claude Code');
  const signedOut = { ...base, pushSkipped: 2, agents: [{ id: 'claude', label: 'Claude Code', state: 'signin' }] } as any;
  assert.notEqual(machineLine(signedOut, 0).text, off.text);
  const row = parseMachineList({
    machines: [
      { id: 'a', name: 'a', status: 'online', note: 'x', agents: [{ id: 'claude', label: 'Claude Code', state: 'ready' }], pushSkipped: 2 },
    ],
  })!.machines[0];
  assert.equal(row.pushSkipped, 2);
  assert.deepEqual(machineStatus(row, { now: 0, signin: null, installing: undefined }), off);
  for (const bad of [0, -1, 1.5, '2', undefined])
    assert.equal(
      'pushSkipped' in
        parseMachineList({ machines: [{ id: 'a', name: 'a', status: 'online', note: 'x', agents: [], pushSkipped: bad }] })!.machines[0],
      false,
    );
});
