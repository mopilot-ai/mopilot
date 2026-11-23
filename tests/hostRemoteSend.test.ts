// Messages to a chat on a remote Host (electron/host/remoteSend.cjs): kept before the wire (A5), shown as "Waiting for host", sent in order under one key when the machine returns, duplicate sends (I1), a restart, a Host that refuses or a chat that moved (B1, B2), and the approval guard on the push path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, msg, UUID, code } from './support/host/remoteSendKit.ts';
const require = createRequire(import.meta.url);
const { NO_ATTACHMENTS } = require('../electron/host/remoteSend.cjs');

test('a chat that runs here is not this service’s', async (t) => {
  const w = world(t);
  assert.equal(await w.service.send('local-chat', msg('hi'), 1), null);
  assert.equal(w.service.owns('local-chat'), false);
  assert.equal(w.sent.length, 0);
  assert.equal(w.queues.size, 0);
});

test('an online machine takes the message once, under its own key, and nothing stays kept (A5)', async (t) => {
  const w = world(t);
  w.remote('c1');
  const receipt = await w.service.send('c1', { ...msg('hello', UUID(1)), opts: { model: 'm', effort: 'high' } }, 3);
  assert.deepEqual(receipt, { action: 'started', id: UUID(1) });
  assert.deepEqual(w.sent, [{ chatId: 'c1', item: { text: 'hello', model: 'm', effort: 'high' }, key: UUID(1) }]);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
    'nothing waits: the sent bubble stays until the transcript has the message',
  );
  assert.equal(fs.existsSync(w.outboxDir) ? fs.readdirSync(w.outboxDir).length : 0, 0, 'the last ack releases the file');
});

test('a machine that is away keeps the message, shows Waiting for host and sends in order when it returns', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  const a = await w.service.send('c1', msg('first', UUID(1)), 1);
  const b = await w.service.send('c1', msg('second', UUID(2)), 1);
  assert.deepEqual(
    [a, b],
    [
      { action: 'queued', id: UUID(1) },
      { action: 'queued', id: UUID(2) },
    ],
  );
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => [q.id, q.text, q.waitingFor]),
    [
      [UUID(1), 'first', 'host'],
      [UUID(2), 'second', 'host'],
    ],
  );
  assert.equal(w.sent.length, 0);
  assert.equal(w.host.connects, 1, 'the connection is started once, never awaited');
  await w.comeBack();
  assert.deepEqual(
    w.sent.map((s) => [s.item.text, s.key]),
    [
      ['first', UUID(1)],
      ['second', UUID(2)],
    ],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('other items in the chat’s queue are kept next to the host bubbles', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  w.queues.set('c1', [{ id: 'controller-item', text: 'x' }]);
  await w.service.send('c1', msg('later', UUID(1)), 1);
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => q.id),
    ['controller-item', UUID(1)],
  );
  await w.comeBack();
  // sent, but the transcript has not got it yet: the bubble stays, no longer waiting
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => [q.id, q.waitingFor]),
    [
      ['controller-item', undefined],
      [UUID(1), undefined],
    ],
  );
  w.service.sent.seen('c1', 'later');
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => q.id),
    ['controller-item'],
  );
});

test('the same message sent twice under one id is one message (I1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('once', UUID(1)), 1);
  await w.service.send('c1', msg('once', UUID(1)), 1);
  assert.equal(w.queues.get('c1')!.length, 1);
  await w.comeBack();
  assert.equal(w.sent.length, 1);
  // sent again after the ack: the Host's dedupe makes it one input, and the key is the same
  await w.service.send('c1', msg('once', UUID(1)), 1);
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1), UUID(1)],
  );
});

test('a message with an id that is not a key gets a new one; chat ids stay opaque (I1)', async (t) => {
  const w = world(t);
  const weird = '../../__proto__|a/b';
  w.remote(weird);
  const receipt = await w.service.send(weird, msg('x', 'not-a-uuid'), 1);
  assert.match(receipt.id, /^[0-9a-f-]{36}$/);
  assert.equal(w.sent[0].chatId, weird);
  assert.equal(w.sent[0].key, receipt.id);
});

