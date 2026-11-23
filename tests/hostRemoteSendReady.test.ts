// A message waiting for a machine is sent when the machine is usable, whichever of the registry row and the connection turns ready last (electron/host/remoteSend.cjs onRowChange, resume, drain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

/** Both sides away, then one message kept for the machine. */
async function waiting(t: any) {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  assert.equal((await w.service.send('c1', msg('hi', UUID(1)), 1)).action, 'queued');
  return w;
}

test('the connection comes up first, the registry row later: the message goes when the row turns online', async (t) => {
  const w = await waiting(t);
  await w.connectionUp();
  assert.equal(w.sent.length, 0, 'the row still says offline, so the machine is not usable yet');
  assert.equal(w.queues.get('c1')?.[0].waitingFor, 'host');
  await w.rowUp();
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1)],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
    'nothing waits after the ack',
  );
});

test('the registry row turns online first, the connection later: the message goes when the connection is up', async (t) => {
  const w = await waiting(t);
  await w.rowUp();
  assert.equal(w.sent.length, 0, 'the connection is still down');
  await w.connectionUp();
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1)],
  );
});

test('a row change while the machine is still away sends nothing and keeps the message queued', async (t) => {
  const w = await waiting(t);
  for (const fn of [...w.rowListeners]) fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.sent.length, 0);
  assert.equal(w.queues.get('c1')?.[0].waitingFor, 'host');
});

test('both sides turn ready while a drain is deciding the machine is away: the drain looks again and sends once', async (t) => {
  const w = await waiting(t);
  // the drain in flight is parked at its first read of the connection, as if the answer were slow
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const state = w.host.state;
  w.host.state = () => {
    if (first) {
      first = false;
      return 'offline';
    }
    return state();
  };
  const slow = w.service.sendNow('c1', UUID(1));
  // the connection and the row both turn ready before the drain ends
  w.host.up = true;
  w.row.status = 'online';
  for (const fn of [...w.listeners]) fn('online');
  for (const fn of [...w.rowListeners]) fn();
  release();
  await gate;
  const result = await slow;
  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1)],
    'sent exactly once under its own key',
  );
});

test('events during a drain that is not offline do not send anything twice', async (t) => {
  const w = world(t);
  w.remote('c1');
  const hold: { go: () => void } = { go: () => undefined };
  const wait = new Promise<void>((r) => (hold.go = r));
  const send = w.host.send;
  w.host.send = async (...a: Parameters<typeof send>) => (await wait, send(...a));
  const pending = w.service.send('c1', msg('hi', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  await w.rowUp();
  await w.connectionUp();
  hold.go();
  assert.deepEqual(await pending, { action: 'started', id: UUID(1) });
  assert.equal(w.sent.length, 1);
});

test('a message the Host refuses stays queued, marked, and a later row change does not send it again', async (t) => {
  const w = await waiting(t);
  w.host.failWith = code('no', 'invalid');
  await w.connectionUp();
  await w.rowUp();
  assert.equal(w.queues.get('c1')?.[0].waitingFor, 'hostRefused');
  assert.equal(w.sent.length, 0);
});

test('after dispose a row change does nothing and the listener is gone', async (t) => {
  const w = await waiting(t);
  w.service.dispose();
  assert.equal(w.rowListeners.size, 0);
  await w.connectionUp();
  assert.equal(w.sent.length, 0);
});

test('the registry is not listened to until a connection is followed (it may be inside its own change callback at creation)', async (t) => {
  const w = world(t);
  assert.equal(w.rowListeners.size, 0);
  w.remote('c1');
  await w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.equal(w.rowListeners.size, 1, 'one listener for the service, however many machines');
});

test('a refused message is not offered to the Host again by every registry change; send now still tries it', async (t) => {
  const w = await waiting(t);
  w.host.failWith = code('no', 'invalid');
  await w.connectionUp();
  await w.rowUp();
  w.host.failWith = null;
  await w.rowUp();
  await w.rowUp();
  assert.equal(w.sent.length, 0, 'still refused, not sent again on its own');
  assert.equal(w.queues.get('c1')?.[0].waitingFor, 'hostRefused');
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
});

test('a message whose chat moved waits for the continue dialog, not for a registry change', async (t) => {
  const w = await waiting(t);
  w.remote('c1', 'box', 2);
  await w.connectionUp();
  await w.rowUp();
  assert.equal(w.queues.get('c1')?.[0].waitingFor, 'hostMoved');
  const before = w.reports.length;
  await w.rowUp();
  assert.equal(w.sent.length, 0);
  assert.equal(w.reports.length, before);
});
