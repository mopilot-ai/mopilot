// A message kept for a machine goes only once its chat listens on the machine's new connection (electron/host/remoteSend.cjs `subscribed`, #3525): its reply is heard from the first word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';

test('the machine comes back: the kept message waits for the chat to subscribe there, then goes once', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  assert.equal((await w.service.send('c1', msg('while away', UUID(1)), 1)).action, 'queued');
  const asked: string[] = [];
  let listen: () => void = () => undefined;
  const listening = new Promise<void>((r) => (listen = r));
  w.config.subscribed = (chatId) => (asked.push(chatId), listening);
  // the outbox hears "online" before the mirror does
  await w.comeBack();
  assert.deepEqual(asked, ['c1']);
  assert.equal(w.sent.length, 0, 'not sent before the chat listens');
  listen();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.sent.map((s) => [s.item.text, s.key]),
    [['while away', UUID(1)]],
  );
});

test('the chat moved while its subscribe was answered: the message is not sent to the old machine', async (t) => {
  const w = world(t);
  w.remote('c1');
  let listen: () => void = () => undefined;
  w.config.subscribed = () => new Promise<void>((r) => (listen = r));
  const sending = w.service.send('c1', msg('hi', UUID(2)), 1);
  await new Promise((r) => setImmediate(r));
  w.remote('c1', 'other', 2);
  listen();
  await sending;
  assert.equal(w.sent.length, 0);
});
