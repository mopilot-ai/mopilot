// The stream batcher's second queue (electron/harness/coreBatcher.cjs): windows that do not show a chat get its deltas on the
// slow tick, every flush sends both queues, and a flush from outside keeps the frame tick running.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBatcher, WATCHED_MS, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

let sent: { event: any; scope: any }[] = [];
const made: any[] = [];
let background: boolean | 'throw' = true;
const make = (o: any = {}) => {
  const b = new CoreBatcher({
    send: (_family: string, event: any, _target: any, scope: any) => (sent.push({ event, scope }), true),
    hasBackground: () => {
      if (background === 'throw') throw new Error('gone');
      return background;
    },
    ...o,
  });
  for (const [family, c] of Object.entries(familyChats({ chatOf: (key: string) => key }))) b.register(family, c);
  made.push(b);
  return b;
};
beforeEach(() => {
  for (const b of made.splice(0)) b.cancel();
  sent = [];
  background = true;
});
const codex = (chat: string, delta: string) => ({
  kind: 'notification',
  chatId: chat,
  method: 'item/agentMessage/delta',
  params: { threadId: chat, turnId: 't', itemId: 'm', delta },
});
/** each send as text@frame or text@slow */
const shape = () =>
  sent.map((s) => `${s.event.params?.delta ?? s.event.kind}@${s.scope ? (s.scope.background ? 'slow' : 'frame') : 'all'}`);

test('the frame tick sends the watched share, the slow tick the background share, each joined', () => {
  const b = make();
  b.push('codex', codex('c', 'lead'));
  assert.deepEqual(shape(), ['lead@frame', 'lead@slow'], 'the leading edge reaches both');
  sent = [];
  b.push('codex', codex('c', 'a'));
  b.push('codex', codex('c', 'b'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['ab@frame']);
  sent = [];
  b.push('codex', codex('c', 'd'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['d@frame']);
  sent = [];
  mock.timers.tick(BACKGROUND_MS);
  assert.deepEqual(shape(), ['abd@slow'], 'one joined delta for the slow windows');
  sent = [];
  mock.timers.tick(BACKGROUND_MS * 2);
  assert.deepEqual(shape(), [], 'nothing left, no timer left');
});

test('any other event of the chat, the bound and a flush from outside send both queues first, and keep the frame tick', () => {
  const b = make({ maxPending: 10 });
  b.push('codex', codex('c', 'lead'));
  sent = [];
  b.push('codex', codex('c', 'a'));
  b.push('codex', { kind: 'turnStarted', chatId: 'c' });
  assert.deepEqual(shape(), ['a@frame', 'a@slow', 'turnStarted@all']);
  sent = [];
  b.push('codex', codex('c', 'b'));
  b.flushAll();
  assert.deepEqual(shape(), ['b@frame', 'b@slow']);
  sent = [];
  b.push('codex', codex('c', 'x'));
  assert.deepEqual(shape(), [], 'the tick still runs after the flush: no leading edge');
  b.push('codex', codex('c', '1234567890'));
  assert.deepEqual(shape(), ['x1234567890@frame', 'x1234567890@slow'], 'past the bound');
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(sent.length, 2, 'the slow timer found nothing');
});

test('without a window outside the chat the background queue is not kept; a check that throws counts as none', () => {
  background = false;
  const b = make();
  b.push('codex', codex('c', 'lead'));
  b.push('codex', codex('c', 'a'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['lead@frame', 'a@frame']);
  background = 'throw';
  sent = [];
  b.push('codex', codex('c', 'b'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['b@frame']);
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(sent.length, 1);
});

test('chats on the slow tick are sent together, and a chat idle on the frame tick leaves no queue behind', () => {
  const b = make();
  b.push('codex', codex('c1', 'l1'));
  b.push('codex', codex('c2', 'l2'));
  sent = [];
  b.push('codex', codex('c1', 'a'));
  b.push('codex', codex('c2', 'b'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape().sort(), ['a@frame', 'l2b@frame']);
  sent = [];
  mock.timers.tick(BACKGROUND_MS);
  assert.deepEqual(shape().sort(), ['a@slow', 'l2b@slow']);
  b.flushAll();
  assert.equal(b.pending, 0);
});

test('flushAll with nothing pending, and cancel with no timers, do nothing', () => {
  const b = make();
  b.flushAll();
  b.cancel();
  assert.deepEqual(shape(), []);
});

test('the slow tick skips a chat with nothing for the background, and cancel drops a pending slow tick', () => {
  const only = new Set(['bg']);
  // no window on screen: both ticks are 250 ms, and the slow one meets a chat that has only frame-tick text
  const b = make({ hasBackground: (chat: string) => only.has(chat), watched: () => false });
  b.push('codex', codex('bg', 'l1'));
  b.push('codex', codex('plain', 'l2'));
  sent = [];
  b.push('codex', codex('plain', 'b'));
  b.push('codex', codex('bg', 'a'));
  mock.timers.tick(BACKGROUND_MS);
  assert.deepEqual(shape().sort(), ['a@frame', 'a@slow', 'l2b@frame']);
  sent = [];
  b.push('codex', codex('bg', 'c'));
  b.cancel();
  mock.timers.tick(BACKGROUND_MS * 2);
  assert.deepEqual(shape(), []);
});

test('a slow flush leaves no empty record behind', () => {
  const b = make();
  b.push('codex', codex('c', 'lead'));
  b.push('codex', codex('c', 'a'));
  mock.timers.tick(WATCHED_MS);
  mock.timers.tick(WATCHED_MS);
  assert.equal(b.pending, 1, 'the slow share is still waiting');
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(b.pending, 0);
});
