// A chat a phone starts on a machine (#4193, #4196, #4197): the permission rides in the start, the reply waits for nothing on the machine, and the person's own first message is never missing from the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world as sendWorld, msg, UUID } from './support/host/remoteSendKit.ts';
import { world as chatsWorld, fakeHost } from './support/host/remoteChatsKit.ts';
const require = createRequire(import.meta.url);
const { createHostPhone } = require('../electron/app/hostPhone.cjs');
const { createMachineChatStart } = require('../electron/host/machineChatStart.cjs');
const { createStartPairs } = require('../electron/host/turnStartPairs.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const never = () => new Promise<never>(() => undefined);

test('#4196: a phone start replies with no round trip to the machine on its path (folder read, follow, host.start all still pending)', async (t) => {
  const w = sendWorld(t);
  w.remote('acp:host-claude:1');
  // every round trip to the machine hangs: before this change the reply waited for the folder read, the follow and host.start in turn (4 sequential awaits with the permission call)
  w.host.start = never as any;
  const awaited: string[] = [];
  const machineChats = createMachineChatStart({
    row: () => ({ name: 'box', harnesses: [{ id: 'claude', detected: true, signedIn: true }] }),
    apiKeys: { hasFor: () => false },
    orgAccess: { covers: () => false },
    bind: () => undefined,
    begin: (chatId: string, start: any) => w.service.begin(chatId, start),
    follow: () => (awaited.push('follow'), never()),
  });
  const phone = createHostPhone({
    allowed: () => true,
    watch: () => undefined,
    machines: () => ({ list: () => ({ machines: [{ id: 'box', name: 'box', status: 'online' }] }), row: () => ({ id: 'box' }) }),
    folders: () => ({ list: () => (awaited.push('folder'), never()) }),
    machineChats: { ...machineChats, newChatId: () => 'acp:host-claude:1' },
    enqueue: (chatId: string, item: any, gate: Promise<unknown>) => w.service.enqueue(chatId, item, 5, gate),
    setMode: (chatId: string, mode: string) => w.modes.set(chatId, mode),
    announce: () => undefined,
    move: async () => ({}),
    plan: async () => ({}),
    ownership: { get: () => ({ hostId: 'box' }) },
    orgCovers: () => false,
    changed: () => undefined,
    projects: () => [],
  });
  const reply = await Promise.race([
    phone.start({
      hostId: 'box',
      folder: '/srv',
      harness: 'claude',
      projectId: null,
      text: 'hi',
      model: null,
      effort: null,
      permission: 'auto-review',
    }),
    new Promise((r) => setTimeout(() => r('timed out'), 500)),
  ]);
  assert.deepEqual(reply, { chatId: 'acp:host-claude:1' });
  assert.deepEqual(awaited.sort(), ['folder', 'follow'], 'both were asked, neither was waited for');
  // the message is durable and shown (the machine is told in the background), under the chat's mode
  assert.deepEqual(
    w.queues.get('acp:host-claude:1')!.map((q) => q.text),
    ['hi'],
  );
  assert.equal(w.modes.get('acp:host-claude:1'), 'auto-review');
});

test('a phone start passes the choice of credential to the machine chat, and one that chose nothing passes none', async () => {
  const seen: any[] = [];
  const phone = createHostPhone({
    allowed: () => true,
    watch: () => undefined,
    machines: () => ({ list: () => ({ machines: [{ id: 'box', name: 'box', status: 'online' }] }), row: () => ({ id: 'box' }) }),
    folders: () => ({ list: () => never() }),
    machineChats: {
      newChatId: () => 'acp:host-claude:1',
      start: async (q: any) => (seen.push(q), { listed: Promise.resolve() }),
    },
    enqueue: () => ({ action: 'queued', id: UUID(1) }),
    setMode: () => undefined,
    announce: () => undefined,
    move: async () => ({}),
    plan: async () => ({}),
    ownership: { get: () => ({ hostId: 'box' }) },
    orgCovers: () => false,
    changed: () => undefined,
    projects: () => [],
  });
  const q = { hostId: 'box', folder: '/srv', harness: 'claude', projectId: null, text: 'hi', model: null, effort: null };
  await phone.start({ ...q, credential: { source: 'own', login: 'work' } });
  await phone.start(q);
  assert.deepEqual(seen[0].credential, { source: 'own', login: 'work' });
  assert.equal('credential' in seen[1], false);
});

test('#4193: the first host.start carries the phone’s permission; a mode the Host has no name for is not sent', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  w.modes.set('c1', 'full-access');
  w.service.begin('c1', { harness: 'claude', projectId: null });
  assert.deepEqual(w.service.enqueue('c1', msg('go', UUID(1)), 1, Promise.resolve()), { action: 'queued', id: UUID(1) });
  await tick();
  assert.equal(w.started[0].item.permission, 'full-access');
  assert.equal(w.permits.length, 0);
});

