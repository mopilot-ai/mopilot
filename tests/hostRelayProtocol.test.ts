// The relay methods of the Host wire (shared/host/schema.mjs, host/src/protocol.mjs): each is parsed strictly (ids, the credential,
// the keys and the relay address), gated on the `relay` feature both ends declare, served by the Host's relay links, refused as
// unsupported by a Host without them, and open only to a paired client (host/src/server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../shared/host/schema.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createGuard } from '../host/src/guard.mjs';

const KEY = Buffer.alloc(32, 1).toString('base64');
const ENROLL = {
  relayUrl: 'wss://relay.example/v1/ws',
  hostId: 'h_host0000000000001',
  secret: 'S'.repeat(43),
  pairId: 'p_hostpair01',
  appPub: KEY,
  appEphPub: KEY,
};

test('relay enrollments parse strictly and every relay method needs the relay feature', () => {
  assert.deepEqual(S.parseParams('host.relayEnroll', ENROLL), ENROLL);
  assert.deepEqual(
    S.parseParams('host.relayEnroll', { ...ENROLL, relayUrl: 'ws://127.0.0.1:8787/v1/ws' }).relayUrl,
    'ws://127.0.0.1:8787/v1/ws',
  );
  for (const [field, value, message] of [
    ['relayUrl', 'https://relay.example/v1/ws', /relay address/],
    ['relayUrl', 'ws://relay.example/v1/ws', /relay address/],
    ['relayUrl', 'ws://192.168.1.5:8787/v1/ws', /relay address/],
    ['relayUrl', `wss://${'a'.repeat(3000)}/`, /relay address/],
    ['relayUrl', 7, /relay address/],
    ['hostId', 'h_short', /relay host id/],
    ['secret', 'short', /relay credential/],
    ['pairId', 'nope', /relay pair id/],
    ['appPub', 'AAAA', /public key/],
    ['appEphPub', undefined, /public key/],
  ] as const) {
    assert.throws(() => S.parseParams('host.relayEnroll', { ...ENROLL, [field]: value }), message);
  }
  assert.deepEqual(S.parseParams('host.relayForget', { hostId: ENROLL.hostId }), { hostId: ENROLL.hostId });
  assert.throws(() => S.parseParams('host.relayForget', {}), /relay host id/);
  assert.deepEqual(S.parseParams('host.relayStatus', { extra: 1 }), {});
  assert.ok(S.FEATURES.includes('relay'));
  for (const m of ['host.relayEnroll', 'host.relayForget', 'host.relayStatus']) assert.deepEqual(S.REQUIRES[m], ['relay']);
});

test('the Host serves the relay methods through its links, refuses them without links, and an older app is refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const calls: any[] = [];
  const relay: any = {
    enroll: (p: any) => (calls.push(['enroll', p.hostId]), { hostPub: KEY, hostEphPub: KEY }),
    forget: (p: any) => (calls.push(['forget', p.hostId]), { removed: true }),
    status: () => ({ links: [] }),
  };
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), relay }).connection(() => undefined);
  await conn.call('host.hello', S.helloParams());
  assert.deepEqual(await conn.call('host.relayEnroll', ENROLL), { hostPub: KEY, hostEphPub: KEY });
  assert.deepEqual(await conn.call('host.relayForget', { hostId: ENROLL.hostId }), { removed: true });
  assert.deepEqual(await conn.call('host.relayStatus', {}), { links: [] });
  assert.deepEqual(calls, [
    ['enroll', ENROLL.hostId],
    ['forget', ENROLL.hostId],
  ]);
  const none = createProtocol({ runtime, epochs, guard, status: () => ({}) }).connection(() => undefined);
  await none.call('host.hello', S.helloParams());
  await assert.rejects(none.call('host.relayStatus', {}), (e: any) => e.code === 'unsupported');
  const old = createProtocol({ runtime, epochs, guard, status: () => ({}), relay }).connection(() => undefined);
  await old.call('host.hello', { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'relay') });
  await assert.rejects(old.call('host.relayStatus', {}), (e: any) => e.code === 'feature_missing');
});
