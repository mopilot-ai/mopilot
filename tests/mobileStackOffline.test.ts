// Mobile Remote end to end, scenario 3: an offline phone. What the Mac sends meanwhile waits in the relay's durable mailbox, the phone gets it in order on return and acknowledges it, and a delivery whose receipt was lost is tolerated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, type Relay } from './support/mobileStack.ts';

async function following(relay: Relay) {
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  await phone.ask('chat.follow', { chatId: 'c1' });
  return { mac, phone, pairId };
}
const stored = async (relay: Relay) => Number((await relay.db.query('SELECT count(*)::int AS n FROM remote_durable.frames')).rows[0].n);
const states = (phone: any) => phone.eventsOf('turn.state').map((e: any) => e.turnId);
/** An event the Mac must deliver (not a live view the phone reads again): it waits in the mailbox for an absent phone. */
const kept = (mac: any, pairId: string, n: number) =>
  mac.remote.channel.send(pairId, { id: `k${n}`, t: n, kind: 'event', ev: 'momo.changed', area: `a${n}` });
const areas = (phone: any) => phone.eventsOf('momo.changed').map((e: any) => e.area);
const sealed = (mac: any, pairId: string) => mac.remote.channel.sessions.get(pairId).tx.state().ctr as number;
const turn = (mac: any, n: number) => mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: `t${n}`, status: 'running' });

test('events the Mac must deliver wait in the mailbox while the phone is offline and arrive in order, then are acknowledged', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await following(relay);
  kept(mac, pairId, 1);
  await until(() => areas(phone).length === 1, 'the first event');

  phone.goOffline();
  await until(() => phone.snap().phase === 'offline', 'the phone to notice');
  for (const n of [2, 3, 4]) kept(mac, pairId, n);
  await until(async () => (await stored(relay)) === 3, 'the relay to hold three frames');
  assert.deepEqual(areas(phone), ['a1'], 'nothing reached the offline phone');

  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to reconnect');
  await until(() => areas(phone).length === 4, 'the queued events');
  assert.deepEqual(areas(phone), ['a1', 'a2', 'a3', 'a4'], 'in the order the Mac sent them, each once');
  await until(async () => (await stored(relay)) === 0, 'the acknowledged frames to be dropped by the relay');
  // and the session is live again both ways
  turn(mac, 5);
  await until(() => states(phone).length === 1, 'a live event after the replay');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('live-view events are not sealed for an offline phone: nothing is held, the counter stays, and the phone returns without a catch-up', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await following(relay);
  turn(mac, 1);
  await until(() => states(phone).length === 1, 'the first event');

  phone.goOffline();
  await until(() => phone.snap().phase === 'offline', 'the phone to notice');
  await until(() => mac.remote.presence.isAbsent(pairId), 'the Mac to learn the phone is away');
  const before = sealed(mac, pairId);
  for (const n of [2, 3, 4]) turn(mac, n);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await stored(relay), 0, 'the relay holds nothing for them');
  assert.equal(sealed(mac, pairId), before, 'the send chain did not move');

  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to reconnect');
  assert.notEqual(phone.snap().catchingUp, true, 'no catch-up is needed');
  turn(mac, 5);
  await until(() => states(phone).length === 2, 'a live event after the return');
  assert.deepEqual(states(phone), ['t1', 't5'], 'the skipped ones are read again by the phone, not replayed');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('a frame delivered twice because its receipt was lost is applied once and the session stays open', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await following(relay);
  phone.env.dropAcks = true;
  turn(mac, 1);
  turn(mac, 2);
  await until(() => states(phone).length === 2, 'both events');
  assert.ok((await stored(relay)) >= 2, 'the relay keeps what was never acknowledged');

  phone.goOffline();
  await until(() => phone.snap().phase === 'offline', 'the phone to notice');
  phone.comeBack();
  phone.env.dropAcks = false;
  phone.foreground();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to reconnect');
  await until(async () => (await stored(relay)) === 0, 'the redelivered frames to be acknowledged now');
  assert.deepEqual(states(phone), ['t1', 't2'], 'the duplicates were not applied again');
  assert.notEqual(phone.snap().phase, 'error');
  turn(mac, 3);
  await until(() => states(phone).length === 3, 'the next event');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('when the Mac stops, the phone goes offline and requests fail clearly', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await following(relay);
  mac.stop();
  await until(() => phone.snap().phase === 'offline', 'the phone to learn the Mac left');
  await assert.rejects(phone.ask('machine.hello'), /Connect to a computer first|offline/);
  await assert.rejects(phone.runtime.connect(pairId), /offline/);
});

test('a long absence with hundreds of live events costs the Mac no counters, and the phone returns without a catch-up', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await following(relay);
  phone.goOffline();
  await until(() => phone.snap().phase === 'offline', 'the phone to notice');
  await until(() => mac.remote.presence.isAbsent(pairId), 'the Mac to learn the phone is away');
  const before = sealed(mac, pairId);
  const N = 450;
  for (let n = 1; n <= N; n++) turn(mac, n);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await stored(relay), 0, 'nothing is queued for the absent phone');
  assert.equal(sealed(mac, pairId), before, 'the chain did not run ahead of the phone');

  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to reconnect');
  assert.notEqual(phone.snap().catchingUp, true);
  turn(mac, N + 1);
  await until(() => states(phone).length === 1, 'the first live event after the return');
  assert.deepEqual(states(phone), [`t${N + 1}`]);
});

test('thirty requests at once all get their own answers', async () => {
  const relay = await startRelay();
  const { phone } = await following(relay);
  const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => phone.ask('chats.recent', { limit: i + 1 })));
  assert.equal(answers.length, 30);
});
