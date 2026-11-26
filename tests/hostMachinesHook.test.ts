// The renderer's follow of the remote machines (src/lib/hostMachines.ts): nothing is read before Host access is on, one read serves every consumer, pushes replace the list, a malformed push is ignored, and losing access drops the list and the subscription (A3, A5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const { useHostMachines, readMachineAgents, readMachineRow } = await import('../src/lib/hostMachines.ts');
const ROW = {
  id: 'ssh:a',
  name: 'a',
  status: 'online',
  note: 'SSH · claude',
  signin: null,
  capabilities: { iab: false, cu: false, desktop: false },
  agents: [],
  installable: [],
  lastSeen: null,
  localNetwork: 'unknown',
  waitingForLogin: null,
  startsAtBoot: 'unknown',
  fileVault: 'unknown',
  address: '',
  hostVersion: '',
  platform: '',
};

const seen: { machines: unknown[]; resolved: boolean }[] = [];
function Probe() {
  seen.push(useHostMachines());
  return null;
}
async function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(createElement(Probe)));
  return () => act(async () => root.unmount());
}

test('the list is read once for every consumer, pushes replace it, a malformed push does not, and losing access drops it', async () => {
  const fake = fakeNative({ host: { access: async () => true, machines: async () => ({ machines: [ROW], resolved: false }) } });
  installNative(fake);
  const a = await mount();
  assert.deepEqual(seen.at(-1), { machines: [ROW], resolved: false });
  const b = await mount();
  assert.equal(fake.callsTo('host.machines').length, 1, 'a second consumer does not start a second read');
  await act(async () => fake.emit('host.onMachines', { machines: [{ ...ROW, status: 'offline' }], resolved: true }));
  assert.deepEqual(seen.at(-1), { machines: [{ ...ROW, status: 'offline' }], resolved: true });
  await act(async () => fake.emit('host.onMachines', { machines: 'nope' }));
  assert.equal(seen.at(-1)?.resolved, true, 'a malformed push changes nothing');
  await act(async () => fake.emit('host.onAccess', false));
  assert.deepEqual(seen.at(-1), { machines: [], resolved: true }, 'no access: nothing to resolve');
  // access returns: it follows again from a fresh read
  await act(async () => fake.emit('host.onAccess', true));
  assert.equal(fake.callsTo('host.machines').length, 2);
  assert.deepEqual(seen.at(-1), { machines: [ROW], resolved: false });
  await a();
  await b();
});

test('a push equal to the held list wakes no reader, and a row that did not change keeps its object (#5398)', async () => {
  const other = { ...ROW, id: 'ssh:b', name: 'b' };
  const fake = fakeNative({ host: { access: async () => true, machines: async () => ({ machines: [ROW, other], resolved: true }) } });
  installNative(fake);
  const off = await mount();
  const held = seen.at(-1)!;
  const renders = seen.length;
  await act(async () => fake.emit('host.onMachines', JSON.parse(JSON.stringify({ machines: [ROW, other], resolved: true }))));
  assert.equal(seen.length, renders, 'the same list again renders no reader');
  assert.equal(seen.at(-1), held);
  await act(async () => fake.emit('host.onMachines', { machines: [ROW, { ...other, status: 'offline' }], resolved: true }));
  assert.equal(seen.length, renders + 1);
  assert.equal(seen.at(-1)!.machines[0], held.machines[0], 'the machine that did not change is the same object');
  assert.notEqual(seen.at(-1)!.machines[1], held.machines[1]);
  await off();
});

test('a read that fails or returns something else leaves the list unresolved', async () => {
  const fake = fakeNative({ host: { access: async () => true, machines: async () => 'nope' } });
  installNative(fake);
  const off = await mount();
  assert.deepEqual(seen.at(-1), { machines: [], resolved: false });
  await off();
});

test('a send reads the followed list once every machine has answered, else asks main, and a machine it does not list has no agents', async () => {
  const AGENTS = [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }];
  const row = { ...ROW, agents: AGENTS };
  const fake = fakeNative({ host: { access: async () => true, machines: async () => ({ machines: [row], resolved: true }) } });
  installNative(fake);
  // nothing followed yet: asked of main
  assert.deepEqual(await readMachineAgents('ssh:a'), AGENTS);
  assert.deepEqual(await readMachineAgents('elsewhere'), []);
  const reads = fake.callsTo('host.machines').length;
  // followed and resolved: no further read
  const off = await mount();
  const followed = fake.callsTo('host.machines').length;
  assert.deepEqual(await readMachineAgents('ssh:a'), AGENTS);
  assert.equal(fake.callsTo('host.machines').length, followed, 'the followed list answers');
  assert.ok(followed > reads);
  await off();
});

test('a send whose read of the machines fails goes on with no agents known', async () => {
  installNative(
    fakeNative({
      host: {
        access: async () => true,
        machines: async () => {
          throw new Error('offline');
        },
      },
    }),
  );
  assert.deepEqual(await readMachineAgents('ssh:a'), []);
});

test("a machine row read says the machine's status, and nothing for an unlisted machine or a failed read (chat C3)", async () => {
  installNative(
    fakeNative({
      host: { access: async () => true, machines: async () => ({ machines: [{ ...ROW, status: 'offline' }], resolved: true }) },
    }),
  );
  assert.equal((await readMachineRow('ssh:a'))?.status, 'offline');
  assert.equal(await readMachineRow('elsewhere'), undefined);
  installNative(
    fakeNative({
      host: {
        access: async () => true,
        machines: async () => {
          throw new Error('offline');
        },
      },
    }),
  );
  assert.equal(await readMachineRow('ssh:a'), undefined);
});

test('a row that says its link dropped carries the time, and a bad value is dropped (chat C22)', async () => {
  const { parseMachineList } = await import('../src/lib/hostMachines.ts');
  const rows = parseMachineList({
    machines: [
      { ...ROW, linkDroppedAt: 1234 },
      { ...ROW, id: 'ssh:b', linkDroppedAt: 'x' },
    ],
    resolved: true,
  })!.machines;
  assert.equal(rows[0].linkDroppedAt, 1234);
  assert.equal('linkDroppedAt' in rows[1], false);
  const stopped = parseMachineList({
    machines: [
      { ...ROW, hostStopped: true },
      { ...ROW, id: 'ssh:b', hostStopped: 'yes' },
    ],
    resolved: true,
  })!.machines;
  assert.equal(stopped[0].hostStopped, true);
  assert.equal('hostStopped' in stopped[1], false, 'only true counts');
  const removed = parseMachineList({
    machines: [
      { ...ROW, peerRemoved: true },
      { ...ROW, id: 'ssh:b', peerRemoved: 1 },
    ],
    resolved: true,
  })!.machines;
  assert.equal(removed[0].peerRemoved, true, 'a machine whose Host removed this Mac (#5747)');
  assert.equal('peerRemoved' in removed[1], false);
});