test('two sends at once are both delivered, in order, by one drain (A1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const send = w.host.send;
  w.host.send = async (...args: [string, any, any]) => (args[1].text === 'one' ? gate.then(() => send(...args)) : send(...args));
  const first = w.service.send('c1', msg('one', UUID(1)), 1);
  const second = w.service.send('c1', msg('two', UUID(2)), 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { action: 'started', id: UUID(1) },
    { action: 'started', id: UUID(2) },
  ]);
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['one', 'two'],
  );
});

test('a reply lost to a dropped connection keeps the message; the retry is the same key', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.failWith = code('The host is unreachable: the connection closed.', 'host_unreachable');
  const receipt = await w.service.send('c1', msg('keep me', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1) });
  assert.equal(w.queues.get('c1')![0].waitingFor, undefined, 'the registry still says online: no Waiting for host label');
  assert.equal(w.reports.length, 1, 'an unexplained failure is reported');
  w.host.failWith = null;
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1)],
  );
});

test('a failed ack write is retried under the same key', async (t) => {
  const w = world(t);
  w.remote('c1');
  const ob = w.outboxes[0];
  const realAck = ob.ack;
  ob.ack = () => {
    throw Object.assign(new Error('disk'), { code: 'EIO' });
  };
  const receipt = await w.service.send('c1', msg('x', UUID(1)), 1);
  assert.equal(receipt.action, 'queued');
  assert.equal(w.reports.length, 1);
  ob.ack = realAck;
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1), UUID(1)],
  );
});

test('a Host that refuses a message keeps it, marked, and nothing behind it passes (B1)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.failWith = code('Type a message first.', 'invalid');
  const receipt = await w.service.send('c1', msg(' ', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1), error: 'Type a message first.', waitingFor: 'hostRefused' });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', error: 'Type a message first.' });
  // the user deletes it and the chat goes on
  assert.equal(w.service.remove('c1', UUID(1)), true);
  w.host.failWith = null;
  assert.equal((await w.service.send('c1', msg('fine', UUID(2)), 1)).action, 'started');
  assert.equal(w.reports.length, 0, 'a refusal is shown, not reported');
});

test('a send the Host restarted in the middle of is kept, marked, and not taken for delivered (B2)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.failWith = code('The host restarted while this was being sent.', 'request_interrupted');
  const receipt = await w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.deepEqual(receipt, {
    action: 'queued',
    id: UUID(1),
    error: 'The machine restarted during this request, so it may or may not have gone. Look at the chat before sending it again.',
    waitingFor: 'hostRefused',
  });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  assert.equal(w.reports.length, 0);
});

test('a message the Host could not take yet (the harness is not signed in) shows its reason, and Send now runs it once the cause is gone (B2)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.failWith = code('Codex is not signed in on this host.', 'harness_not_configured');
  const receipt = await w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1), error: 'Codex is not signed in on the machine.', waitingFor: 'hostRefused' });
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
  w.host.failWith = null;
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'sent' });
  assert.equal(w.reports.length, 0);
});

test('a chat that moved to another owner waits for the continue dialog, then goes under the new epoch (B2)', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('old owner', UUID(1)), 1);
  w.remote('c1', 'other', 2);
  await w.comeBack();
  await w.service.resume();
  assert.equal(w.sent.length, 0, 'never sent to the new owner under the old epoch');
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostMoved');
  assert.deepEqual(await w.service.sendNow('c1', UUID(1)), { status: 'queued', error: 'The chat now belongs to another machine.' });
  await w.service.rebase('c1');
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(1)],
  );
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('unsupported attachments are refused up front', async (t) => {
  const w = world(t);
  w.remote('c1');
  const receipt = await w.service.send('c1', { ...msg('see', UUID(1)), attachments: [{ kind: 'skill', name: 'skill' }] }, 1);
  assert.deepEqual(receipt, { action: 'failed', id: UUID(1), error: NO_ATTACHMENTS });
  assert.equal(w.sent.length, 0);
  assert.equal(w.queues.size, 0);
});

