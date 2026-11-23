// A chat begun for a machine (electron/host/remoteSend.cjs begin, stop): its first message starts it on the Host in its folder, later ones carry the folder, a start survives a restart, and Stop reaches the Host now or fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { UUID, code, msg, world } from './support/host/remoteSendKit.ts';
import { deferred } from './support/async-scenarios.ts';
import { parseUserText } from '../shared/userText.mjs';
const require = createRequire(import.meta.url);
const { STOP_AWAY } = require('../electron/host/remoteSend.cjs');

test('the first message of a chat begun here starts it on the Host in its folder; the ones after are plain sends that carry the folder', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.service.begin('c1', { harness: 'acp:kimi', projectId: 'p1' });
  const first = await w.service.send('c1', { ...msg('hello', UUID(1)), opts: { model: 'm' } }, 1);
  const second = await w.service.send('c1', msg('more', UUID(2)), 1);
  assert.deepEqual(
    [first, second],
    [
      { action: 'started', id: UUID(1) },
      { action: 'started', id: UUID(2) },
    ],
  );
  assert.deepEqual(w.started, [
    { chatId: 'c1', item: { text: 'hello', harness: 'acp:kimi', projectId: 'p1', cwd: '/srv/app', model: 'm' }, key: UUID(1) },
  ]);
  assert.deepEqual(w.sent, [{ chatId: 'c1', item: { text: 'more', cwd: '/srv/app' }, key: UUID(2) }]);
});

test('a chat that starts while its machine is away keeps its start with the message, across a restart, and the retry is the same request', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.goAway();
  w.service.begin('c1', { harness: 'acp:kimi' });
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  w.service.dispose();
  const again = w.make();
  t.after(() => again.dispose());
  await w.comeBack();
  await again.resume();
  assert.deepEqual(w.started, [
    { chatId: 'c1', item: { text: 'hello', harness: 'acp:kimi', projectId: null, cwd: '/srv/app' }, key: UUID(1) },
  ]);
  assert.deepEqual(w.sent, []);
});

test('a start the Host will not take stays queued marked, and a message that could not be kept leaves the chat still to be started', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.service.begin('c1', { harness: 'acp:kimi' });
  // attachments other than images and files are refused before anything is kept: the start waits for the message that can go
  const refused = await w.service.send('c1', { ...msg('look', UUID(1)), attachments: [{ kind: 'skill' }] }, 1);
  assert.equal(refused!.action, 'failed');
  w.host.failWith = Object.assign(new Error('The Host lacks isolation.'), { code: 'feature_missing' });
  const queued = await w.service.send('c1', msg('hello', UUID(2)), 1);
  assert.equal(queued!.action, 'queued');
  assert.equal((queued as any).error, 'The machine: The Host lacks isolation.');
  w.host.failWith = null;
  assert.deepEqual(await w.service.sendNow('c1', UUID(2)), { status: 'sent' });
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0].item.harness, 'acp:kimi');
});

test('selected text and the typed question travel together in a machine chat’s first message', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.service.begin('c1', { harness: 'codex' });
  const selection = { kind: 'selection', text: 'the selected passage' };
  assert.equal((await w.service.send('c1', { ...msg('explain this', UUID(1)), attachments: [selection] }, 1)).action, 'started');
  const { text, selections } = parseUserText(w.started[0].item.text);
  assert.equal(text, 'explain this');
  assert.deepEqual(selections, [selection.text]);
});

test('editing the first queued side-chat draft preserves its start and later messages send normally', async (t) => {
  const w = world(t);
  w.remote('side', 'box', 0, '/srv/app');
  w.goAway();
  const sideChat = { sourceId: 'parent', epoch: 4 };
  w.owners.set(sideChat.sourceId, { hostId: 'box', ownerHostId: 'box', epoch: sideChat.epoch, folder: '/srv/app' });
  w.service.begin('side', { harness: 'codex', sideChat });
  assert.equal((await w.service.send('side', msg('draft', UUID(1)), 1)).action, 'queued');
  assert.equal(w.service.remove('side', UUID(1)), true);
  assert.equal((await w.service.send('side', msg('edited draft', UUID(2)), 1)).action, 'queued');
  assert.equal((await w.service.send('side', msg('next', UUID(3)), 1)).action, 'queued');
  await w.comeBack();
  await w.service.resume();
  assert.deepEqual(
    w.started.map((c) => [c.key, c.item.text, c.item.sideChat]),
    [[UUID(2), 'edited draft', sideChat]],
  );
  assert.deepEqual(
    w.sent.map((c) => [c.key, c.item.text]),
    [[UUID(3), 'next']],
  );
});

