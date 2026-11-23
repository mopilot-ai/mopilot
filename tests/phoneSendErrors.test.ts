// Typed phone send failures retain uncertainty and original identities across retries and device restoration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, restoreItems, isUnconfirmed, UNSURE, type QueuedSend } from '../mobile/src/outbox';
import { requestError } from '../mobile/src/remote/requestError';

function rig(failures: unknown[], idempotent = false) {
  let items: QueuedSend[] = [];
  const sent: QueuedSend[] = [];
  const box = createOutbox({
    online: () => true,
    ready: async () => true,
    idempotent: () => idempotent,
    lost: (e) => e instanceof Error && e.message === 'Connection closed',
    newId: () => 'message-123',
    now: () => 1,
    onChange: (rows) => {
      items = rows;
    },
    send: async (item) => {
      sent.push(item);
      throw failures.shift();
    },
  });
  const tick = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const start = () => box.add({ pairId: 'p', chatId: 'c', text: 'my words', attachments: [] });
  return { box, start, tick, sent, items: () => items };
}

for (const code of ['send_uncertain', 'future_protocol_code', 'reply_unreadable', 'send_conflict', 'stale']) {
  test(`${code} retains its code and refuses generic retry`, async () => {
    const r = rig([requestError({ code, message: 'Connection closed' })]);
    const id = r.start();
    await r.tick();
    const row = r.items()[0];
    assert.equal(row.errorCode, code);
    assert.equal(row.final, true);
    assert.equal(isUnconfirmed(row), code !== 'stale' && code !== 'send_conflict');
    assert.equal(r.box.retry(id), false);
    await r.box.flush('p');
    assert.equal(r.sent.length, 1);
  });
}

for (const code of ['invalid', 'forbidden', 'gone', 'failed', 'send_unavailable', 'send_capacity']) {
  test(`${code} without prior uncertainty retains retryable input`, async () => {
    const r = rig([requestError({ code, message: 'Refused before admission' })]);
    r.start();
    await r.tick();
    assert.equal(r.items()[0].errorCode, code);
    assert.equal(r.items()[0].text, 'my words');
    assert.equal(r.items()[0].final, undefined);
    assert.equal(isUnconfirmed(r.items()[0]), false);
  });
}

for (const code of ['send_unavailable', 'send_capacity']) {
  test(`${code} after an uncertain attempt cannot erase its uncertainty, even after restore`, async () => {
    const r = rig([new Error('Connection closed'), requestError({ code, message: 'Not dispatched this time' })]);
    const id = r.start();
    await r.tick();
    assert.equal(r.items()[0].error, UNSURE);
    assert.equal(r.box.retry(id), true);
    await r.tick();
    const row = r.items()[0];
    assert.equal(row.errorCode, code);
    assert.equal(isUnconfirmed(row), true);
    assert.equal(row.final, true);
    assert.equal(r.sent[0].id, r.sent[1].id);
    const restored = restoreItems(r.items(), { now: 2, pairs: new Set(['p']) });
    assert.equal(restored[0].errorCode, code);
    assert.equal(isUnconfirmed(restored[0]), true);
  });
}

test('legacy errors and malformed codes keep their existing messages; missing reply fields have a fallback', async () => {
  for (const error of [new Error('plain refusal'), Object.assign(new Error('bad code'), { code: 7 }), 7]) {
    const r = rig([error]);
    r.start();
    await r.tick();
    assert.equal(r.items()[0].errorCode, undefined);
    assert.equal(isUnconfirmed(r.items()[0]), false);
  }
  assert.equal(requestError().message, 'Request failed');
  assert.equal(requestError({}).message, 'Request failed');
  assert.equal(requestError({ message: '' }).message, 'Request failed');
  assert.equal(requestError({ code: '', message: 'Reason' }).message, 'Reason');
});

test('a repeated transport loss cannot clear an earlier uncertainty or change its identity', async () => {
  const r = rig([new Error('Connection closed'), new Error('Connection closed')]);
  const id = r.start();
  await r.tick();
  assert.equal(r.box.retry(id), true);
  await r.tick();
  assert.equal(isUnconfirmed(r.items()[0]), true);
  assert.equal(r.sent[0].id, r.sent[1].id);
  await r.box.flush('p');
  assert.equal(r.sent.length, 2, 'no automatic replay without idempotency support');
});

test('an ordinary idempotent receipt replay retains uncertainty when storage later refuses it', async () => {
  const r = rig([new Error('Connection closed'), requestError({ code: 'send_unavailable', message: 'Storage unavailable now' })], true);
  r.start();
  await r.tick();
  assert.equal(r.items()[0].status, 'queued');
  assert.equal(r.items()[0].uncertain, true);
  await r.box.flush('p');
  assert.equal(isUnconfirmed(r.items()[0]), true);
  assert.equal(r.items()[0].errorCode, 'send_unavailable');
  assert.equal(r.items()[0].final, true);
  assert.equal(r.sent[0].id, r.sent[1].id);
});