test('a message that cannot be kept is not sent and says so', async (t) => {
  const w = world(t);
  w.remote('c1');
  fs.mkdirSync(path.dirname(w.outboxDir), { recursive: true });
  fs.writeFileSync(w.outboxDir, 'a file where the folder goes');
  const receipt = await w.service.send('c1', msg('x', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'failed', id: UUID(1), error: 'This message could not be saved, so it was not sent.' });
  assert.equal(w.sent.length, 0);
  assert.ok(w.reports.length > 0, 'the unreadable outbox is reported');
});

test('a machine with no connection to make is waiting, not an error', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.config.hostFor = () => null as any;
  const receipt = await w.service.send('c1', msg('x', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1) });
  assert.equal(w.reports.length, 0);
});

test('a connection that fails for another reason than an unreachable machine is reported', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.host.connect = async () => {
    throw code('The key was refused.', 'unknown_client');
  };
  await w.service.send('c1', msg('x', UUID(1)), 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    w.reports.map((e) => (e as any).code),
    ['unknown_client'],
  );
});

test('a restart finds what was kept, shows it and sends it when the machine answers (A5)', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.remote('c2', 'elsewhere');
  w.goAway();
  await w.service.send('c1', msg('survives', UUID(1)), 1);
  await w.service.send('c2', msg('other machine', UUID(2)), 1);
  w.service.dispose();
  w.queues.clear();
  const again = w.make();
  t.after(() => again.dispose());
  await again.resume();
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => [q.text, q.waitingFor]),
    [['survives', 'host']],
  );
  await w.comeBack();
  assert.deepEqual(w.sent.map((s) => s.item.text).sort(), ['other machine', 'survives'].sort());
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('a machine that returns sends only its own chats, and a disposed service sends nothing', async (t) => {
  const w = world(t);
  w.remote('c1', 'box');
  w.remote('c2', 'elsewhere');
  w.goAway();
  await w.service.send('c1', msg('a', UUID(1)), 1);
  await w.service.send('c2', msg('b', UUID(2)), 1);
  w.host.up = true;
  w.row.status = 'online';
  await w.service.resume('box');
  assert.deepEqual(
    w.sent.map((s) => s.chatId),
    ['c1'],
  );
  w.service.dispose();
  w.goAway();
  await w.service.resume();
  assert.equal(w.sent.length, 1);
});

test('deleting a bubble takes it out of the outbox; a message the Host has cannot be taken back; a stranger is not ours', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('oops', UUID(1)), 1);
  assert.equal(w.service.remove('c1', 'someone-else'), null);
  assert.equal(await w.service.sendNow('c1', 'someone-else'), null);
  assert.equal(w.service.remove('c1', UUID(1)), true);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
  await w.comeBack();
  assert.equal(w.sent.length, 0, 'what the user deleted is never sent');
  assert.equal(w.service.remove('c1', UUID(1)), null, 'already gone');
});

test('ack from the Host’s own record drops the message and its bubble', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('x', UUID(1)), 1);
  w.service.ack('c1', [UUID(1), 'unknown']);
  assert.deepEqual(
    w.queues.get('c1')?.filter((q: any) => q.waitingFor),
    [],
  );
  await w.comeBack();
  assert.equal(w.sent.length, 0);
});

test('a machine removed and added again is followed on its new connection', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  await w.service.send('c1', msg('a', UUID(1)), 1);
  const second = { ...w.host, connects: 0, sent: [] as string[] };
  const listeners = new Set<(s: string) => void>();
  second.onState = (fn: any) => (listeners.add(fn), () => listeners.delete(fn));
  second.connect = async () => void second.connects++;
  second.state = () => 'online';
  second.send = async (_c: string, item: any) => void second.sent.push(item.text);
  w.config.hostFor = () => second as any;
  w.row.status = 'online';
  await w.service.resume('box');
  assert.deepEqual(second.sent, ['a']);
  assert.equal(second.connects, 1);
  assert.equal(w.host.connects, 1);
});

