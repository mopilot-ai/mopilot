// A returning machine is told what was continued without it (electron/host/hostReturned.cjs): once per change of its status to anything but offline, after the snapshot's own turn, only while the switch runner is wired; a failed telling is noted, not thrown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHostReturned } = require('../electron/host/hostReturned.cjs');

const flush = () => new Promise((r) => setImmediate(r));

test('a machine is told when its status changes to one that answers, once, after the snapshot; offline and unchanged rows are not', async () => {
  const told: string[] = [];
  const live: any = { switchRunner: {} };
  const returned = createHostReturned({ live, hostReturned: async (id: string) => void told.push(id) });
  returned({
    machines: [
      { id: 'a', status: 'online' },
      { id: 'b', status: 'offline' },
    ],
  });
  assert.deepEqual(told, [], 'not inside the snapshot’s own turn');
  await flush();
  assert.deepEqual(told, ['a']);
  returned({
    machines: [
      { id: 'a', status: 'online' },
      { id: 'b', status: 'attention' },
    ],
  });
  await flush();
  assert.deepEqual(told, ['a', 'b'], 'unchanged is not told again; a change to attention is');
  returned({ machines: [{ id: 'a', status: 'offline' }] });
  returned({ machines: [{ id: 'a', status: 'online' }] });
  await flush();
  assert.deepEqual(told, ['a', 'b', 'a'], 'back after offline');
});

test('without a switch runner (or without the services) nothing is told, though the status is still remembered; a failed telling is noted', async () => {
  const told: string[] = [];
  const live: any = {};
  const returned = createHostReturned({ live, hostReturned: async (id: string) => void told.push(id) });
  returned({ machines: [{ id: 'a', status: 'online' }] });
  live.switchRunner = {};
  returned({ machines: [{ id: 'a', status: 'online' }] });
  await flush();
  assert.deepEqual(told, [], 'the change was seen while nothing could be continued');
  createHostReturned({ live: undefined, hostReturned: async () => assert.fail('told') })({ machines: [{ id: 'x', status: 'online' }] });
  const failing = createHostReturned({
    live: { switchRunner: {} },
    hostReturned: async () => {
      throw new Error('machine went away');
    },
  });
  failing({ machines: [{ id: 'z', status: 'online' }] });
  await flush();
  await flush();
});
