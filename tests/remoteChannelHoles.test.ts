// The Mac's channel and a relay that keeps refusing frames (mailbox_full): a refused counter below a later sealed one stays a hole the phone must walk over, the holes are counted, and at HOLE_LIMIT only replies and notices are still sealed until the phone is heard from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { msg, openOut, rig, until, wireOf, drain } from './support/remoteChannelRig.ts';

const require = createRequire(import.meta.url);
const { HOLE_LIMIT } = require('../electron/remote/awayEvents.cjs');

const live = (id: string) => msg(id, { ev: 'items.delta', chatId: 'c1' });
const sess = (r: any) => r.channel.sessions.get(r.phone.pairId);
const reply = (id: string) => ({ id, t: 1, kind: 'reply', inReplyTo: 'q', ok: true, result: {} });
const refuse = (r: any, ctr: number, n = 1) => {
  for (let i = 0; i < n; i++) r.relay.emit('error', { code: 'mailbox_full', pair: r.phone.pairId, ctr });
};

test('the limit is half of the phone catch-up bound', () => {
  assert.equal(HOLE_LIMIT, 16384);
});

test('a refusal is a hole only when a later frame was sealed; a taken-back one and other errors are not counted', async () => {
  const r = await rig();
  const pair = r.phone.pairId;
  await r.channel.send(pair, msg('one'));
  await r.channel.send(pair, msg('two'));
  assert.equal(sess(r).holes, undefined);
  refuse(r, 1);
  assert.equal(sess(r).holes, 1, 'counter 1 stays a hole: counter 2 was sealed after it');
  refuse(r, 2);
  assert.equal(sess(r).tx.state().ctr, 1, 'the latest was taken back');
  assert.equal(sess(r).holes, 1, 'a taken-back counter is no hole');
  r.relay.emit('error', { code: 'unavailable', pair, ctr: 1 });
  r.relay.emit('error', { code: 'mailbox_full', pair: 'nope', ctr: 1 });
  r.relay.emit('error', undefined);
  assert.equal(sess(r).holes, 1);
});

test('at the limit a live event is not sealed while a reply and a notice still are; an authentic frame from the phone resets the count', async () => {
  const r = await rig();
  const pair = r.phone.pairId;
  await r.channel.send(pair, msg('one'));
  await r.channel.send(pair, msg('two'));
  refuse(r, 1, HOLE_LIMIT - 1);
  assert.equal(sess(r).holes, HOLE_LIMIT - 1);
  await r.channel.send(pair, live('below'));
  assert.equal(sess(r).tx.state().ctr, 3, 'one below the limit still seals');
  refuse(r, 1);
  assert.equal(sess(r).holes, HOLE_LIMIT);
  const ctr = sess(r).tx.state().ctr;
  const sent = r.relay.sent.length;
  await r.channel.send(pair, live('stopped'));
  await r.channel.send(pair, msg('also', { ev: 'push.titleKey', patch: { key: 'ab' } }));
  assert.equal(sess(r).tx.state().ctr, ctr, 'the chain stopped growing');
  assert.equal(r.relay.sent.length, sent);
  await r.channel.send(pair, reply('rep'));
  assert.equal(sess(r).tx.state().ctr, ctr + 1, 'a reply to the phone is sealed');
  r.channel.pauser.noticeGap(sess(r));
  await until(() => r.relay.sent.length === sent + 2);
  assert.equal(sess(r).tx.state().ctr, ctr + 2, 'a notice is sealed');
  r.relay.emit('frame', wireOf(r.phone, msg('hello')));
  await drain(r);
  assert.equal(sess(r).holes, 0, 'the phone was heard from');
  await r.channel.send(pair, live('back'));
  assert.equal(openOut(r.phone, r.relay.sent.at(-1)).id, 'back');
  assert.equal(sess(r).tx.state().ctr, ctr + 3);
});