test('enqueue: replies once kept; a chat here is not this service’s; non-image attachments and an unwritable outbox are failures', async (t) => {
  const w = sendWorld(t);
  assert.equal(w.service.enqueue('local', msg('x'), 1), null);
  w.remote('c1');
  const gate: { release?: () => void } = {};
  w.host.send = (async () => new Promise<void>((r) => (gate.release = r))) as any;
  const receipt = w.service.enqueue('c1', msg('slow', UUID(1)), 1);
  assert.deepEqual(receipt, { action: 'queued', id: UUID(1) });
  assert.equal(w.queues.get('c1')!.length, 1, 'shown at once');
  await tick();
  gate.release?.();
  await tick();
  assert.equal(w.queues.get('c1')!.filter((q) => q.waitingFor).length, 0);
  assert.match((w.service.enqueue('c1', { ...msg('f'), attachments: [{ path: '/a' }] }, 1) as any).error, /Only images/);
  w.outboxes[0].add = () => {
    throw new Error('disk');
  };
  assert.match((w.service.enqueue('c1', msg('y', UUID(2)), 1) as any).error, /could not be saved/);
  assert.equal(w.reports.length, 1);
});

test('enqueue: a gate that rejects holds the message and shows it refused with the reason; a gate that passes sends it', async (t) => {
  const w = sendWorld(t);
  w.remote('c1', 'box', 1, '/srv');
  w.config.checkFolder = async () => undefined;
  w.service.enqueue(
    'c1',
    msg('bad folder', UUID(1)),
    1,
    Promise.reject(Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' })),
  );
  await tick();
  assert.equal(w.sent.length + w.started.length, 0, 'nothing reached the machine');
  assert.deepEqual(
    w.queues.get('c1')!.map((q) => [q.id, q.waitingFor]),
    [[UUID(1), 'hostRefused']],
  );
  // a rejection with no message still says something
  w.remote('c2');
  w.service.enqueue('c2', msg('odd', UUID(2)), 1, Promise.reject(null));
  await tick();
  assert.equal(w.queues.get('c2')![0].waitingFor, 'hostRefused');
  // a later send in the chat does not carry the barred message to the machine; deleting it frees the chat
  w.service.enqueue('c1', msg('next', UUID(4)), 1, Promise.resolve());
  await tick();
  assert.equal(w.sent.length + w.started.length, 0);
  assert.equal(w.service.remove('c1', UUID(1)), true);
  await w.service.sendNow('c1', UUID(4));
  assert.deepEqual(
    w.sent.map((s) => s.key),
    [UUID(4)],
  );
});

test('#4197: what was sent stays as a bubble until its user record is applied; a record with other text settles nothing', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  const shown = () => w.queues.get('c1')!.map((q) => [q.text, q.waitingFor]);
  assert.deepEqual(shown(), [['hello', undefined]]);
  w.service.sent.seen('c1', 'someone else');
  w.service.sent.seen('nothing-sent', 'hello');
  assert.deepEqual(shown(), [['hello', undefined]]);
  w.service.sent.seen('c1', 'hello');
  assert.deepEqual(shown(), []);
  // the oldest sent text is what a turn start with no user message takes; with nothing sent there is none
  assert.equal(w.service.sent.take('c1'), undefined);
  await w.service.send('c1', msg('one', UUID(2)), 1);
  await w.service.send('c1', msg('two', UUID(3)), 1);
  assert.equal(w.service.sent.take('c1'), 'one');
  w.service.sent.seen('c1', 'one');
  assert.deepEqual(shown(), [['two', undefined]]);
  // the person deletes the bubble of a message the Host has: it is only the bubble that goes
  assert.equal(w.service.remove('c1', UUID(3)), true);
  assert.deepEqual(shown(), []);
  assert.equal(w.service.remove('c1', UUID(9)), null);
  // Inputs are kept until applied, even with many accepted messages
  for (let i = 0; i < 20; i++) await w.service.send('c1', msg(`m${i}`, UUID(100 + i)), 1);
  assert.equal(w.queues.get('c1')!.length, 20);
});

