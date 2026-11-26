// The phone's Hosts for MoMo's home: the machines it holds an enrollment with as the shared home reads them, one request on a machine's own session, and the grant only when an account is signed in.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const hostsPath = '../mobile/src/momoPhone/phoneHome/hosts';
const { phoneMomoHosts } = await import(hostsPath);

const rig = (account: string | null = 'acct-1') => {
  const sent: [string, string, object][] = [];
  const listeners = new Set<() => void>();
  const up = new Map<string, boolean | null>([
    ['studio', true],
    ['mini', false],
    ['new', null],
  ]);
  const sessions = {
    records: () => [
      { machineId: 'studio', name: 'Studio', hostKey: 'host-studio' },
      { machineId: 'mini', name: 'Mac mini' },
      { machineId: 'new', name: 'New' },
    ],
    reachable: (id: string) => up.get(id) ?? null,
    agents: (id: string) =>
      id === 'studio'
        ? [
            { id: 'claude', label: 'Claude', state: 'ready' },
            { id: 'codex', label: 'Codex', state: 'missing' },
            { id: 'acp:x', label: 'X', state: 'signin' },
          ]
        : null,
    session: async (id: string) => ({
      request: async (method: string, params?: object) => {
        sent.push([id, method, params ?? {}]);
        return { ok: id };
      },
    }),
  };
  const hosts = phoneMomoHosts({
    sessions,
    account: () => account,
    onChange: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  });
  return { hosts, sent, listeners };
};

test('the machines are the ones the phone holds an enrollment with, read as the shared home reads them', () => {
  const { hosts } = rig();
  const [studio, mini, fresh] = hosts.machines();
  assert.equal(studio.id, 'studio');
  assert.equal(studio.hostId, 'host-studio');
  assert.equal(studio.hasHost, true);
  assert.equal(studio.reachable, true);
  assert.deepEqual(studio.agents, [
    { id: 'claude', name: 'Claude', installed: true, signedIn: true },
    { id: 'codex', name: 'Codex', installed: false, signedIn: false },
    { id: 'acp:x', name: 'X', installed: true, signedIn: false },
  ]);
  // a machine that was read and did not answer is not reachable; one not read yet is asked
  assert.equal(mini.reachable, false);
  assert.equal(fresh.reachable, true);
  // agents not read yet: not accused of having none
  assert.deepEqual(mini.agents, [{ id: 'claude', name: 'Claude', installed: true, signedIn: true }]);
});

test('a call is one request on that machine’s own session, and the grant names the account', async () => {
  const { hosts, sent } = rig();
  assert.deepEqual(await hosts.call('studio', 'host.momoHomeLook', {}), { ok: 'studio' });
  assert.deepEqual(await hosts.call('mini', 'host.momoStatus'), { ok: 'mini' });
  await hosts.grant('studio');
  assert.deepEqual(sent, [
    ['studio', 'host.momoHomeLook', {}],
    ['mini', 'host.momoStatus', {}],
    ['studio', 'host.momoGrant', { account: 'acct-1', features: ['momo'] }],
  ]);
});

test('nothing is granted when nobody is signed in, and a change is passed on until stopped', async () => {
  const { hosts, sent, listeners } = rig(null);
  await hosts.grant('studio');
  assert.deepEqual(sent, []);
  let told = 0;
  const stop = hosts.onChange(() => told++);
  listeners.forEach((fn) => fn());
  stop();
  listeners.forEach((fn) => fn());
  assert.equal(told, 1);
});
