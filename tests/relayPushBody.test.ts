// The relay forwards MoMo's opt-in sealed body unread (relay/src/control.mjs, push.mjs, pushPayload.mjs): only an unmerged momoNeedsYou carries `sealedBody`, it reaches APNs and FCM as `sb` with the alert body still empty, a malformed one is refused, and a push without one is unchanged.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, makeClock, paired as pairedOn, P } from './support/relayKit.ts';
import { PushService } from '../relay/src/push.mjs';
import { Store } from '../relay/src/store.mjs';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';
import { proxySender } from '../relay/src/push.mjs';

const { db, reset } = await makeDb();
beforeEach(reset);

test('a Mac’s push with a sealed body reaches the provider; a malformed one is refused', async () => {
  const r = await pairedOn(db);
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'chat-1', sealedBody: 'BLOB', rid: 'z' });
  assert.equal(r.mac.socket.last().status, 'sent');
  assert.equal(r.pushed[0].sealedBody, 'BLOB');
  for (const bad of [{ sealedBody: '' }, { sealedBody: 3 }, { sealedBody: 'x'.repeat(2049) }]) {
    await r.mac.say({ t: 'push', pair: P, kind: 'momoNeedsYou', ref: 'c', ...bad });
    assert.equal(r.mac.socket.last().code, 'bad_message', JSON.stringify(bad).slice(0, 40));
  }
});

test('only an unmerged momoNeedsYou carries the sealed body', async () => {
  const store = new Store(db as any);
  const clock = makeClock();
  const sent: any[] = [];
  const push = new PushService({ store, send: async (m: any) => (sent.push(m), { ok: true }), now: clock.now });
  const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };
  await push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok1' });
  await push.request(pair, 'needsYou', 'a', '', '', false, 'B1');
  assert.equal('sealedBody' in sent[0], false);
  clock.advance(120_000);
  await push.request(pair, 'momoNeedsYou', 'm', '', '', false, 'B2');
  assert.equal(sent[1].sealedBody, 'B2');
  clock.advance(1000);
  // a second MoMo chat within the merge window: "(2)" names no routine
  await push.request(pair, 'momoNeedsYou', 'm2', '', '', false, 'B3');
  assert.equal(sent[2].count, 2);
  assert.equal('sealedBody' in sent[2], false);
  clock.advance(120_000);
  await push.request(pair, 'momoNeedsYou', 'm3');
  assert.equal('sealedBody' in sent[3], false);
});

test('the APNs body and the FCM message carry the blob as `sb` and keep the alert body empty', () => {
  const m = {
    platform: 'apns',
    token: 't',
    kind: 'momoNeedsYou',
    title: 'MoMo needs you',
    count: 1,
    collapseId: 'c',
    ref: 'r',
    sealedBody: 'BLOB',
  } as any;
  const apns = apnsBody(m) as any;
  assert.equal(apns.sb, 'BLOB');
  assert.equal(apns.aps['mutable-content'], 1);
  assert.equal(apns.aps.alert.body, '');
  assert.equal(apns.aps.alert.title, 'MoMo needs you');
  assert.equal((fcmMessage({ ...m, platform: 'fcm' }) as any).data.sb, 'BLOB');
  // without one: nothing new
  const plain = apnsBody({ ...m, sealedBody: undefined }) as any;
  assert.equal('sb' in plain, false);
  assert.equal('mutable-content' in plain.aps, false);
  assert.equal('sb' in (fcmMessage({ ...m, platform: 'fcm', sealedBody: undefined }) as any).data, false);
});

test('the push proxy is handed the sealed body unread, and nothing when there is none', async () => {
  const calls: any[] = [];
  const f = async (url: string, init: any) => (calls.push([url, init]), { ok: true, status: 200, headers: new Headers() });
  const send = proxySender({ url: 'https://push.example/v1', fetch: f as any });
  const m = { platform: 'apns', token: 'T', kind: 'momoNeedsYou', title: 'MoMo needs you', count: 1, collapseId: 'cid', ref: 'r' } as any;
  await send({ ...m, sealedBody: 'BLOB' });
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    token: 'T',
    platform: 'apns',
    kind: 'momoNeedsYou',
    count: 1,
    collapseId: 'cid',
    sealedBody: 'BLOB',
  });
  await send(m);
  assert.equal('sealedBody' in JSON.parse(calls[1][1].body), false);
});
