// Push through the relay end to end with a fake provider: dispatch, token rotation, token removal when the last pair goes (unpair or a revoked Mac), and fixed titles with an empty body for every kind.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, paired as pairedOn, P } from './support/relayKit.ts';
import { TITLES } from '../relay/src/notifier.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);
const paired = () => pairedOn(db, {});

test('rotation: a new token replaces the old one and the next push goes to it', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'old' });
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'a' });
  await r.phone.say({ t: 'push.register', platform: 'fcm', token: 'new' });
  r.clock.advance(120_000);
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'b' });
  assert.deepEqual(
    r.pushed.map((m) => [m.platform, m.token]),
    [
      ['apns', 'old'],
      ['fcm', 'new'],
    ],
  );
});

test('unpairing the only pair removes the phone token, and nothing can push to it afterwards', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat' });
  assert.equal(r.pushed.length, 1);
  await r.phone.say({ t: 'pair.remove', pair: P });
  assert.equal(await r.store.pushTokenOf('ph1'), null);
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'chat' });
  assert.equal(r.mac.socket.last().code, 'unknown_pair');
  assert.equal(r.pushed.length, 1);
});

test("a phone with another pair keeps its token when one pair is removed, and forgets that pair's chats", async () => {
  const r = await paired();
  const other = 'p_pair00002';
  const mac2 = await r.join('u1', 'mac2', 'desktop');
  await mac2.say({ t: 'pair.register', pair: other });
  await r.phone.say({ t: 'pair.join', pair: other });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat' });
  await r.mac.say({ t: 'pair.remove', pair: P });
  assert.deepEqual(await r.store.pushTokenOf('ph1'), { platform: 'apns', token: 'tok' });
  // the removed pair's "needs you" hold is gone: a "done" for the same handle on the other pair is not suppressed
  await mac2.say({ t: 'push', pair: other, kind: 'done', ref: 'chat' });
  assert.equal(mac2.socket.last().status, 'sent');
});

test("revoking the Mac drops its phone's token when that was the phone's last pair", async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'fcm', token: 'tok' });
  await r.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});

test('every provider message has the kind\'s fixed title (or "(n)"), an empty body and no chat text', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  const kinds = ['needsYou', 'done', 'momoNeedsYou'] as const;
  for (const [i, kind] of kinds.entries()) {
    r.clock.advance(120_000);
    await r.mac.say({ t: 'push', pair: P, kind, ref: `secret-chat-${i}` });
  }
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'secret-chat-x' });
  for (const m of r.pushed) {
    assert.match(m.title, new RegExp(`^(${Object.values(TITLES).join('|')})( \\(\\d+\\))?$`));
    assert.ok(!('body' in m) || m.body === '');
    assert.ok(!JSON.stringify(m.title).includes('secret'));
  }
});

test('with the durable mailbox, unpair and revoke also drop the token of a phone left with no pair', async () => {
  const r = await pairedOn(db, { durable: true });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});

test('a failing token cleanup never keeps an unpair or a revoke from completing', async () => {
  const r = await paired();
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  (r.store as any).phoneHasPair = async () => {
    throw new Error('db down');
  };
  await r.phone.say({ t: 'pair.remove', pair: P, rid: 'u' });
  assert.deepEqual(r.phone.socket.last(), { t: 'ok', op: 'pair.remove', pair: P, rid: 'u' });
  assert.equal(r.mac.socket.events('pair.removed').length, 1);
  assert.ok(r.logs.some(([e]) => e === 'push_cleanup_failed'));
  const again = await paired();
  (again.store as any).phoneHasPair = async () => {
    throw new Error('db down');
  };
  await again.hub.revoke({ userId: 'u1', deviceId: 'mac1' });
  assert.equal(again.mac.socket.closedWith?.code, 4403);
  assert.equal(again.logs.filter(([e]) => e === 'push_cleanup_failed').length, 1);
});
