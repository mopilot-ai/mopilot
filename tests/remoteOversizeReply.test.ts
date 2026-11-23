// A reply too large for one sealed frame (256 KB): the channel neither burns a counter nor remembers it, and the service answers the phone with a small error instead of leaving the request to time out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/remote/envelope.mjs';
import { msg, request, wireOf, drain, openOut, rig as channelRig } from './support/remoteChannelRig.ts';
import { rig as serviceRig, settle } from './support/remote-kit.ts';

const bigReply = (inReplyTo: string) => ({
  id: 'm_big',
  t: 3,
  kind: 'reply',
  inReplyTo,
  ok: true,
  result: { text: 'x'.repeat(E.MAX_FRAME_BYTES) },
});

test('channel: a message over 256 KB is refused before it takes a counter, and an oversize reply is not remembered', async () => {
  const r = await channelRig();
  r.relay.emit('frame', wireOf(r.phone, request('m_1')));
  await drain(r);
  await r.channel.send(r.phone.pairId, msg('m_a'));
  const before = r.relay.sent.at(-1).ctr;
  await assert.rejects(r.channel.send(r.phone.pairId, bigReply('m_1') as any), { code: 'size' });
  assert.equal(r.channel.sessions.get(r.phone.pairId).seen.get('m_1'), null, 'the failed reply is not what a retry would be answered with');
  await r.channel.send(r.phone.pairId, msg('m_b'));
  assert.equal(r.relay.sent.at(-1).ctr, before + 1, 'the refused message used no counter');
  assert.equal(openOut(r.phone, r.relay.sent.at(-1)).id, 'm_b');
  assert.equal(r.channel.sessions.get(r.phone.pairId).closed, null);
});

test('service: a reply the transport cannot carry (too large) is answered with a small error the phone can show', async () => {
  const r = serviceRig({ ops: { read: async () => ({ chatId: 'c1', rows: [{ text: 'x'.repeat(2000) }] }) } });
  const send = r.link.mac.send.bind(r.link.mac);
  r.link.mac.send = async (pairId: string, m: any) => {
    if (JSON.stringify(m).length > 1000) throw Object.assign(new Error('frame over 256 KB'), { code: 'size' });
    return send(pairId, m);
  };
  const p = r.phone('p1');
  const reply = await p.ask('chat.read', { chatId: 'c1' }, 'read-1');
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'failed');
  assert.match(reply.error.message, /too large/);
  // a retry of the same request gets the same small answer without running the read again
  const reads = r.calls.filter((c) => c[0] === 'read').length;
  const again = await p.ask('chat.read', { chatId: 'c1' }, 'read-1');
  assert.equal(again.error.code, 'failed');
  assert.equal(r.calls.filter((c) => c[0] === 'read').length, reads);
  await settle();
  // an ordinary failure to send (the relay is down) stays quiet: a small error would not get through either
  const sentAfter: any[] = [];
  r.link.mac.send = async (_pairId: string, m: any) => {
    sentAfter.push(m);
    throw new Error('The relay is not accepting messages');
  };
  await p.ask('chat.read', { chatId: 'c1' }, 'read-2');
  assert.equal(sentAfter.length, 1, 'one attempt, no second message');
});

test('chat.follow: a chat whose last items are too large for one frame opens with fewer of them, down to none when even one cannot be shortened, and a small one is untouched', async () => {
  const asked: number[] = [];
  const itemsOf = (size: number) => async (_id: string, n: number) => (
    asked.push(n),
    { itemsShape: 'rows', items: Array.from({ length: n }, (_, i) => ({ role: 'assistant', text: `${i}${'x'.repeat(size)}` })) }
  );
  const fits = (snap: any) => Buffer.byteLength(JSON.stringify(snap)) <= 200_000;

  const long = serviceRig({ ops: { items: itemsOf(30_000) } });
  const snap = (await long.phone('p1').ask('chat.follow', { chatId: 'c1', items: 50 })).result;
  assert.ok(fits(snap), 'the snapshot fits one frame');
  assert.equal(snap.items.length, 6, 'the newest items that fit: 50 halved until 6 do');
  assert.deepEqual(asked, [50, 25, 12, 6]);

  asked.length = 0;
  const many = async (_id: string, n: number) => (
    asked.push(n),
    {
      itemsShape: 'rows',
      items: Array.from({ length: n }, () => ({ role: 'tool', parts: Array.from({ length: 2000 }, () => 'q'.repeat(300)) })),
    }
  );
  const huge = serviceRig({ ops: { items: many } });
  const none = (await huge.phone('p1').ask('chat.follow', { chatId: 'c1', items: 50 })).result;
  assert.deepEqual(none.items, [], 'an item that cannot be shortened to fit is left out, and the chat still opens with its live stream');
  assert.equal(asked.at(-1), 0);

  asked.length = 0;
  const small = serviceRig({ ops: { items: itemsOf(100) } });
  const phone = small.phone('p1');
  assert.equal((await phone.ask('chat.follow', { chatId: 'c1', items: 50 })).result.items.length, 50);
  assert.deepEqual(asked, [50], 'asked once');
  assert.equal((await phone.ask('chat.follow', { chatId: 'c1', items: 0 })).result.items.length, 0);
});

test('chat.follow: a single item too large for one frame is shortened and sent rather than left out', async () => {
  const asked: number[] = [];
  const items = async (_id: string, n: number) => (
    asked.push(n),
    {
      itemsShape: 'rows',
      items: Array.from({ length: n }, () => ({ role: 'tool', parts: Array.from({ length: 10 }, () => 'q'.repeat(30_000)) })),
    }
  );
  const snap = (await serviceRig({ ops: { items } }).phone('p1').ask('chat.follow', { chatId: 'c1', items: 1 })).result;
  assert.deepEqual(asked, [1], 'asked for the one item only');
  assert.equal(snap.items.length, 1, 'the item stays');
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 200_000, 'the snapshot fits one frame');
  assert.match(snap.items[0].parts[0], /\(shortened\)$/, 'its long strings are cut and noted');
});

test('an error whose own message is too large is answered with the small error too', async () => {
  const r = serviceRig({
    ops: {
      read: async () => {
        throw new Error('e'.repeat(400_000));
      },
    },
  });
  const send = r.link.mac.send.bind(r.link.mac);
  r.link.mac.send = async (pairId: string, m: any) => {
    if (JSON.stringify(m).length > 1000) throw Object.assign(new Error('frame over 256 KB'), { code: 'size' });
    return send(pairId, m);
  };
  const reply = await r.phone('p1').ask('chat.read', { chatId: 'c1' });
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /too large/);
});

test('chat.follow: when the newest single item is too large it is shortened, not left out', async () => {
  const r = serviceRig({
    ops: {
      items: async (_id: string, n: number) => ({
        itemsShape: 'rows',
        items: Array.from({ length: n }, () => ({ role: 'tool', text: 'o'.repeat(300_000) })),
      }),
    },
  });
  const snap = (await r.phone('p1').ask('chat.follow', { chatId: 'c1', items: 50 })).result;
  // the newest items are cut to share the frame (a huge output no longer drops everything before it)
  assert.ok(snap.items.length >= 1);
  for (const item of snap.items) assert.match(item.text, /shortened\)$/);
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 200_000);
});
