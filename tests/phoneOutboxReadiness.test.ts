// Canceling a queued head during readiness must not strand the next message when that readiness check fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, type QueuedSend } from '../mobile/src/outbox';
import { waitFor } from './support/waitFor';

test('canceling the head before a failed capability check lets the next message discover readiness and send', async () => {
  let n = 0;
  let probes = 0;
  let reject: (error: Error) => void = () => {};
  let items: QueuedSend[] = [];
  const sent: string[] = [];
  const box = createOutbox({
    online: () => true,
    idempotent: () => true,
    lost: () => false,
    ready: () =>
      ++probes === 1
        ? new Promise<boolean>((_resolve, fail) => {
            reject = fail;
          })
        : Promise.resolve(true),
    send: async (item) => {
      sent.push(item.text);
    },
    newId: () => `send-${++n}`,
    now: () => n,
    onChange: (next) => {
      items = next;
    },
  });
  const add = (text: string) => box.add({ text, chatId: 'same', pairId: 'p', attachments: [] });
  const first = add('first');
  add('second');
  await waitFor(() => probes === 1, 'first capability check');
  assert.equal(box.cancel(first), true);
  reject(new Error('capability request failed'));
  await waitFor(() => sent.length === 1, 'remaining message gets a fresh check', { timeoutMs: 300 });
  assert.deepEqual(sent, ['second']);
  await waitFor(() => items.length === 0, 'remaining message accepted');
  assert.equal(probes, 2);
});
