// A chat taken in from a machine's list (#5576) is refused for its epoch when another client continued it meanwhile: the epoch is read again from the list, and the message goes once more (electron/host/remoteSend.cjs refreshEpoch); anything else about the refusal stays as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';

test('a refusal for the epoch reads the Host epoch again and sends the message once more under it', async (t) => {
  const w = world(t, { epoch: 3 });
  w.remote('c1');
  w.host.failWith = code('That chat moved on.', 'stale_epoch');
  const asked: string[] = [];
  w.config.taken = {
    refreshEpoch: (chatId) => {
      asked.push(chatId);
      w.host.failWith = null;
      w.remote(chatId, 'box', 4);
      return true;
    },
  };
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['c1']);
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['hello'],
  );
  assert.equal(w.owners.get('c1')?.epoch, 4);
});

test('when the list holds no newer epoch the refusal stands: asked once, nothing sent, the message waits for the person as before', async (t) => {
  const w = world(t, { epoch: 3 });
  w.remote('c1');
  w.host.failWith = code('That chat moved on.', 'stale_epoch');
  const asked: string[] = [];
  w.config.taken = { refreshEpoch: (chatId) => (asked.push(chatId), false) };
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['c1']);
  assert.deepEqual(w.sent, []);
  assert.equal(w.owners.get('c1')?.epoch, 3);
});

test('a chat nobody took in from a list is not asked: its refusal is the continue dialog as before', async (t) => {
  const w = world(t, { epoch: 3 });
  w.remote('c1');
  w.host.failWith = code('That chat moved on.', 'stale_epoch');
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.sent, []);
});

test("a chat taken in from the machine's list keeps the mode its Host reports: no mode rides with its messages; any other chat without one still says the default", async (t) => {
  const taken = world(t);
  taken.remote('c1');
  taken.kinds.set('c1', 'claude');
  taken.config.taken = { takenIn: (id) => id === 'c1' };
  await taken.service.send('c1', msg('from the Mac', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    taken.sent.map((s) => s.item.text),
    ['from the Mac'],
  );
  assert.deepEqual(taken.permits, [], 'no mode set on the machine');
  const own = world(t);
  own.remote('c2');
  own.kinds.set('c2', 'claude');
  await own.service.send('c2', msg('from the Mac', UUID(2)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    own.permits.map((p) => p.value),
    ['default'],
    'a chat that was not taken in: as before',
  );
});

test('a message kept while the machine is away is a pending message of its chat until it goes: the startup sweep leaves such a chat bound', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('while away', UUID(1)), 1);
  assert.equal(w.service.hasPending('c1'), true);
  assert.equal(w.service.hasPending('c2'), false);
  await w.comeBack();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['while away'],
  );
});

test('a message deleted while the epoch is read again leaves nothing to send: the send ends as the refusal did', async (t) => {
  const w = world(t, { epoch: 3 });
  w.remote('c1');
  w.host.failWith = code('That chat moved on.', 'stale_epoch');
  w.config.taken = {
    refreshEpoch: (chatId) => {
      assert.equal(w.service.remove(chatId, UUID(1)), true);
      return true;
    },
  };
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.sent, []);
  assert.equal(w.service.hasPending('c1'), false);
});
