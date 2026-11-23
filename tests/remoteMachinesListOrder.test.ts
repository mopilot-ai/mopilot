// machines.list answers on the same chain as machines.changed (electron/remote/service.cjs listMachines, #3765): a change landing mid-read is never told before the reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { machinesSignature } = require('../electron/remote/phoneMachines.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const row = (o: object = {}) => ({
  id: 'ssh:box',
  name: 'box',
  status: 'online',
  note: 'SSH',
  agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
  installable: [],
  lastSeen: 900,
  localNetwork: 'allowed',
  waitingForLogin: null,
  ...o,
});
const fakeHost = () => {
  const host: any = {
    allowed: () => true,
    rows: () => [row()],
    record: () => null,
    orgCovers: () => false,
    hostOf: () => 'local',
  };
  return { host };
};

test('machines.list: a change landing while the list is read is told after the reply, and the recorded signature is the newest one (#3765)', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const harnesses = r.service.ops.harnesses;
  let first = true;
  r.service.ops.harnesses = async () => {
    if (first) {
      first = false;
      await held;
    }
    return harnesses();
  };
  const listed = p.ask('machines.list', {}, 'L1');
  await settle();
  host.rows = () => [row({ status: 'offline' })];
  const changed = r.service.onMachinesChanged();
  await settle();
  assert.equal(p.events('machines.changed').length, 0, 'the event waits behind the list read');
  release();
  await listed;
  await changed;
  await settle();
  const answer = ok(p.inbox.find((m: any) => m.inReplyTo === 'L1'));
  assert.equal(answer.machines[1].status, 'offline', 'the reply carries the change');
  assert.equal(p.events('machines.changed').length, 0, 'the phone already holds it, so no event repeats it');
  assert.equal(r.service.machinesSent.get('p1'), machinesSignature(answer.machines));
});

test('machines.list: a failing read is the caller’s error and does not stall the chain', async () => {
  const { host } = fakeHost();
  const r = rig({ host: () => host });
  const p = r.phone('p1');
  host.rows = () => {
    throw new Error('registry gone');
  };
  assert.equal((await p.ask('machines.list')).ok, false);
  host.rows = () => [row()];
  assert.equal(ok(await p.ask('machines.list')).machines.length, 2);
});
