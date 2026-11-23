// Chat retirement durably purges queued app inputs and fences any delivery already waiting at an async boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';

test('deleting a remote chat durably retires its queued inputs before ownership is forgotten and a reconnect occurs', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('must not revive', UUID(99)), 1);
  w.service.forgetChat('c1');
  const fresh = w.make();
  assert.deepEqual(w.outboxes.at(-1).pending('c1'), []);
  await w.comeBack();
  await fresh.resume();
  assert.equal(w.sent.length, 0);
});

test('deletion during the subscription await retires an in-flight input before its native dispatch', async (t) => {
  const w = world(t);
  w.remote('c1');
  let release: any;
  let entered: any;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  w.config.subscribed = async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const sending = w.service.send('c1', msg('retired while preparing', UUID(98)), 1);
  await waiting;
  w.service.forgetChat('c1');
  release();
  await sending;
  assert.equal(w.sent.length, 0);
});
