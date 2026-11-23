// Mobile Remote end to end: a MoMo activity event whose item id is longer than the envelope's 64-character cap reaches the phone, which stays signed in and connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack.ts';

test('a momo.changed event with a 120-character item id leaves the phone online and able to ask', async () => {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.service.momoAllowed = () => true;
  mac.service.onMomoActivity(`claude:${'a'.repeat(120)}`);
  await until(() => phone.events.some((e: any) => e.ev === 'momo.changed'), 'the phone to hear the change');
  assert.equal(phone.snap().phase, 'online');
  assert.equal(phone.snap().error ?? null, null);
  assert.equal(phone.snap().pairs.length, 1);
  await phone.ask('chats.recent');
});
