// A tap on a push for a chat beyond the newest 50 still finds it: the chat list is read page by page until the handle matches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatRef } from '../mobile/src/push/chatRef';
import { controllerRig, tick } from './support/phone/push-controller-rig';

test('a tap on a push for a chat beyond the newest 50 still finds it: the list is read page by page until the handle matches', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.chats.p_a = Array.from({ length: 130 }, (_, i) => `c${i}`);
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c110'), count: 1 });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c110' });
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith('chats.recent')),
    ['chats.recent:0+50', 'chats.recent:50+50', 'chats.recent:100+50'],
    'it stops at the page that held it',
  );
  r.ctl.consumeTarget();
  // a chat that is nowhere reads every page and gives up with no target
  r.calls.length = 0;
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'gone'), count: 1 });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(r.ctl.ui().target, null);
  assert.equal(r.calls.filter((c) => c.startsWith('chats.recent')).length, 3);
});

test('a Mac that ignores the page offset (an older one) sends the same page again: the tap stops instead of reading ten of them', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.reply.use = true;
  r.reply.value = { chats: [{ id: 'c1' }, { id: 'c2' }], more: true };
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'nowhere'), count: 1 });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(r.ctl.ui().target, null);
  assert.equal(r.log.filter((l) => l === 'connect:p_a').length, 1);
  assert.equal(r.calls.filter((c) => c.startsWith('chats.recent')).length, 2, 'the second page added nothing new, so it stopped');
});

test("a tap whose connection the app's own reconnect replaced goes on once that one is online, and does not take it down again", async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.chats.p_a = ['c1'];
  await r.ctl.start();
  r.cancels.left = 1;
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c1'), count: 1 });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c1' });
  assert.equal(r.log.filter((l) => l === 'connect:p_a').length, 1, 'once the other connection is online the tap reads on it');
  // already online on that computer: no connection is made at all
  r.ctl.consumeTarget();
  r.log.length = 0;
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c1'), count: 1 });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c1' });
  assert.equal(r.log.filter((l) => l === 'connect:p_a').length, 0);
});

test('a connection that keeps being replaced is tried three times, then the tap gives up like an offline computer', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.chats.p_a = ['c1'];
  await r.ctl.start();
  r.cancels.online = false;
  r.cancels.left = 5;
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c1'), count: 1 });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(r.ctl.ui().target, null);
  assert.equal(r.log.filter((l) => l === 'connect:p_a').length, 3);
});

test("a newer tap ends the older one's retries instead of reconnecting for it", async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.chats.p_a = ['c1', 'c2'];
  await r.ctl.start();
  r.cancels.online = false;
  r.cancels.left = 1;
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c1'), count: 1 });
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_a', 'c2'), count: 1 });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_a', chatId: 'c2' });
});

test('a tap for a chat on another computer connects to it even while the first one is online', async () => {
  const r = controllerRig({ pairs: ['p_a', 'p_b'] });
  r.chats.p_a = ['a1'];
  r.chats.p_b = ['b1'];
  await r.ctl.start();
  r.handlers.tap({ kind: 'needsYou', ref: chatRef('p_b', 'b1'), count: 1 });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(r.ctl.ui().target, { pairId: 'p_b', chatId: 'b1' });
  assert.deepEqual(
    r.log.filter((l) => l.startsWith('connect:')),
    ['connect:p_a', 'connect:p_b'],
  );
});
