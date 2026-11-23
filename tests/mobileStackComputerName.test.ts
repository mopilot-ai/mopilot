// Mobile Remote end to end: the phone learns the computer's own name when it connects, keeps it with the pair, and says "Computer" for a Mac that sends none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack.ts';

async function paired(machineName?: () => string) {
  const relay = await startRelay();
  const mac = await startMac(relay, machineName ? { machineName } : {});
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  return { phone, pairId: phone.snap().pairs[0].pairId };
}

test('the list shows the computer by its own name once the phone has connected to it', async () => {
  const { phone, pairId } = await paired(() => 'Studio-Mac.local');
  assert.equal(phone.snap().pairs[0].name, undefined, 'a paired computer has no name until it has said hello');
  await phone.runtime.connect(pairId);
  assert.equal(phone.snap().pairs[0].name, undefined, 'connecting alone asks the computer nothing');
  assert.equal((await phone.ask('machine.hello')).name, 'Studio-Mac.local'.replace('.local', ''));
  await until(() => phone.snap().pairs[0].name === 'Studio-Mac', 'the name to arrive');
  await phone.ask('machine.hello');
  assert.equal(phone.snap().pairs[0].name, 'Studio-Mac', 'a second hello keeps the same name');
});

test('a computer that sends no name stays unnamed and connecting still works', async () => {
  const { phone, pairId } = await paired(() => '');
  await phone.runtime.connect(pairId);
  assert.equal(phone.snap().phase, 'online');
  assert.equal((await phone.ask('machine.hello')).name, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(phone.snap().pairs[0].name, undefined);
});
