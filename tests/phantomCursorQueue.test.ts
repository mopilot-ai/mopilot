// The phantom cursor's one overlay shared by several chats: the second waits its turn, up to a cap; nothing is replayed over another's cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, approachRig, act, fakeElectron, inputAtOf, playedAtOf } from './support/phantomFakes.ts';

const require = createRequire(import.meta.url);
const { QUEUE_CAP_MS, FRAME_MS } = require('../electron/capabilities/phantomCursor.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');

test('PhantomCursor.approach: two chats share one overlay: the second waits its turn (each click waits for its own arrival), up to a cap', async () => {
  const { e, t, c } = approachRig();
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  const order: string[] = [];
  const a = act(c);
  a.done.then(() => order.push('a'));
  const b = act(c, { chatId: 'c2' });
  b.done.then(() => order.push('b'));
  await flush();
  assert.equal(e.windows[0].calls.filter((x: any) => x[0] === 'loadURL').length, 1, "chat 2's page waits for chat 1's cursor");
  assert.equal(c.queue.length, 1);
  assert.deepEqual(order, []);
  // chat 1's cursor arrives and presses, and plays out: the overlay is free, chat 2's cursor comes
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  await flush();
  assert.deepEqual(order, ['a']);
  t.fireAt(playedAtOf(plan));
  await flush();
  assert.equal(c.active.chatId, 'c2');
  assert.equal(e.windows[0].calls.filter((x: any) => x[0] === 'loadURL').length, 2);
  // chat 1 reports late: its cursor is not replayed over chat 2's, and chat 2's goes on
  assert.equal(c.finish({ chatId: 'c1', confirmed: true, token: a.token }), true);
  assert.equal(c.active.chatId, 'c2');
  assert.equal(e.windows[0].calls.filter((x: any) => x[0] === 'loadURL').length, 2);
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  await b.done;
  assert.deepEqual(order, ['a', 'b']);
  // finish of the first frees the overlay for a waiting one at once (no ring over a waiting cursor)
  const third = act(c, { chatId: 'c3' });
  const fourth = act(c, { chatId: 'c4' });
  await flush();
  assert.equal(c.queue.length, 2);
  assert.equal(c.finish({ chatId: 'c2', confirmed: true, token: b.token }), true);
  await flush();
  assert.equal(c.active.chatId, 'c3');
  assert.equal(c.queue.length, 1);
  // a waiting action that is cancelled or reports before its turn goes on and never shows
  assert.equal(c.finish({ chatId: 'c4', confirmed: false, token: fourth.token }), true);
  await fourth.done;
  assert.equal(c.queue.length, 0);
  c.cancel('c3');
  await third.done;
  // a waiting action times out after the cap and goes on with no cursor
  const slow = act(c, { chatId: 'c5' });
  const late = act(c, { chatId: 'c6' });
  await flush();
  assert.equal(c.queue.length, 1);
  assert.ok([...t.delays.values()].includes(QUEUE_CAP_MS));
  t.fireAt(QUEUE_CAP_MS);
  await late.done;
  assert.equal(c.queue.length, 0);
  assert.equal(c.active.chatId, 'c5');
  assert.equal(c.finish({ chatId: 'c6', confirmed: true, token: late.token }), true, 'its report is still one report');
  // a non-click waits too, but its input does not
  const typed = act(c, { chatId: 'c7', kind: 'type' });
  await typed.done;
  assert.equal(c.queue.length, 1);
  c.cancel('c5');
  await slow.done;
  assert.equal(c.active.chatId, 'c7');
  // dispose lets everything go
  act(c, { chatId: 'c8' });
  c.dispose();
  assert.equal(c.queue.length, 0);
  assert.equal(c.active, null);
});

test('PhantomCursor.approach: a waiting action whose window cannot be made when its turn comes goes on with no cursor', async () => {
  const o = { makeThrows: false };
  const e = fakeElectron(o);
  const { c, t } = approachRig({ electron: e.electron });
  const first = act(c);
  const second = act(c, { chatId: 'c2' });
  await flush();
  assert.equal(c.queue.length, 1);
  e.windows[0].destroyed = true;
  o.makeThrows = true;
  c.cancel('c1');
  await Promise.all([first.done, second.done]);
  assert.equal(c.active, null);
  assert.equal(c.queue.length, 0);
  t.fire();
});
