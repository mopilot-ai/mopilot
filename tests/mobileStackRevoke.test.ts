// Mobile Remote end to end, scenario 4: revoking a device, from the Mac's Settings and from the account. The phone can then neither read nor write, and the Mac neither hears it nor sends to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, sleep, type Relay } from './support/mobileStack.ts';

async function connected(relay: Relay) {
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  await phone.ask('chat.follow', { chatId: 'c1' });
  const device = mac.remote.devices.list()[0];
  return { mac, phone, pairId, device };
}
const pairsAtRelay = async (relay: Relay) => Number((await relay.db.query('SELECT count(*)::int AS n FROM relay_pairs')).rows[0].n);

test('revoking from the Mac closes the phone’s session: no reads, no writes, no events, no way back', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId, device } = await connected(relay);
  assert.equal(await mac.remote.pairing.unpair(device.id, pairId), true);

  // the Mac forgets the device and the relay forgets the pair
  assert.deepEqual(mac.remote.devices.list(), []);
  await until(async () => (await pairsAtRelay(relay)) === 0, 'the relay to drop the pair');
  // the phone is told and its session ends
  await until(() => phone.snap().phase !== 'online', 'the phone to learn the pair is gone');
  await assert.rejects(phone.ask('chats.recent'), /Connect to a computer first|closed|disconnected/);
  // nothing the Mac does reaches it any more, and the Mac stays quiet about it
  const before = phone.events.length;
  mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: 't9', status: 'running' } as any);
  await sleep(150);
  assert.equal(phone.events.length, before);
  assert.deepEqual(mac.service.phones.size, 0, 'the service serves nobody');
  // and it cannot come back with what it still holds
  await assert.rejects(phone.runtime.connect(pairId), /offline|Unknown pair|forbidden|unknown_pair/);
  assert.deepEqual(mac.remote.devices.list(), []);
});

test('a revoked phone that still sends frames is not heard by the Mac', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId, device } = await connected(relay);
  const asks = () => mac.calls.filter((c) => c[0] === 'recent').length;
  await phone.ask('chats.recent', {});
  assert.equal(asks(), 1);
  // keep the phone's channel as it was: take the pair away at the Mac and the relay only
  await mac.remote.pairing.unpair(device.id, pairId);
  await until(async () => (await pairsAtRelay(relay)) === 0, 'the relay to drop the pair');
  // the same account token, a fresh raw socket, a frame for the removed pair
  const raw = await relay.raw(await relay.keys.sign('u1', 'phone-1', { kind: 'phone' }));
  raw.ws.send(
    JSON.stringify({
      t: 'frame',
      pair: pairId,
      dir: 'p2m',
      ctr: 99,
      nonce: Buffer.alloc(24).toString('base64'),
      box: Buffer.alloc(40).toString('base64'),
    }),
  );
  await until(() => raw.inbox.some((m) => m.t === 'error'), 'the relay to refuse the frame');
  assert.equal(raw.inbox.find((m) => m.t === 'error').code, 'unknown_pair');
  assert.equal(asks(), 1, 'the Mac ran nothing for it');
  raw.ws.close();
});

test('an account-level revoke cuts the phone off and tells the Mac its pair is gone', async () => {
  const relay = await startRelay();
  const { mac, phone, device } = await connected(relay);
  const res = await fetch(`${relay.http}/v1/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await relay.revokeToken('u1', 'phone-1')}` },
  });
  assert.equal(res.status, 204);
  await until(() => phone.snap().phase !== 'online', 'the phone’s socket to be closed');
  // the phone cannot sign back in to the relay with its device identity
  const again = await relay.keys.sign('u1', 'phone-1', { kind: 'phone' });
  assert.equal(await relay.closeCodeFor(again), 4403, 'the relay closes the revoked device at once');
  // the Mac hears that the pair was removed, and stops serving it
  await until(() => mac.service.phones.size === 0, 'the Mac to stop serving the revoked phone');
  await until(() => mac.remote.devices.list().length === 0, 'the Mac to forget the revoked phone');
  assert.equal(device.id, 'phone-1');
});

test('the phone leaving removes the pair on every side, and the Mac stops serving it', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  await phone.runtime.unpair(pairId);
  assert.deepEqual(phone.snap().pairs, [], 'the phone forgot the computer and its keys');
  assert.equal(phone.snap().phase, 'offline');
  await until(async () => (await pairsAtRelay(relay)) === 0, 'the relay to drop the pair');
  await until(() => mac.remote.devices.list().length === 0, 'the Mac to forget the phone');
  assert.equal(mac.service.phones.size, 0, 'the service serves nobody');
  await assert.rejects(phone.runtime.connect(pairId), /Unknown pair/);
});

test('a computer removing the phone also clears it from the phone’s list', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId, device } = await connected(relay);
  assert.equal(await mac.remote.pairing.unpair(device.id, pairId), true);
  await until(() => phone.snap().pairs.length === 0, 'the phone to forget the removed computer');
  assert.notEqual(phone.snap().phase, 'online');
});