test('machine model choice is frozen before offline queueing, scoped to machine and agent, and explicit sends still win', async (t) => {
  const w = world(t);
  const id = 'acp:host-claude:c1';
  w.remote(id);
  w.selections.set(id, { hostId: 'box', harness: 'claude', model: 'remote-one', effort: 'high' });
  w.goAway();
  await w.service.send(id, msg('first', UUID(81)));
  w.selections.set(id, { hostId: 'box', harness: 'claude', model: 'remote-two', effort: 'low' });
  await w.service.send(id, msg('second', UUID(82)));
  await w.comeBack();
  await w.service.resume();
  assert.deepEqual(
    w.sent.map((s) => [s.item.model, s.item.effort]),
    [
      ['remote-one', 'high'],
      ['remote-two', 'low'],
    ],
  );
  await w.service.send(id, { ...msg('explicit', UUID(83)), opts: { model: 'override' } });
  assert.equal(w.sent.at(-1)!.item.model, 'override');
  assert.equal(w.sent.at(-1)!.item.effort, undefined);
  for (const wrong of [
    { hostId: 'other', harness: 'claude' },
    { hostId: 'box', harness: 'codex' },
  ]) {
    w.selections.set(id, { ...wrong, model: 'wrong', effort: 'high' });
    await w.service.send(id, msg('scope'));
    assert.equal(w.sent.at(-1)!.item.model, undefined);
  }
  await w.service.send(id, {
    ...msg('window snapshot'),
    opts: { hostSelection: { hostId: 'box', harness: 'claude', model: 'window', effort: null } },
  });
  assert.equal(w.sent.at(-1)!.item.model, 'window');
  assert.equal(w.sent.at(-1)!.item.effort, undefined);
});

test('offline permissions are frozen per message and survive restart independently of the current picker', async (t) => {
  const w = world(t);
  const id = 'continued-native-chat';
  w.remote(id);
  w.kinds.set(id, 'claude');
  w.permissions.set(id, { hostId: 'box', harness: 'claude', value: 'read-only' });
  w.goAway();
  await w.service.send(id, msg('first', UUID(91)));
  w.permissions.set(id, { hostId: 'box', harness: 'claude', value: 'full-access' });
  await w.service.send(id, msg('second', UUID(92)));
  w.service.dispose();
  const restored = w.make();
  t.after(() => restored.dispose());
  w.permissions.clear();
  w.modes.set(id, 'default');
  w.host.up = true;
  w.row.status = 'online';
  await restored.resume();
  assert.deepEqual(
    w.permits.map((p) => p.value),
    ['read-only', 'full-access'],
  );
  assert.deepEqual(
    w.sent.map((s) => s.item.text),
    ['first', 'second'],
  );
});

test('a queued message without a permission snapshot never adopts a later full-access mode', async (t) => {
  const w = world(t);
  w.remote('c');
  w.goAway();
  await w.service.send('c', msg('old', UUID(801)));
  w.modes.set('c', 'full-access');
  await w.comeBack();
  await w.service.resume();
  assert.equal(
    w.permits.some((p) => p.value === 'full-access'),
    false,
  );
});
test('a replacement Host always receives the chosen read-only mode before the next message', async (t) => {
  const w = world(t);
  w.remote('c');
  w.modes.set('c', 'read-only');
  await w.service.send('c', msg('first', UUID(802)));
  assert.equal(w.permits.length, 1);
  // one replacement connection: delivery checks the Host it sends to is still the machine's
  const replacement = { ...w.host };
  w.config.hostFor = () => replacement;
  await w.service.send('c', msg('second', UUID(803)));
  assert.deepEqual(
    w.permits.map((p) => p.value),
    ['read-only', 'read-only'],
  );
});

test('remote Plan input is refused before queueing or sending so its text stays with the caller', async (t) => {
  const w = world(t);
  w.remote('c1');
  const receipt = await w.service.send('c1', { ...msg('keep this plan'), opts: { plan: true } });
  assert.equal(receipt.action, 'failed');
  assert.match(receipt.error, /Plan mode.*machine/i);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.outboxes[0].chats(), []);
});

test('Plan left in a legacy durable outbox waits with its reason instead of silently losing its mode', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.outboxes[0].add('c1', { key: UUID(96), epoch: 1, options: { item: { ...msg('legacy plan', UUID(96)), opts: { plan: true } } } });
  await w.service.resume();
  assert.equal(w.sent.length, 0);
  assert.equal(w.outboxes[0].pending('c1').length, 1);
  assert.equal(w.queues.get('c1')?.[0]?.waitingFor, 'hostRefused');
  assert.match((await w.service.sendNow('c1', UUID(96))).error, /Plan mode.*machine/i);
});