test('the stream can accept a side chat before its start RPC returns', async (t) => {
  const w = world(t);
  w.remote('parent', 'box', 0, '/srv/app');
  w.remote('side', 'box', 0, '/srv/app');
  w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
  w.host.start = async (id: string, item: any, opts: any) => {
    w.service.sent.seen(id, item.text, opts.key);
    throw code('Connection dropped after sending', 'host_unreachable');
  };
  await w.service.send('side', msg('first', UUID(1)), 1);
  w.host.start = async () => assert.fail('the accepted start must not be sent again');
  await w.service.send('side', msg('follow-up', UUID(2)), 1);
  assert.deepEqual(
    w.sent.map((c) => c.item.text),
    ['follow-up'],
  );
});

for (const ack of ['late stream', 'attachment-only receipt']) {
  test(`${ack} reconciles an uncertain first send before replacement is allowed`, async (t) => {
    const w = world(t);
    w.remote('parent', 'box', 0, '/srv/app');
    w.service.sent.seen('unknown-chat', 'a message sent elsewhere');
    w.remote('side', 'box', 0, '/srv/app');
    w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
    w.host.failWith = code('Connection dropped after sending', 'host_unreachable');
    assert.equal((await w.service.send('side', msg('first', UUID(1)), 1)).action, 'queued');
    assert.equal(w.queues.get('side')?.[0]?.pendingStart, true);
    assert.throws(() => w.service.remove('side', UUID(1)), /may already have this message/);
    assert.equal(w.outboxes.at(-1).pending('side')[0].key, UUID(1));
    w.host.failWith = Object.assign(code('Retry could not be sent', 'host_unreachable'), { notSent: true });
    await w.service.sendNow('side', UUID(1));
    assert.throws(() => w.service.remove('side', UUID(1)), /may already have this message/);
    w.host.failWith = code('The Host cannot confirm the interrupted request', 'request_interrupted');
    await w.service.sendNow('side', UUID(1));
    assert.throws(() => w.service.remove('side', UUID(1)), /may already have this message/);
    w.host.failWith = code('Permissions changed during the retry', 'policy_refused');
    await w.service.sendNow('side', UUID(1));
    assert.equal(w.queues.get('side')?.[0]?.refusal.code, 'policy_refused');
    assert.equal(w.queues.get('side')?.[0]?.pendingStart, true);
    w.service.sent.seen('side', undefined, UUID(99));
    assert.throws(() => w.service.remove('side', UUID(1)), /may already have this message/);

    w.service.sent.seen('side', ack === 'late stream' ? 'first' : undefined, UUID(1));
    assert.deepEqual(w.queues.get('side'), []);
    w.host.failWith = null;
    await w.service.send('side', msg('follow-up', UUID(2)), 1);
    assert.deepEqual(w.started, []);
    assert.deepEqual(
      w.sent.map((c) => c.item.text),
      ['follow-up'],
    );
  });
}

test('a queued side chat from a previous app run cannot deliver an unbound first message', async (t) => {
  const w = world(t);
  w.remote('parent', 'box', 0, '/srv/app');
  w.remote('side', 'box', 0, '/srv/app');
  w.goAway();
  w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
  assert.equal((await w.service.send('side', msg('queued', UUID(1)), 1)).action, 'queued');
  w.service.dispose();
  w.config.canSend = (id) => id !== 'side';
  const restarted = w.make();
  t.after(() => restarted.dispose());
  await w.comeBack();
  await restarted.resume();
  assert.deepEqual([w.started, w.sent], [[], []]);
  assert.equal(w.outboxes.at(-1).pending('side')[0].options.item.text, 'queued');
});

