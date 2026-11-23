// The machines service with organization access (electron/host/machines.cjs, #3361 Tier 2): a row reads keyed while the organization covers the agent, the lease is lent through the wrapped Host, and sign out everywhere forwards the org identity.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const seen: any[] = [];
mock.module('../electron/host/signOut.cjs', {
  exports: { signOutEverywhere: async (o: any) => (seen.push(o), []) },
});
const { createMachines } = require('../electron/host/machines.cjs');
const { createRegistry } = require('../electron/host/registry.cjs');

function make(t: any, orgAccess?: any, apiKeys?: any, harness: object = { takesOrg: true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-machines-org-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = createRegistry({
    file: path.join(dir, 'r.json'),
    status: async () => ({ harnesses: [{ id: 'claude', detected: true, signedIn: false, ...harness }], capabilities: {} }),
  });
  registry.add({ id: 'ssh:box', name: 'box', address: 'me@box', socketPath: '/h/host.sock', harnesses: [] });
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    registry,
    installer: {},
    pool: { get: () => ({}) },
    ...(orgAccess ? { orgAccess } : {}),
    ...(apiKeys ? { apiKeys } : {}),
  });
  t.after(() => m.dispose());
  return { m, registry };
}
const stateOf = (m: any) => m.list().machines[0].agents.find((a: any) => a.id === 'claude')?.state;

test('an agent that takes a lease reads ready while the organization covers it, and needs a sign-in otherwise', async (t) => {
  const covered = make(t, { lend: async () => true, covers: (h: string) => h === 'claude' });
  await covered.registry.check();
  const bare = make(t);
  await bare.registry.check();
  assert.notEqual(stateOf(covered.m), stateOf(bare.m));
  assert.equal(stateOf(bare.m), 'signin');
  // the machine follows its agents: covered, it is ready and its row says how it is reached; uncovered, it waits on the sign-in
  const row = (x: any) => x.m.list().machines[0];
  assert.deepEqual([row(covered).status, /not signed in/.test(row(covered).note)], ['online', false]);
  assert.deepEqual([row(bare).status, row(bare).note], ['attention', 'claude is not signed in on this machine.']);
});

test('the user’s own key makes the machine ready the same way, for any agent that takes one', async (t) => {
  const keyed = make(t, undefined, { hasFor: (h: string) => h === 'claude', forHarness: () => null }, { takesKey: true });
  await keyed.registry.check();
  assert.deepEqual([keyed.m.list().machines[0].status, stateOf(keyed.m)], ['online', 'ready']);
});

test('sign out everywhere forwards the org identity to the machines, and none when not given', async (t) => {
  const { m } = make(t);
  seen.length = 0;
  await m.signOutEverywhere('e'.repeat(32));
  await m.signOutEverywhere();
  assert.deepEqual(
    seen.map((o) => o.orgIdentity),
    ['e'.repeat(32), null],
  );
});
