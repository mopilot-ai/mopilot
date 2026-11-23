// What this Mac does with each answer a Host gives to a message for a chat on it (#4786, electron/host/remoteSendDelivery.cjs, remoteSend.cjs): a start the Host refused (`queued` carrying its reason) is a refused send that waits for the person with the reason and is sent again under its key, and every answer that took the message (started, steered, held, discarded, dispatched, queued behind a running turn) is delivered as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UUID, msg, world } from './support/host/remoteSendKit.ts';

const REASON = "Couldn't start Claude Code: no such binary.";
const settle = () => new Promise((r) => setImmediate(r));

test('W: a start the Host refused waits as refused with the Host’s reason, shows no sent bubble, and goes again under the same key once it can', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 1, '/srv/app');
  w.host.receipt = { action: 'queued', id: UUID(1), error: REASON };
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await settle();
  // kept, not delivered: it is the first thing in the chat's queue, marked refused, with the Host's own words
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  assert.equal(w.queues.get('c1')![0].error, `The machine: ${REASON}`, 'the row says why, naming the machine');
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', error: `The machine: ${REASON}` });
  // nothing waits for a turn that will never start: the bubble of a message that was sent is gone
  assert.equal(w.service.sent.take('c1', UUID(1)), undefined);
  // the cause is gone: Send now delivers it, under the key it always had
  w.host.receipt = { action: 'started', id: UUID(1) };
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1), UUID(1), UUID(1)],
  );
});

test('W: the first message of a chat begun here that the Host refused to start is refused the same way, and is the same start when sent again', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.service.begin('c1', { harness: 'acp:kimi' });
  w.host.receipt = { action: 'queued', id: UUID(1), error: REASON };
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await settle();
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  w.host.receipt = { action: 'started', id: UUID(1) };
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.deepEqual(
    w.started.map((s) => [s.item.harness, s.key]),
    [
      ['acp:kimi', UUID(1)],
      ['acp:kimi', UUID(1)],
    ],
  );
});

for (const action of ['started', 'steered', 'queued', 'held', 'discarded', 'dispatched']) {
  test(`B: a Host that answers ${action} with no error has taken the message: it leaves the outbox and nothing is marked refused`, async (t) => {
    const w = world(t);
    w.remote('c1');
    w.host.receipt = { action, id: UUID(1), turnId: UUID(1) };
    await w.service.send('c1', msg('hello', UUID(1)), 1);
    await settle();
    assert.equal(await w.service.sendNow('c1', UUID(1)), null);
    assert.notEqual(w.queues.get('c1')?.[0]?.waitingFor, 'hostRefused');
    assert.equal(w.sent.length, 1);
  });
}

test('B: an answer that is not a receipt at all (an older Host says nothing) is taken as before', async (t) => {
  const w = world(t);
  w.remote('c1');
  for (const receipt of [undefined, null, 'ok', { result: null }, { action: 'queued', error: '' }, { action: 'queued', error: 5 }]) {
    w.host.receipt = receipt;
    const id = UUID(w.sent.length + 1);
    await w.service.send('c1', msg('hello', id), 1);
    await settle();
    assert.equal(await w.service.sendNow('c1', id), null);
  }
  assert.equal(w.sent.length, 6);
});
