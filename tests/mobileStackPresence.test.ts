// Mobile Remote end to end: what Settings › Mobile Remote shows as Online, on the real relay, Mac stack and phone runtime. A phone
// that has just paired is online, it goes offline when it loses the network, and it is online again when it reconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack.ts';

test('the Mac sees its phone come online at pairing, leave with the network, and return', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const [{ pairId }] = phone.snap().pairs;
  await until(() => mac.remote.presence.isOnline(pairId), 'the just-paired phone to read online');

  phone.goOffline();
  await until(() => !mac.remote.presence.isOnline(pairId), 'the Mac to hear the phone left');

  phone.comeBack();
  await phone.runtime.connect(pairId);
  await until(() => mac.remote.presence.isOnline(pairId), 'the reconnected phone to read online');
  assert.equal(mac.remote.presence.isOnline('p_someoneelse'), false);
});
