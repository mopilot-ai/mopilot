// Mobile Remote end to end: a Mac session that fails locally (a burst of frames, a failed save) comes back by itself, and nothing the phone sent in the meantime is lost or handled twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, type Relay } from './support/mobileStack.ts';
import { deferred } from './support/async-scenarios.ts';

async function online(relay: Relay) {
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('c1');
  return { mac, phone };
}
/** What reached the Mac's chat, in order. */
const reached = (mac: any) => mac.calls.filter((c: any[]) => c[0] === 'send').map((c: any[]) => c[1].text);

test('a failed save on the Mac does not strand the phone: the message it could not accept is delivered again, once, and the pair keeps working', async () => {
  const relay = await startRelay();
  const { mac, phone } = await online(relay);
  const update = mac.remote.devices.update.bind(mac.remote.devices);
  let failures = 1;
  mac.remote.devices.update = async (...args: any[]) => {
    if (args[1]?.rx && failures-- > 0) throw new Error('disk full');
    return update(...args);
  };
  phone.runtime.send('c1', 'one');
  await until(() => reached(mac).length === 1 && phone.snap().outbox.length === 0, 'the message to arrive after the failed save', 25_000);
  phone.runtime.send('c1', 'two');
  await until(() => reached(mac).length === 2 && phone.snap().outbox.length === 0, 'the next message', 25_000);
  assert.deepEqual(reached(mac), ['one', 'two'], 'each once, in order');
  const stats = mac.remote.channel.stats;
  assert.equal(stats.pauses.storage, 1);
  assert.equal(stats.reopens, 1);
  assert.equal(stats.paused, 0);
  assert.ok(stats.reconnects >= 1);
});

test('a burst larger than the Mac takes at once is not lost: every message reaches the chat once, in order, even those sent while the Mac reconnects', async () => {
  const relay = await startRelay();
  const { mac, phone } = await online(relay);
  const gate = deferred<void>();
  const update = mac.remote.devices.update.bind(mac.remote.devices);
  mac.remote.devices.update = async (...args: any[]) => {
    if (args[1]?.rx) await gate.promise;
    return update(...args);
  };
  // raw requests, not the phone's queue: the phone may give up on its own copy while the Mac is reconnecting, and the Mac must still take each frame once
  const asked = Array.from({ length: 300 }, (_, i) =>
    phone.ask('chat.send', { chatId: 'c1', text: `m${i}`, sendId: `burst-${String(i).padStart(3, '0')}` }).catch(() => null),
  );
  await new Promise((r) => setTimeout(r, 400));
  gate.resolve();
  // a second wave while the Mac is reconnecting to get the first one again
  await new Promise((r) => setTimeout(r, 300));
  const second = Array.from({ length: 30 }, (_, i) =>
    phone.ask('chat.send', { chatId: 'c1', text: `n${i}`, sendId: `later-${String(i).padStart(3, '0')}` }).catch(() => null),
  );
  await Promise.all([...asked, ...second]);
  await until(() => reached(mac).length === 330, 'all 330 messages to reach the chat', 60_000);
  const got = reached(mac);
  assert.equal(new Set(got).size, 330, 'each once');
  assert.deepEqual(
    got.filter((t: string) => t.startsWith('m')),
    Array.from({ length: 300 }, (_, i) => `m${i}`),
    'the first wave in order',
  );
  assert.deepEqual(
    got.filter((t: string) => t.startsWith('n')),
    Array.from({ length: 30 }, (_, i) => `n${i}`),
    'the second wave in order',
  );
  assert.ok(mac.remote.channel.stats.pauses.overload >= 1, 'the burst did overload the session');
  assert.equal(mac.remote.channel.stats.paused, 0, 'and it came back');
});
