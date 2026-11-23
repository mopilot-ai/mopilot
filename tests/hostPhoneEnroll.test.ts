// The Mac introduces a phone to a Host (electron/host/phoneEnroll.cjs, P2): the enrollment is carried both ways without being kept,
// a failure after the client was added removes it again, a switch off while an enrollment runs discards the late reply and the Host
// side, an older Host is refused with "Update <machine>", and a Host that was away is told once it is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createPhoneEnroll } = require('../electron/host/phoneEnroll.cjs');

const RELAY = { hostId: 'h_phone0000000000000001', secret: 's'.repeat(43), pairId: 'p_phone00001', relayUrl: 'wss://relay.example/v1/ws' };
const P = {
  relay: RELAY,
  appPub: 'A'.repeat(43) + '=',
  appEphPub: 'B'.repeat(43) + '=',
  edPub: Buffer.alloc(32, 7).toString('base64'),
  name: 'Pocket iPhone',
};
const FP = 'f'.repeat(64);

function rig(o: { features?: string[] | null; on?: boolean; fail?: string; gate?: Promise<void>; away?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-enroll-'));
  const file = path.join(dir, 'direct.json');
  const calls: [string, any][] = [];
  let closed = 0;
  let away = o.away ?? false;
  const paired = async () => {
    if (away) throw new Error('away');
    return {
      call: async (method: string, params?: any) => {
        calls.push([method, params]);
        if (method === o.fail) throw new Error('refused');
        if (method === 'host.hello') return o.features === null ? {} : { features: o.features ?? ['clients', 'relay'] };
        if (method === 'host.challenge') return { nonce: 'n', hostId: 'a'.repeat(32) };
        if (method === 'host.clientAdd') return { fingerprint: FP };
        if (method === 'host.relayEnroll') {
          await o.gate;
          return { hostPub: 'H', hostEphPub: 'E' };
        }
        return {};
      },
      close: () => void closed++,
    };
  };
  const make = () => createPhoneEnroll({ file, paired, allowed: () => o.on ?? true });
  return { enroll: make(), make, file, calls, closed: () => closed, setAway: (v: boolean) => (away = v) };
}

test('enroll adds the client, hands the Host the enrollment, answers its half and keeps ids only', async () => {
  const r = rig();
  const got = await r.enroll.enroll('ssh:box', 'pair1', P, 'build-box');
  assert.deepEqual(got, { hostPub: 'H', hostEphPub: 'E', hostKey: 'a'.repeat(32), name: 'build-box', features: ['clients', 'relay'] });
  const add = r.calls.find(([m]) => m === 'host.clientAdd')![1];
  assert.deepEqual([add.name, add.kind, Buffer.from(add.publicKey, 'base64').length], ['Pocket iPhone', 'phone', 44]);
  assert.deepEqual(r.calls.find(([m]) => m === 'host.relayEnroll')![1], { ...RELAY, appPub: P.appPub, appEphPub: P.appEphPub, client: FP });
  assert.equal(r.enroll.stateOf('ssh:box', 'pair1'), 'on');
  assert.deepEqual(r.enroll.list('ssh:box'), [{ pairId: 'pair1', fingerprint: FP, state: 'on' }]);
  assert.equal(r.closed(), 1);
  // the secret is on no disk and in no later answer
  assert.doesNotMatch(fs.readFileSync(r.file, 'utf8'), new RegExp(RELAY.secret));
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
  // a new process reads the ids back
  assert.equal(r.make().stateOf('ssh:box', 'pair1'), 'on');
});

test('an older Host is refused with Update <machine> and nothing is made; a switched-off feature refuses', async () => {
  const old = rig({ features: ['relay'] });
  await assert.rejects(
    old.enroll.enroll('m', 'p', P, 'build-box'),
    (e: any) => e.code === 'update_host' && e.message === 'Update build-box.',
  );
  assert.equal(
    old.calls.some(([m]) => m === 'host.clientAdd'),
    false,
  );
  assert.equal(old.closed(), 1);
  const silent = rig({ features: null });
  await assert.rejects(silent.enroll.enroll('m', 'p', P, 'x'), (e: any) => e.code === 'update_host');
  const off = rig({ on: false });
  await assert.rejects(off.enroll.enroll('m', 'p', P, 'x'), (e: any) => e.code === 'not_allowed');
  assert.throws(
    () => off.enroll.offer('m', 'p'),
    (e: any) => e.code === 'not_allowed',
  );
  assert.equal(off.enroll.enabled(), false);
  assert.equal(off.enroll.stateOf('m', 'p'), 'off');
});

test('a Host that refuses the enrollment loses the client again', async () => {
  const r = rig({ fail: 'host.relayEnroll' });
  await assert.rejects(r.enroll.enroll('m', 'p', P, 'x'), /refused/);
  assert.deepEqual(r.calls.at(-1), ['host.clientRemove', { fingerprint: FP }]);
  assert.equal(r.enroll.stateOf('m', 'p'), 'off');
  // and a Host that also cannot take the client back is still reported by the first failure
  const both = rig({ fail: 'host.relayEnroll' });
  both.setAway(false);
  const failRemove = createPhoneEnroll({
    file: path.join(os.tmpdir(), `pe-${Date.now()}.json`),
    allowed: () => true,
    paired: async () => ({
      call: async (m: string) => {
        if (m === 'host.hello') return { features: ['clients', 'relay'] };
        if (m === 'host.challenge') return { hostId: 'a'.repeat(32), nonce: 'n' };
        if (m === 'host.clientAdd') return { fingerprint: FP };
        throw new Error(m === 'host.relayEnroll' ? 'first' : 'second');
      },
      close() {},
    }),
  });
  await assert.rejects(failRemove.enroll('m', 'p', P, 'x'), /first/);
});

test('a switch off while the enrollment runs discards the late reply and the Host side', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const r = rig({ gate });
  const running = r.enroll.enroll('m', 'p', P, 'x');
  await waitFor(() => r.calls.some(([m]) => m === 'host.relayEnroll'), 'the enrollment to reach the Host');
  assert.deepEqual(await r.enroll.forget('m', 'p'), { removed: false });
  release();
  await assert.rejects(running, (e: any) => e.code === 'cancelled');
  assert.deepEqual(
    r.calls.slice(-2).map(([m]) => m),
    ['host.clientRemove', 'host.relayForget'],
  );
  assert.equal(r.enroll.stateOf('m', 'p'), 'off');
  // two phones enrol independently, and enrolling again replaces the old relay link
  const two = rig();
  await two.enroll.enroll('m', 'a', P, 'x');
  await two.enroll.enroll('m', 'b', P, 'x');
  assert.equal(two.enroll.list('m').length, 2);
  const again = { ...P, relay: { ...RELAY, hostId: 'h_phone0000000000000002' } };
  await two.enroll.enroll('m', 'a', again, 'x');
  assert.deepEqual(two.calls.at(-1), ['host.relayForget', { hostId: RELAY.hostId }]);
});

