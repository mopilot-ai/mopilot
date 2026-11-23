// MoMo uses the shared queue without treating ordinary-chat replay capability as a MoMo delivery guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, restoreItems, sendCall, UNSURE, NO_ID, type QueuedSend } from '../mobile/src/outbox';

function rig() {
  let items: QueuedSend[] = [];
  const sent: QueuedSend[] = [];
  const replies: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const box = createOutbox({
    online: () => true,
    ready: async () => true,
    idempotent: () => true, // The Mac advertises ordinary chat.send support only.
    lost: () => true,
    newId: () => `message-${sent.length}-${items.length}`,
    now: () => 1,
    onChange: (next) => {
      items = next;
    },
    send: (item) => {
      sent.push(item);
      return new Promise<void>((resolve, reject) => replies.push({ resolve, reject }));
    },
  });
  const tick = async () => {
    for (let n = 0; n < 12; n++) await Promise.resolve();
  };
  return { box, sent, replies, tick, items: () => items };
}

test('a lost MoMo reply stays uncertain and never automatically replays, despite ordinary sendId support', async () => {
  const r = rig();
  r.box.add({ pairId: 'p', chatId: 'momo', text: 'hello', attachments: [], momo: true });
  await r.tick();
  r.replies[0].reject(new Error('Connection closed'));
  await r.tick();
  assert.equal(r.items()[0].status, 'failed');
  assert.equal(r.items()[0].error, UNSURE);
  void r.box.flush('p');
  await r.tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.box.retry(r.items()[0].id), true, 'manual retry remains an explicit choice');
  await r.tick();
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[0].id, r.sent[1].id);
  r.replies[1].resolve();
  await r.tick();
  assert.deepEqual(r.items(), []);
});

test('restored MoMo input keeps its routing marker and is held until persistent replay support exists', async () => {
  const r = rig();
  const saved = restoreItems([{ id: 'message-123', pairId: 'p', chatId: 'momo', text: 'hello', at: 1, momo: true }], {
    now: 2,
    pairs: new Set(['p']),
  });
  r.box.restore(saved);
  void r.box.flush('p');
  await r.tick();
  assert.equal(r.items()[0].momo, true);
  assert.equal(r.items()[0].error, NO_ID);
  assert.equal(r.items()[0].text, 'hello');
  assert.equal(r.sent.length, 0);
});

test('identical deliberate sends keep distinct ids, and ordinary chat routing remains separate', async () => {
  const r = rig();
  const input = { pairId: 'p', chatId: 'momo', text: 'hello', attachments: [], momo: true as const };
  const first = r.box.add(input);
  const second = r.box.add(input);
  assert.notEqual(first, second);
  await r.tick();
  assert.equal(r.items().length, 2);
  assert.deepEqual(sendCall(r.sent[0], true, 123), ['momo.chat.send', { id: first, text: 'hello', followUp: 'queue' }]);
  r.replies[0].resolve();
  await r.tick();
  assert.equal(r.sent.length, 2);
  assert.equal(r.items()[0].id, second);
  assert.equal(sendCall({ ...r.sent[1], momo: undefined }, false, 123)[0], 'chat.send');
  r.replies[1].resolve();
  await r.tick();
});