test('#4197: a turn whose first event comes before the user item still shows the text this Mac sent, once', async () => {
  const log: string[] = [];
  const sentTexts = ['fix it'];
  const w = chatsWorld(fakeHost(), undefined, {
    take: () => sentTexts.shift(),
    seen: (_c, text) => {
      if (text !== undefined) log.push(text);
    },
  });
  const CHAT = 'acp:host-claude:u2';
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const fam = (event: object) => ({ t: 'event', family: 'claude', event });
  w.host.fire.patch(CHAT, 1, fam({ kind: 'turnStart', turnId: 't1' }));
  w.host.fire.patch(
    CHAT,
    2,
    fam({
      kind: 'update',
      turnId: 't1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'on it' } },
    }),
  );
  // the Host's user item arrives later: nothing new to draw
  w.host.fire.patch(CHAT, 3, { t: 'user', turnId: 't1', text: 'fix it' });
  await w.chats.settled(CHAT);
  const starts = w.emitted.filter((e) => e.kind === 'turnStart');
  assert.equal(starts.length, 1, 'one user bubble, not two');
  assert.deepEqual(starts[0].user.content, [{ type: 'text', text: 'fix it', text_elements: [] }]);
  assert.deepEqual(log, ['fix it'], 'the applied turn settles its input once');
});

test('the pairing: sent text fills a turn start released bare; a user record settles the sent text, an ACP start’s own message too', () => {
  const taken: string[] = [];
  const asked: string[] = [];
  const queue = ['sent'];
  const pairs = createStartPairs({ unasked: () => queue.shift() });
  const start = (turnId: string, extra: object = {}) => ({ kind: 'turnStart', turnId, ...extra });
  assert.deepEqual(pairs.take(null, start('a')), []);
  const [released] = pairs.take(null, { kind: 'update', turnId: 'a' });
  assert.equal(released.user.content[0].text, 'sent');
  // nothing sent: the turn was nobody's from this Mac
  pairs.take(null, start('b'));
  assert.deepEqual(pairs.take(null, { kind: 'update', turnId: 'b' })[0].user.content, []);
  assert.deepEqual(pairs.take({ t: 'user', turnId: 'a', text: 'sent' }, null), [], 'the late item for a filled turn');
  assert.deepEqual(asked, []);
  // the Host's own user item (the turn not filled) settles what was sent
  pairs.take(null, start('c'));
  pairs.take({ t: 'user', turnId: 'c', text: 'typed' }, null);
  assert.deepEqual(asked, []);
  // an ACP start with its message settles it; a start whose message has no text settles nothing
  pairs.take(null, start('d', { user: { content: [{ type: 'text', text: 'acp said' }] } }));
  pairs.take(null, start('e', { user: { content: [{ type: 'image' }] } }));
  assert.deepEqual(asked, []);
  pairs.reset();
  taken.push('reset');
  assert.equal(taken.length, 1);
});

