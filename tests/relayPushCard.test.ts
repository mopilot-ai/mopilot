// The relay forwards MoMo's card handle (relay/src/control.mjs, push.mjs): a momoNeedsYou push's `card` reaches the provider unless the push merged, no other kind carries one, and a malformed one is refused.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClock, paired as pairedOn, P } from './support/relayKit.ts';
import { PushService } from '../relay/src/push.mjs';
import { Store } from '../relay/src/store.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);

test('a Mac’s push with a card reaches the provider; a malformed card is refused', async () => {
  const r = await pairedOn(db);
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'chat-1', card: 'h-card', rid: 'z' });
  assert.equal(r.mac.socket.last().status, 'sent');
  assert.equal(r.pushed[0].card, 'h-card');
  for (const bad of [{ card: '' }, { card: 3 }, { card: 'x'.repeat(129) }]) {
    await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'c', ...bad });
    assert.equal(r.mac.socket.last().code, 'bad_message', JSON.stringify(bad).slice(0, 40));
  }
});

test('only an unmerged momoNeedsYou carries the card', async () => {
  const store = new Store(db as any);
  const clock = makeClock();
  const sent: any[] = [];
  const push = new PushService({ store, send: async (m: any) => (sent.push(m), { ok: true }), now: clock.now });
  const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  await push.request(pair, 'needsYou', 'a', '', 'h1');
  assert.equal('card' in sent[0], false);
  clock.advance(120_000);
  await push.request(pair, 'momoNeedsYou', 'm', '', 'h2');
  assert.equal(sent[1].card, 'h2');
  clock.advance(1000);
  // a second MoMo chat within the merge window: "(2)" opens MoMo's chat, not one card
  await push.request(pair, 'momoNeedsYou', 'm2', '', 'h3');
  assert.equal(sent[2].count, 2);
  assert.equal('card' in sent[2], false);
  clock.advance(120_000);
  await push.request(pair, 'momoNeedsYou', 'm3');
  assert.equal('card' in sent[3], false);
});
