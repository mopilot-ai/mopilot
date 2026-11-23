// Push token registration on the relay: a phone registers, replaces and removes its APNs or FCM token against its device id, the token dies with the device, and no token (or sealed blob) ever reaches the Mac.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, paired as pairedOn, P, idle, settle } from './support/relayKit.ts';
import { MAX_SEALED } from '../relay/src/pushPayload.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = () => pairedOn(db, {});

test('register, replace and remove: one token per device, the newest wins, and removal forgets it', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'old' });
  await r.phone.say({ t: 'push.register', platform: 'fcm', token: 'new' });
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'fcm', token: 'new' });
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'a' });
  assert.deepEqual([r.pushed[0].platform, r.pushed[0].token], ['fcm', 'new']);
  await r.phone.say({ t: 'push.unregister' });
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});

test('revoking the phone deletes its token', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.hub.revoke({ userId: 'u1', deviceId: 'ph1' });
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});

test('no token and no sealed blob is ever sent to the Mac', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'SECRET-DEVICE-TOKEN' });
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat-1', sealed: 'SEALED-TITLE' });
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'chat-2' });
  assert.ok(r.mac.socket.sent.length >= 2);
  const wire = JSON.stringify([...r.mac.socket.sent, ...r.phone.socket.sent]);
  assert.ok(!wire.includes('SECRET-DEVICE-TOKEN'));
  assert.ok(!wire.includes('SEALED-TITLE'));
  assert.deepEqual(
    r.mac.socket.of('push.result').map((m) => m.status),
    ['sent', 'sent'],
  );
});

test('a sealed title rides one chat\'s push only: it is validated, forwarded, and dropped from a merged "(n)"', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  for (const bad of [5, 'x'.repeat(MAX_SEALED + 1)]) {
    await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'c', sealed: bad });
    assert.equal(r.mac.socket.last().code, 'bad_message');
  }
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'one', sealed: 'S1' });
  assert.equal(r.pushed[0].sealed, 'S1');
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'two', sealed: 'S2' });
  assert.equal(r.pushed[1].count, 2);
  assert.equal('sealed' in r.pushed[1], false);
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'three' });
  assert.equal('sealed' in r.pushed[2], false);
});

test('MoMo and offline pushes never carry a sealed title, even if the Mac sends one', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'm', sealed: 'S' });
  assert.equal('sealed' in r.pushed[0], false);
});

test('a provider\'s late "dead token" for a replaced token does not remove the new one', async () => {
  let release: (() => void) | null = null;
  const r = await pairedOn(db, {
    send: (m: any) =>
      new Promise((resolve) => (release = () => resolve(m.token === 'old' ? { ok: false, invalidToken: true } : { ok: true }))),
  });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'old' });
  r.mac.h.message(JSON.stringify({ t: 'push', pair: P, kind: 'done', ref: 'a' }));
  await idle(20);
  // `say` waits for the hub's tracked work, which includes the held push: the registration is fired without waiting
  r.phone.h.message(JSON.stringify({ t: 'push.register', platform: 'apns', token: 'new' }));
  await idle(20);
  release!();
  await settle(r.hub);
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'apns', token: 'new' });
  // a dead token that is still the current one is removed
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'old' });
  r.mac.h.message(JSON.stringify({ t: 'push', pair: P, kind: 'needsYou', ref: 'b' }));
  await idle(20);
  release!();
  await settle(r.hub);
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});
