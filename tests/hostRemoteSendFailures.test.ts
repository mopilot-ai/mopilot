// Remote sends under failure (electron/host/remoteSend.cjs): an unreadable outbox, Send now while the machine is away, a refusal without a message, and a service built with no options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { createRemoteSend } = require('../electron/host/remoteSend.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');

test('an outbox that cannot be read ends the drain as failed, reported; the message stays waiting and other chats still go', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.remote('c2');
  w.goAway();
  await w.service.send('c1', msg('a', UUID(1)), 1);
  await w.service.send('c2', msg('b', UUID(2)), 1);
  const ob = w.outboxes[0];
  const realPending = ob.pending;
  ob.pending = (chatId: string) => {
    if (chatId === 'c1') throw code('unreadable', 'outbox_unreadable');
    return realPending(chatId);
  };
  const realDrain = ob.drain;
  ob.drain = (chatId: string, ...rest: any[]) =>
    chatId === 'c1' ? Promise.reject(code('unreadable', 'outbox_unreadable')) : realDrain(chatId, ...rest);
  const receipt = await w.service.send('c1', msg('again', UUID(3)), 1).catch((e: Error) => e);
  assert.equal((receipt as any).action, 'queued');
  assert.ok(w.reports.length >= 1);
  await w.comeBack();
  assert.deepEqual(
    w.sent.map((s) => s.chatId),
    ['c2'],
  );
});

test('Send now while the machine is still away says so; a refusal without a message gets a plain one; a service built with no options still works', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('x', UUID(1)), 1);
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', waitingFor: 'host' });
  w.host.up = true;
  w.row.status = 'online';
  w.host.failWith = Object.assign({}, { code: 'invalid' });
  await w.service.sendNow('c1', UUID(1));
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', error: "The machine couldn't read that message." });
  // no paused or report given: nothing to tell, nothing thrown
  const bare = createRemoteSend({
    outbox: w.outboxes[0],
    ownerOf: () => ({ hostId: 'box', epoch: 1 }),
    hostFor: () => null,
    rowOf: () => undefined,
    state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
    tray: queueItem,
  });
  bare.onSessionPatch({ chatId: 'c1', patch: { approvals: [{ id: 'a' }] } });
  bare.dispose();
  const failing = createRemoteSend({
    outbox: {
      ...w.outboxes[0],
      add: () => undefined,
      pending: () => [],
      drain: () => Promise.resolve({ sent: 0, stopped: 'failed', error: new Error('late') }),
    },
    ownerOf: () => ({ hostId: 'box', epoch: 1 }),
    hostFor: () => w.host as any,
    rowOf: () => ({ status: 'online' }),
    state: () => ({ get: () => ({ queue: [] }), patch: () => undefined }),
    tray: queueItem,
  });
  assert.equal((await failing.send('c1', msg('y', UUID(2)), 1)).action, 'started');
});
