// Security review of Mobile Remote: a phone revoked while the Mac could not reach the relay must not stay on the relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helloFor, makePhone } from './support/remotePhone.ts';
import { rig } from './support/remotePairingRig.ts';
import { deferred } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const listed = (pair: string, over: object = {}) => ({ pair, role: 'mac', joined: true, peerOnline: false, ...over });

test('the relay’s pairs that no device holds are removed there, and held, unjoined and the phone’s own are not', async () => {
  const r = rig();
  const phone = makePhone();
  const begun = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(phone, begun.payload)), 'paired');
  const held = r.devices.get(phone.id).pairId;
  r.state.cancelled.length = 0;
  await r.svc.reconcile([
    listed(held),
    listed('p_orphan0001'),
    listed('p_unjoined01', { joined: false }),
    listed('p_phoneside1', { role: 'phone' }),
    { pair: 7 },
    null,
    listed('p_orphan0002'),
  ]);
  assert.deepEqual(r.state.cancelled, ['p_orphan0001', 'p_orphan0002']);
});

test('nothing is removed while a pairing is being made, while the list is locked, or for a hello without pairs', async () => {
  const r = rig();
  await r.svc.reconcile('not a list');
  await r.svc.reconcile(undefined);
  const begun = await r.svc.begin();
  r.state.cancelled.length = 0;
  // the phone has joined the relay's pair and the Mac is waiting for its hello or the user's answer: that pair is not an orphan
  await r.svc.reconcile([listed('p_midpairing1')]);
  assert.deepEqual(r.state.cancelled, []);
  r.svc.cancel();
  r.state.cancelled.length = 0;
  r.devices.locked = true;
  await r.svc.reconcile([listed('p_orphan0003')]);
  assert.deepEqual(r.state.cancelled, []);
  void begun;
});

test('a removal that fails is left for the next connect and does not stop the others', async () => {
  const calls: string[] = [];
  const r = rig({
    removePair: async (p: string) => {
      calls.push(p);
      if (p === 'p_orphan0001') throw new Error('The relay is not connected');
    },
  });
  await r.svc.reconcile([listed('p_orphan0001'), listed('p_orphan0002')]);
  assert.deepEqual(calls, ['p_orphan0001', 'p_orphan0002']);
});

test('main wiring: the relay’s hello after a reconnect removes a pair this Mac no longer has', async () => {
  const { createRequire } = await import('node:module');
  const { fakeSafe, fs, tempDir } = await import('./support/remoteKit.ts');
  const { FakeSocket } = await import('./support/remoteSocket.ts');
  const { openRemote, DEFAULT_RELAY_URL } = createRequire(import.meta.url)('../electron/remote/runtime.cjs');
  const sockets: any[] = [];
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: async () => 'jwt' } },
    flagOn: () => true,
    chatId: () => 'chat-1',
    safeStorage: fakeSafe(),
    fs,
    // the app's default relay, or a stand-in where the build names none
    relayUrl: DEFAULT_RELAY_URL ?? 'wss://relay.example.test/v1/ws',
    createSocket: (url: string, headers: any) => (sockets.push(new FakeSocket(url, headers)), sockets.at(-1)),
  });
  await remote.sync();
  await waitFor(() => sockets.length, 'a relay socket');
  sockets[0].hello([{ pair: 'p_leftover01', role: 'mac', joined: true, peerOnline: false }]);
  await waitFor(() => sockets[0].sentOf('pair.remove').length, 'pair.remove');
  assert.deepEqual(
    sockets[0].sentOf('pair.remove').map((m: any) => m.pair),
    ['p_leftover01'],
  );
  remote.close();
});

test('a service made without a relay remover removes nothing and does not fail', async () => {
  const r = rig();
  r.svc.o.removePair = undefined;
  await r.svc.reconcile([listed('p_orphan0001')]);
  assert.deepEqual(r.state.cancelled, []);
});

test('a phone whose pairing is waiting for the user’s answer is not an orphan, and is once the answer ends the pairing', async () => {
  const answer = deferred<string>();
  const r = rig({ confirm: () => answer.promise });
  const phone = makePhone();
  const begun = await r.svc.begin();
  const pairing = r.svc.handleHello(helloFor(phone, begun.payload));
  await waitFor(() => r.state.events.some((e: any) => e.state === 'confirming'), 'the confirming state');
  // the code is spent and the phone joined the relay's pair, but the device is not saved yet
  r.state.cancelled.length = 0;
  await r.svc.reconcile([listed(r.svc.activePair.pair)]);
  assert.deepEqual(r.state.cancelled, [], 'the pair of a pairing the user is answering was removed');
  answer.resolve('deny');
  await pairing;
  const pair = 'p_declined001';
  await r.svc.reconcile([listed(pair)]);
  assert.deepEqual((r.state.cancelled as string[]).includes(pair), true);
});