test('offer, forget and a Host that was away', async () => {
  const r = rig();
  r.enroll.offer('m', 'p');
  assert.equal(r.enroll.stateOf('m', 'p'), 'offered');
  assert.deepEqual(r.enroll.list('m'), [{ pairId: 'p', fingerprint: null, state: 'offered' }]);
  // an offer needs no Host call to withdraw
  assert.deepEqual(await r.enroll.forget('m', 'p'), { removed: true });
  assert.equal(r.calls.length, 0);
  assert.deepEqual(await r.enroll.forget('m', 'p'), { removed: false });
  // enrolled, then switched off while the Host is away: remembered, told when it is back
  await r.enroll.enroll('m', 'p', P, 'x');
  r.setAway(true);
  r.enroll.offer('m', 'p');
  assert.equal(r.enroll.stateOf('m', 'p'), 'on', 'an offer never replaces an enrollment');
  await r.enroll.forget('m', 'p');
  assert.equal(r.enroll.stateOf('m', 'p'), 'off');
  assert.deepEqual(r.enroll.list('m'), [{ pairId: 'p', fingerprint: FP, state: 'off' }]);
  await r.enroll.retry('m');
  assert.equal(r.enroll.list('m').length, 1, 'still away');
  r.setAway(false);
  await Promise.all([r.enroll.retry('m'), r.enroll.retry('m')]);
  assert.deepEqual(r.enroll.list('m'), []);
  assert.deepEqual(
    r.calls.slice(-2).map(([m]) => m),
    ['host.clientRemove', 'host.relayForget'],
  );
  await r.enroll.retry('m');
  // an unreadable file reads as none
  fs.writeFileSync(r.file, '{ not json');
  assert.deepEqual(r.make().list('m'), []);
});
