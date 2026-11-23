// Mobile Remote end to end, scenario 1: QR pairing on the real relay, Mac stack and phone runtime, with the safety number both sides show, a second device, and a request over the sealed channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, sleep } from './support/mobileStack.ts';

test('a phone scans the QR, both sides show the same safety number, and a request crosses the sealed channel', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  assert.equal(phone.snap().phase, 'ready');

  await phone.pair(await mac.qr());
  const shown = phone.snap().safetyNumber;
  assert.match(String(shown), /\d/, 'the phone shows a safety number while the Mac asks');
  await until(() => mac.confirms.length === 1, 'the Mac to ask');
  assert.equal(mac.confirms[0].safetyNumber, shown, 'the Mac shows the number the phone shows');
  assert.equal(mac.confirms[0].device.name, 'Du’s iPhone');

  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const [pair] = phone.snap().pairs;
  assert.deepEqual(
    mac.remote.devices.list().map((d: any) => d.pairId),
    [pair.pairId],
    'the Mac lists the phone under the same pair',
  );

  await phone.runtime.connect(pair.pairId);
  assert.equal(phone.snap().phase, 'online');
  const hello = await phone.ask('machine.hello');
  assert.equal(hello.app, '1.2.3');
  assert.ok(hello.capabilities.methods.includes('chat.follow'));
});

test('a second phone pairs under its own pair and both talk to the Mac independently', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const one = await startPhone(relay, { id: 'phone-1' });
  const two = await startPhone(relay, { id: 'phone-2' });
  await one.pair(await mac.qr(), 'First phone');
  await until(() => one.snap().pairs.length === 1 && one.snap().safetyNumber === null, 'the first pair');
  await two.pair(await mac.qr(), 'Second phone');
  await until(() => two.snap().pairs.length === 1 && two.snap().safetyNumber === null, 'the second pair');

  const pairs = [one.snap().pairs[0].pairId, two.snap().pairs[0].pairId];
  assert.notEqual(pairs[0], pairs[1]);
  assert.deepEqual(
    mac.remote.devices
      .list()
      .map((d: any) => d.name)
      .sort(),
    ['First phone', 'Second phone'],
  );

  await one.runtime.connect(pairs[0]);
  await two.runtime.connect(pairs[1]);
  assert.equal((await one.ask('machine.hello')).v, 1);
  assert.equal((await two.ask('machine.hello')).v, 1);
  // a Mac event for one phone's followed chat reaches that phone only
  await one.ask('chat.follow', { chatId: 'c1' });
  mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', state: 'running' } as any);
  await until(() => one.eventsOf('turn.state').length === 1, 'the follower to hear the event');
  assert.equal(two.eventsOf('turn.state').length, 0);
});

test('a Mac that declines the pairing leaves the phone unpaired', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay, { answer: async () => 'deny' });
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => mac.confirms.length === 1, 'the Mac to be asked');
  await until(() => phone.snap().phase !== 'pairing' || phone.snap().error, 'the phone to learn the answer');
  assert.equal(mac.remote.devices.list().length, 0, 'the Mac stored no device');
  assert.deepEqual(phone.snap().pairs, [], 'the phone keeps no pair');
});

test('a phone of another account cannot join the pair', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const stranger = await startPhone(relay, { id: 'phone-x', userId: 'u2' });
  await assert.rejects(stranger.pair(await mac.qr(), 'Stranger'), /forbidden/, 'the relay refuses the join');
  await sleep(200);
  assert.equal(mac.confirms.length, 0, 'the Mac is never asked');
  assert.equal(mac.remote.devices.list().length, 0);
  assert.deepEqual(
    stranger.snap().pairs.filter((p: any) => p.macId === mac.deviceId),
    [],
  );
  // no cleanup is owed and nothing is wrong with the account: the app carries on, and the next code can be tried
  assert.equal(stranger.snap().phase, 'ready');
  assert.equal(stranger.snap().pendingPair, false);
  assert.equal(stranger.snap().pairCleanup, false);
  assert.equal(stranger.snap().error, null);
  await assert.rejects(stranger.pair(await mac.qr(), 'Stranger'), /forbidden/, 'a second try is refused the same way, not by a leftover');
});

test('a fresh pairing ends connected, with no tap, and is remembered for the next launch', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().phase === 'online', 'the phone to connect by itself');
  const [pair] = phone.snap().pairs;
  assert.equal(phone.snap().selectedPair, pair.pairId);
  assert.equal((await phone.ask('machine.hello')).app, '1.2.3');
});

test('a phone that leaves and pairs the same computer again gets new keys, and the new pair carries traffic', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the first pair to commit');
  const first = mac.remote.devices.list()[0];
  const firstChains = [first.tx.chain, first.rx.chain];
  await phone.runtime.unpair(first.pairId);
  await until(() => mac.remote.devices.list().length === 0, 'the Mac to forget the phone');

  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the second pair to commit');
  const second = mac.remote.devices.list()[0];
  assert.notEqual(second.pairId, first.pairId);
  assert.notEqual(second.tx.chain, firstChains[0]);
  assert.notEqual(second.rx.chain, firstChains[1]);
  await phone.runtime.connect(second.pairId);
  assert.equal((await phone.ask('machine.hello')).app, '1.2.3');
});
