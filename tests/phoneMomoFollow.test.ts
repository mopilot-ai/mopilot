// MoMo follow and unfollow run in order, and a request queued for a computer that has since changed is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momoRuntime } from './support/phone/momo-kit';
// the phone sources load by variable path so the node typecheck does not pull the phone's React types in
const followPath = '../mobile/src/momo/follow';
const apiPath = '../mobile/src/momo/api';
const { momoFollow } = await import(followPath);
const { messageOf } = await import(apiPath);

test('requests keep their order, a refused one does not stop the next, and each carries its own params', async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const m = momoRuntime({
    'momo.chat.follow': () => new Promise<void>((resolve) => (release = () => (order.push('follow'), resolve()))),
    'momo.chat.unfollow': () => (order.push('unfollow'), Promise.reject(new Error('gone'))),
  });
  const first = momoFollow(m.runtime, 'momo.chat.follow');
  const second = momoFollow(m.runtime, 'momo.chat.unfollow');
  const third = momoFollow(m.runtime, 'momo.chat.follow');
  assert.equal(m.calls.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  await assert.rejects(second, /gone/);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await third;
  assert.deepEqual(order, ['follow', 'unfollow', 'follow']);
  assert.deepEqual(
    m.calls.map(([method, p]) => [method, p]),
    [
      ['momo.chat.follow', { items: 50 }],
      ['momo.chat.unfollow', {}],
      ['momo.chat.follow', { items: 50 }],
    ],
  );
});

test('a request queued for another computer is refused rather than sent to the new one', async () => {
  const m = momoRuntime({ 'momo.chat.follow': () => ({}) });
  const stale = momoFollow(m.runtime, 'momo.chat.follow');
  m.set({ generation: 2 });
  await assert.rejects(stale, /computer changed/);
  assert.equal(m.calls.length, 0);
  const other = momoFollow(m.runtime, 'momo.chat.follow');
  m.set({ selectedPair: 'q' });
  await assert.rejects(other, /computer changed/);
});

test('a failure is shown by its message, else as text', () => {
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('plain'), 'plain');
});
