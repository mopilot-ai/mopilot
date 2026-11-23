// The Mac's channel and a phone that is away: its live-view events are not sealed (the counter stays), replies and one-time messages still are, unknown presence seals as before, and a counter the relay refused is taken back only while no later frame was sealed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msg, openOut, pairing, rig, until } from './support/remoteChannelRig.ts';

const live = (id: string) => msg(id, { ev: 'items.delta', chatId: 'c1' });
const ctrOf = (r: any) => r.channel.sessions.get(r.phone.pairId).tx.state().ctr;

test('a phone known to be away: live-view events are not sealed or sent and the counter stays; replies, notices and one-time events still are', async () => {
  let absent = true;
  const r = await rig({ phoneAbsent: () => absent });
  const pair = r.phone.pairId;
  for (let i = 0; i < 50; i++) await r.channel.send(pair, live(`d${i}`));
  assert.equal(r.relay.sent.length, 0, 'nothing reached the relay');
  assert.equal(ctrOf(r), 0, 'the counter did not move');
  await r.channel.send(pair, msg('k', { ev: 'push.titleKey', patch: { key: 'ab' } }));
  await r.channel.send(pair, { id: 'rep', t: 1, kind: 'reply', inReplyTo: 'q', ok: true, result: {} });
  assert.equal(r.relay.sent.length, 2);
  assert.deepEqual(
    r.relay.sent.map((w: any) => openOut(r.phone, w).id),
    ['k', 'rep'],
    'the phone opens them with no gap in the chain',
  );
  assert.equal(ctrOf(r), 2);
  absent = false;
  await r.channel.send(pair, live('back'));
  assert.equal(openOut(r.phone, r.relay.sent.at(-1)).id, 'back', 'sealing resumes with the next counter');
  assert.equal(ctrOf(r), 3);
});

test('presence unknown (an older relay): every event is sealed as before', async () => {
  const r = await rig();
  for (let i = 0; i < 3; i++) await r.channel.send(r.phone.pairId, live(`d${i}`));
  assert.equal(r.relay.sent.length, 3);
  assert.equal(ctrOf(r), 3);
  const away = await rig({ phoneAbsent: () => undefined as any });
  await away.channel.send(away.phone.pairId, live('d'));
  assert.equal(away.relay.sent.length, 1, 'only a true answer skips');
});

test('a pair the presence source says nothing of is another pair: only the absent phone is skipped', async () => {
  const one = pairing('phone-1', 'p_pairedone01');
  const two = pairing('phone-2', 'p_pairedtwo02');
  const r = await rig({ phones: [one, two], phoneAbsent: (pair) => pair === 'p_pairedone01' });
  await r.channel.send('p_pairedone01', live('a'));
  await r.channel.send('p_pairedtwo02', live('b'));
  assert.equal(r.relay.sent.length, 1);
  assert.equal(openOut(two, r.relay.sent[0]).id, 'b');
});

test('a notice is sealed for an absent phone too', async () => {
  const r = await rig({ phoneAbsent: () => true });
  r.channel.pauser.noticeGap(r.channel.sessions.get(r.phone.pairId));
  await until(() => r.relay.sent.length === 1);
  assert.equal(openOut(r.phone, r.relay.sent[0]).ev, 'pair.resync');
});

test('a mailbox_full refusal takes the counter back only while no later frame was sealed', async () => {
  const r = await rig();
  const pair = r.phone.pairId;
  await r.channel.send(pair, msg('one'));
  await r.channel.send(pair, msg('two'));
  // the relay refused the first: a later frame was sealed, so the chain keeps its place
  r.relay.emit('error', { code: 'mailbox_full', pair, ctr: 1 });
  assert.equal(ctrOf(r), 2);
  // the relay refused the latest: nothing was sealed after it, so its counter is free again
  r.relay.emit('error', { code: 'mailbox_full', pair, ctr: 2 });
  assert.equal(ctrOf(r), 1);
  await r.channel.send(pair, msg('three'));
  assert.equal(ctrOf(r), 2);
  assert.equal(openOut(r.phone, r.relay.sent[0]).id, 'one');
  // the retaken counter 2 carries the new message, which the phone opens (it never saw the refused one)
  assert.equal(openOut(r.phone, r.relay.sent[2]).id, 'three');
  // another counter, another code, an unknown pair or nothing at all change nothing
  r.relay.emit('error', { code: 'mailbox_full', pair, ctr: 9 });
  r.relay.emit('error', { code: 'unavailable', pair, ctr: 2 });
  r.relay.emit('error', { code: 'mailbox_full', pair: 'nope', ctr: 2 });
  r.relay.emit('error', { code: 'mailbox_full' });
  r.relay.emit('error', undefined);
  assert.equal(ctrOf(r), 2);
  // the same refusal twice takes the counter back once
  r.relay.emit('error', { code: 'mailbox_full', pair, ctr: 2 });
  r.relay.emit('error', { code: 'mailbox_full', pair, ctr: 2 });
  assert.equal(ctrOf(r), 1);
});

test('the channel stops listening to refusals when it stops', async () => {
  const r = await rig();
  r.channel.stop();
  assert.equal(r.relay.listeners(), 0);
});
