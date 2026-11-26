// A machine with only a relay path (paired by code: `relay:<host id>`, no SSH route, no socket of its own on record) is reached through its relay tunnel, not refused as "no Host socket on record" (#5736); a machine with an SSH address and no socket still is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { createMachines } from './support/hostKeySafe.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createMachineCall } = require('../electron/host/machineCall.cjs');

/** A tunnel pool that records what it is asked for and comes up at once. */
const fakePool = (events: string[]) => ({
  get: (target: any) => (
    events.push(`get ${target.destination} ${target.remoteSocket}`),
    { acquire: () => ({ socketPath: '/local.sock', ready: Promise.resolve(true), release: () => events.push('release') }), reason: '' }
  ),
});

test('a call leases the relay tunnel of a relay-only machine; a machine with an SSH address and no socket is still refused', async () => {
  const events: string[] = [];
  const call = createMachineCall({
    pool: fakePool(events),
    targetOf: (r: any) => ({ destination: r.address, remoteSocket: r.socketPath }),
    relay: { enrolled: () => true },
    connect: () => {
      throw new Error('not used');
    },
  });
  const held = await call.lease({ address: 'relay:h_abcdefghijklmnop', socketPath: '' });
  assert.equal(held.socketPath, '/local.sock');
  held.release();
  assert.deepEqual(events, ['get relay:h_abcdefghijklmnop ', 'release']);
  await assert.rejects(call.lease({ address: 'me@box', socketPath: '' }), /no Host socket on record/);
});

test('the machine list reaches a relay-only machine (its status is asked through the pool) and never calls it unreachable for want of a socket', async (t) => {
  installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, 'host-registry.json'),
    JSON.stringify({ version: 1, hosts: [{ id: 'relay:h_abcdefghijklmnop', name: 'paired', address: 'relay:h_abcdefghijklmnop' }] }),
  );
  const events: string[] = [];
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    pool: fakePool(events),
    connect: () => {
      throw new Error('no socket here');
    },
    installer: { install: async () => ({}) },
  });
  t.after(() => m.dispose());
  await waitFor(() => events.some((e) => e.startsWith('get relay:h_abcdefghijklmnop')), 'the pool is asked for its relay tunnel');
  const row = m.list().machines.find((x: any) => x.id === 'relay:h_abcdefghijklmnop');
  assert.ok(!/no Host socket on record/.test(String(row?.note)), String(row?.note));
});