test('a side chat that lost its parent preserves the draft and does not offer a retry of the old epoch', async (t) => {
  const w = world(t);
  w.remote('parent', 'box', 0, '/srv/app');
  w.remote('side', 'box', 0, '/srv/app');
  w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
  w.host.failWith = code('The parent chat changed. Open a new side chat from it.', 'side_chat_parent_changed');
  const receipt = await w.service.send('side', msg('keep this draft', UUID(1)), 1);
  assert.equal(receipt.waitingFor, 'hostRefused');
  assert.equal(w.queues.get('side')?.[0].refusal.retry, false);
  assert.equal(w.queues.get('side')?.[0].text, 'keep this draft');
  assert.equal(w.service.remove('side', UUID(1)), true);
});

test('a first side-chat message definitely unwritten to the Host can still be replaced', async (t) => {
  const w = world(t);
  w.remote('parent', 'box', 0, '/srv/app');
  w.remote('side', 'box', 0, '/srv/app');
  w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
  w.host.failWith = Object.assign(code('Connection dropped before sending', 'host_unreachable'), { notSent: true });
  assert.equal((await w.service.send('side', msg('first', UUID(1)), 1)).action, 'queued');
  assert.equal(w.service.remove('side', UUID(1)), true);
  assert.deepEqual(w.outboxes.at(-1).pending('side'), []);
});

test('a first send queued offline rechecks a deleted or changed parent before dispatch', async (t) => {
  const w = world(t);
  w.goAway();
  const owner = { hostId: 'box', ownerHostId: 'box', epoch: 0, folder: '/srv/app' };
  const parents = [undefined, { ...owner, ownerHostId: 'other' }, { ...owner, epoch: 1 }, { ...owner, folder: '/srv/other' }];
  for (const [index, next] of parents.entries()) {
    const parent = `parent-${index}`;
    const side = `side-${index}`;
    w.owners.set(parent, owner);
    w.owners.set(side, owner);
    w.service.begin(side, { harness: 'codex', sideChat: { sourceId: parent, epoch: owner.epoch } });
    assert.equal((await w.service.send(side, msg('keep this queued draft', UUID(index)), 1)).action, 'queued');
    if (next) w.owners.set(parent, next);
    else w.owners.delete(parent);
  }
  await w.comeBack();
  await w.service.resume();
  assert.deepEqual(w.started, []);
  assert.equal(w.queues.size, parents.length);
  for (const queue of w.queues.values()) {
    assert.equal(queue[0].refusal.code, 'side_chat_parent_changed');
    assert.equal(queue[0].text, 'keep this queued draft');
  }
});

test('the queue reports an outstanding first dispatch and still reconciles if its parent is removed', { timeout: 3000 }, async (t) => {
  const w = world(t);
  w.remote('parent', 'box', 0, '/srv/app');
  w.remote('side', 'box', 0, '/srv/app');
  w.service.begin('side', { harness: 'codex', sideChat: { sourceId: 'parent', epoch: 0 } });
  const started = deferred<void>();
  const receipt = deferred();
  w.host.start = async () => {
    started.resolve();
    return receipt.promise;
  };
  const sending = w.service.send('side', msg('first', UUID(1)), 1);
  await started.promise;
  try {
    assert.equal(w.queues.get('side')?.[0]?.pendingStart, true);
    assert.throws(() => w.service.remove('side', UUID(1)), /may already have this message/);
  } finally {
    receipt.reject(code('Connection dropped after sending', 'host_unreachable'));
    await sending;
  }
  w.owners.delete('parent');
  w.host.start = async () => assert.fail('a retry cannot dispatch against the deleted parent');
  await w.service.sendNow('side', UUID(1));
  assert.equal(w.queues.get('side')?.[0]?.refusal.code, 'side_chat_parent_changed');
  assert.equal(w.queues.get('side')?.[0]?.pendingStart, true);
  w.service.sent.seen('side', 'first', UUID(1));
  assert.deepEqual(w.queues.get('side'), []);
});

