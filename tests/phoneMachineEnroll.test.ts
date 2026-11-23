// A phone's request for direct access (shared/remote/phoneEnrollSchema.mjs, electron/remote/methods/host.cjs, phoneMachines.cjs):
// the parsers, the two methods through the service, each phone's own `direct` state beside the machines, and the gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, settle } from './support/remote-kit.ts';
import { ok, fail, fakeHost } from './support/remoteHostKit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const RELAY = { hostId: 'h_phone0000000000000001', secret: 's'.repeat(43), pairId: 'p_phone00001', relayUrl: 'wss://relay.example/v1/ws' };
const key = (c: string) => c.repeat(43) + '=';
const GOOD = { hostId: 'ssh:box', relay: RELAY, appPub: key('A'), appEphPub: key('B'), edPub: key('C'), name: ' Pocket iPhone ' };

test('machines.enroll and machines.forget parse and refuse what is not an enrollment', () => {
  const got = parseParams('machines.enroll', GOOD) as any;
  assert.deepEqual([got.hostId, got.name, got.relay.hostId], ['ssh:box', 'Pocket iPhone', RELAY.hostId]);
  assert.equal((parseParams('machines.enroll', { ...GOOD, name: '  ' }) as any).name, 'Phone');
  assert.equal(
    (parseParams('machines.enroll', { ...GOOD, relay: { ...RELAY, relayUrl: 'ws://localhost:8787/v1/ws' } }) as any).relay.relayUrl,
    'ws://localhost:8787/v1/ws',
  );
  for (const bad of [
    { ...GOOD, relay: null },
    { ...GOOD, relay: { ...RELAY, relayUrl: 'ws://evil.example/v1/ws' } },
    { ...GOOD, relay: { ...RELAY, relayUrl: 5 } },
    { ...GOOD, relay: { ...RELAY, hostId: 'nope' } },
    { ...GOOD, relay: { ...RELAY, secret: 'short' } },
    { ...GOOD, relay: { ...RELAY, pairId: 'x' } },
    { ...GOOD, appPub: 'x' },
    { ...GOOD, edPub: undefined },
    { ...GOOD, hostId: '' },
  ])
    assert.throws(() => parseParams('machines.enroll', bad));
  assert.deepEqual(parseParams('machines.forget', { hostId: 'ssh:box' }), { hostId: 'ssh:box' });
  assert.throws(() => parseParams('machines.forget', {}));
});

function direct() {
  const calls: any[][] = [];
  const states = new Map<string, string>();
  return {
    calls,
    states,
    api: {
      enabled: () => true,
      stateOf: (m: string, p: string) => states.get(`${m}:${p}`) ?? 'off',
      retry: (m: string) => void calls.push(['retry', m]),
      enroll: async (m: string, p: string, params: any, name: string) => (
        calls.push(['enroll', m, p, params, name]),
        states.set(`${m}:${p}`, 'on'),
        { hostPub: 'H', hostEphPub: 'E', hostKey: 'k', name, features: [] }
      ),
      forget: async (m: string, p: string) => (calls.push(['forget', m, p]), states.set(`${m}:${p}`, 'off'), { removed: true }),
    },
  };
}

test('a phone enrols and forgets through the Mac, and each phone is told its own state', async () => {
  const d = direct();
  const { host } = fakeHost({ phoneDirect: d.api });
  const r = rig({ host: () => host });
  const phone = r.phone('p1');
  const first = ok(await phone.ask('machines.list'));
  assert.deepEqual(first.direct, { 'ssh:box': 'off' });
  assert.deepEqual(d.calls[0], ['retry', 'ssh:box']);
  const answer = ok(await phone.ask('machines.enroll', GOOD));
  assert.deepEqual(answer, { hostPub: 'H', hostEphPub: 'E', hostKey: 'k', name: 'box', features: [] });
  assert.equal(d.calls.find((c) => c[0] === 'enroll')![4], 'box');
  await settle();
  assert.deepEqual(ok(await phone.ask('machines.list')).direct, { 'ssh:box': 'on' });
  assert.deepEqual(ok(await r.phone('p2').ask('machines.list')).direct, { 'ssh:box': 'off' });
  assert.deepEqual(ok(await phone.ask('machines.forget', { hostId: 'ssh:box' })), { removed: true });
  await settle();
  assert.deepEqual(ok(await phone.ask('machines.list')).direct, { 'ssh:box': 'off' });
  // an unknown machine id falls back to the id as its name
  await phone.ask('machines.enroll', { ...GOOD, hostId: 'ssh:other' });
  assert.equal(d.calls.filter((c) => c[0] === 'enroll').at(-1)![4], 'ssh:other');
});

test('without the feature or Host, direct access is refused and no state is shown', async () => {
  const off = fakeHost({ phoneDirect: { ...direct().api, enabled: () => false } });
  const a = rig({ host: () => off.host });
  assert.equal(ok(await a.phone('p1').ask('machines.list')).direct, undefined);
  const none = fakeHost();
  const b = rig({ host: () => none.host });
  fail(await b.phone('p1').ask('machines.enroll', GOOD), 'forbidden');
  const closed = fakeHost({ open: false, phoneDirect: direct().api });
  closed.host.open = false;
  const c = rig({ host: () => closed.host });
  fail(await c.phone('p1').ask('machines.forget', { hostId: 'ssh:box' }), 'forbidden');
});