test('machineChats.start: in the background it replies before the chat is followed, and a follow that fails is not the start’s failure', async () => {
  let release: () => void = () => undefined;
  const mk = (follow: () => unknown) =>
    createMachineChatStart({
      row: () => ({ name: 'box', harnesses: [{ id: 'claude', detected: true, signedIn: true }] }),
      apiKeys: { hasFor: () => false },
      orgAccess: { covers: () => false },
      bind: () => undefined,
      begin: () => undefined,
      follow,
    });
  const q = { chatId: 'acp:host-claude:1', hostId: 'box', folder: '/srv', harness: 'claude' };
  const slow = mk(() => new Promise<void>((r) => (release = r)));
  const quick = await slow.start(q, { background: true });
  assert.equal(quick.chatId, q.chatId);
  let listed = false;
  void quick.listed.then(() => (listed = true));
  await tick();
  assert.equal(listed, false, 'not followed yet, already replied');
  release();
  await tick();
  assert.equal(listed, true);
  const failing = mk(() => Promise.reject(new Error('no stream')));
  await (await failing.start(q, { background: true })).listed;
  // without the option it still waits, as the composer and a scheduled run need
  await assert.rejects(failing.start(q), /no stream/);
});

test('a user record received before the RPC reply settles the bubble permanently', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  w.host.send = (async () => {
    w.service.sent.seen('c1', 'hello');
  }) as any;
  await w.service.send('c1', msg('hello', UUID(1)), 1);
  assert.deepEqual(w.queues.get('c1'), []);
});

test('another drain cannot bypass a pending folder check', async (t) => {
  const w = sendWorld(t);
  w.remote('c1');
  let release!: () => void;
  w.service.enqueue(
    'c1',
    msg('hello', UUID(1)),
    1,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const second = w.service.send('c1', msg('second', UUID(2)), 1);
  await tick();
  assert.equal(w.sent.length, 0);
  release();
  await second;
  assert.equal(w.sent.length, 2);
});

test('a durable phone message rechecks its folder after sender restart', async (t) => {
  const w = sendWorld(t);
  w.remote('c1', 'box', 1, '/outside');
  w.goAway();
  w.service.enqueue('c1', msg('kept', UUID(1)), 1, never());
  w.service.dispose();
  const calls: string[] = [];
  w.config.checkFolder = async (hostId, folder) => {
    calls.push(`${hostId}:${folder}`);
    throw Object.assign(new Error('That folder is outside what this host shares.'), { code: 'outside_roots' });
  };
  const next = w.make();
  t.after(() => next.dispose());
  w.host.up = true;
  w.row.status = 'online';
  await next.resume();
  assert.deepEqual(calls, ['box:/outside']);
  assert.equal(w.sent.length, 0);
  assert.equal(w.queues.get('c1')![0].waitingFor, 'hostRefused');
});

test('the transcript matches a clientId before comparing identical text', async (t) => {
  const w = sendWorld(t);
  const chatId = 'acp:host-claude:identity';
  w.remote(chatId);
  await w.service.send(chatId, msg('same', UUID(1)), 1);
  await w.service.send(chatId, msg('same', UUID(2)), 1);
  const c = chatsWorld(fakeHost(), undefined, w.service.sent);
  c.chats.follow(chatId);
  await c.chats.settled(chatId);
  c.host.fire.patch(chatId, 1, {
    t: 'event',
    family: 'claude',
    event: {
      kind: 'turnStart',
      turnId: 'native',
      user: { id: 'u', clientId: UUID(2), content: [{ type: 'text', text: 'same' }] },
    },
  });
  await c.chats.settled(chatId);
  assert.deepEqual(
    w.queues.get(chatId)!.map((q) => q.id),
    [UUID(1)],
  );
  c.chats.dispose();
});