test('a chat with no folder on record sends without one', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, null);
  await w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.deepEqual(w.sent[0].item, { text: 'hi' });
});

test('Stop on a chat on a machine reaches the Host now under a key of its own, or fails; it is never kept for later', async (t) => {
  const w = world(t);
  assert.equal(w.service.stop('local-chat', 't1'), null);
  w.remote('c1');
  await w.service.stop('c1', 't1');
  assert.equal(w.host.stops.length, 1);
  assert.equal(w.host.stops[0][0], 'c1');
  assert.ok(w.host.stops[0][1].length >= 8);
  w.goAway();
  await assert.rejects(Promise.resolve(w.service.stop('c1', 't1')), { message: STOP_AWAY });
  w.config.hostFor = () => null as any;
  await assert.rejects(Promise.resolve(w.service.stop('c1', 't1')), { message: STOP_AWAY });
  assert.equal(w.host.stops.length, 1);
});

test('the mode a chat is in here reaches its Host: with the start, and before the first message after it changes; a mode the Host does not know is not sent as one', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.modes.set('c1', 'read-only');
  w.service.begin('c1', { harness: 'codex' });
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  assert.equal(w.started[0].item.permission, 'read-only');
  // Reapply before each message: a restarted Host may have forgotten its mode.
  await w.service.send('c1', msg('again', UUID(2)), 1);
  assert.deepEqual(w.permits, [{ chatId: 'c1', value: 'read-only' }]);
  w.modes.set('c1', 'full-access');
  await w.service.send('c1', msg('third', UUID(3)), 1);
  assert.deepEqual(
    w.permits.map((p) => p.value),
    ['read-only', 'full-access'],
  );
  await w.service.send('c1', msg('fourth', UUID(4)), 1);
  assert.equal(w.permits.length, 3);
  // plan is a mode of one turn here, not a setting a Host keeps
  w.modes.set('c1', 'plan');
  await w.service.send('c1', msg('fifth', UUID(5)), 1);
  assert.equal(w.permits.length, 3);
});

test('an unsupported Host or any other mode refusal retains the message rather than running under the wrong mode', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.modes.set('c1', 'read-only');
  w.host.permitFailWith = Object.assign(new Error('no'), { code: 'unsupported' });
  const ok = await w.service.send('c1', msg('one', UUID(1)), 1);
  assert.equal(ok!.action, 'queued');
  assert.equal(w.sent.length, 0);
  w.service.remove('c1', UUID(1));
  w.modes.set('c1', 'full-access');
  w.host.permitFailWith = Object.assign(new Error('mode_unavailable'), { code: 'mode_unavailable' });
  const held = await w.service.send('c1', msg('two', UUID(2)), 1);
  assert.equal(held!.action, 'queued');
  assert.equal(w.sent.length, 0, 'the message did not run under the old mode');
});

test('a mode the Host cannot set must retain the message instead of running with the previous permissions', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.modes.set('c1', 'read-only');
  w.host.permitFailWith = Object.assign(new Error('Update the Host before changing permissions'), { code: 'unsupported' });
  const receipt = await w.service.send('c1', msg('needs restriction', UUID(91)));
  assert.equal(receipt?.action, 'queued');
  assert.equal(w.sent.length, 0);
});

test('a queued first message survives restart and stays held when the machine is replaced', async (t) => {
  const w = world(t);
  w.remote('c1', 'box', 0, '/srv/app');
  w.row.hostKey = 'original';
  w.goAway();
  w.service.begin('c1', { harness: 'codex', scope: 'original' });
  assert.equal((await w.service.send('c1', msg('keep this prompt', UUID(1)), 1)).action, 'queued');
  w.service.dispose();

  const restarted = w.make();
  t.after(() => restarted.dispose());
  w.row.hostKey = 'replacement';
  await w.comeBack();
  await restarted.resume();
  assert.equal(w.started.length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(w.outboxes.at(-1).pending('c1')[0].options.item.text, 'keep this prompt');

  w.row.hostKey = 'original';
  assert.deepEqual(await restarted.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.equal(w.started[0].item.text, 'keep this prompt');
});
