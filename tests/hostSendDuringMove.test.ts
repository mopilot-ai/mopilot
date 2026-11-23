// A message accepted while Switch host moves a chat is delivered exactly once to the chat's owner after the move, or stays visibly queued with its cause: it never vanishes (#5161). Each test drives a move through the real `host:continue` handler (its run held open) and sends through the public entrypoints: the controller's send/drain/sendNow, the remote send service's send and enqueue, a peer's send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { selectSegment, setup, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/host.cjs');
const { remoteRoutes } = require('../electron/host/wiring.cjs');

const req = { chatId: 'c1', targetHostId: 'other', cwd: '/srv/app' };

/** One chat on `owner` ('local' = this Mac), two machines to receive, a controller wired to the same remote send service, and a `host:continue` whose run waits for `finish`. */
function moveWorld(t: any, owner: 'local' | 'box') {
  const w = world(t, { epoch: 1 });
  if (owner === 'box') w.remote('c1');
  const got: Record<string, string[]> = { box: [], other: [] };
  const hosts: Record<string, any> = {};
  for (const id of ['box', 'other']) hosts[id] = { ...w.host, send: async (_c: string, _i: any, o: any) => void got[id].push(o.key) };
  w.config.hostFor = (id: string) => hosts[id];
  w.config.checkFolder = async () => ({});
  const f = setup();
  selectSegment(f.c, f.chats, 'c1', [['acp:fake', 'native']]);
  f.c.remote = remoteRoutes({ remoteSend: () => w.service });
  let finish!: (r: 'lands' | 'refused') => void;
  const live: any = {
    hostContinue: () =>
      new Promise((resolve, reject) => {
        finish = (r) => {
          if (r === 'refused') return reject(Object.assign(new Error('No such folder.'), { code: 'directory_missing' }));
          w.remote('c1', 'other', 2, '/srv/app');
          resolve({ hostId: 'other', epoch: 2 });
        };
      }),
    controller: { state: {} },
  };
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }), row: () => ({ name: 'the new machine' }) }) as any,
      allowed: () => true,
      makeRemoteSend: (() => () => w.service) as any,
    },
  );
  /** The dialog presses Switch host: resolves with the continue's answer once `finish` is called. */
  const startMove = async () => {
    const done = handlers.get('host:continue')({}, req);
    await tick();
    return done;
  };
  return { w, got, ...f, startMove, finish: (r: 'lands' | 'refused') => finish(r) };
}
const rows = (w: any) => (w.queues.get('c1') ?? []).map((q: any) => [q.id, q.waitingFor]);
const pending = (w: any) => w.outboxes[0].pending('c1').map((e: any) => e.key);

test('Enter in the composer of a chat on a machine: nothing goes to the old machine, the message goes once to the new one (R1)', async (t) => {
  const m = moveWorld(t, 'box');
  const move = m.startMove();
  await tick();
  const receipt = await m.w.service.send('c1', msg('hi', UUID(1)), 1);
  assert.equal(receipt.action, 'queued');
  assert.deepEqual(m.got, { box: [], other: [] }, 'held while the chat is handed over');
  assert.deepEqual(rows(m.w), [[UUID(1), 'hostMoving']]);
  m.finish('lands');
  await move;
  assert.deepEqual(m.got, { box: [], other: [UUID(1)] });
  await m.w.service.resume();
  await m.w.service.rebase('c1');
  assert.deepEqual(m.got.other, [UUID(1)], 'a later resume or rebase sends nothing again');
});

test('Enter in the composer of a chat on this Mac (controller.send): no turn on the session being left; it goes once to the new machine (L1)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  const receipt = await m.c.send('c1', msg('hi', UUID(1)), 1, true);
  assert.equal(receipt.action, 'queued');
  await tick();
  assert.equal(m.execs.length, 0, 'no turn started on the session being left');
  assert.deepEqual(rows(m.w), [[UUID(1), 'hostMoving']]);
  m.finish('lands');
  await move;
  assert.deepEqual(m.got, { box: [], other: [UUID(1)] });
  assert.equal(m.execs.length, 0);
  assert.deepEqual(m.w.local.sent, []);
});

test('the move is refused: what was sent meanwhile starts here once, in order (L2)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  await m.c.send('c1', msg('one', UUID(1)), 1, true);
  await m.c.send('c1', msg('two', UUID(2)), 1, true);
  m.finish('refused');
  await move;
  assert.deepEqual(
    m.w.local.sent.map(([, item]: any) => item.text),
    ['one', 'two'],
  );
  assert.deepEqual(m.got, { box: [], other: [] });
  assert.deepEqual(pending(m.w), [], 'nothing is left kept');
});

test('a queued row released by a drain or Send now during the move waits for it and goes once (L3)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  m.state.patch('c1', { queue: [{ id: UUID(7), text: 'queued before', attachments: [], opts: {} }] });
  assert.equal(m.c.drain('c1'), undefined, 'the drain does not start it');
  assert.equal((await m.c.sendNow('c1', UUID(7), 1, true)).status, 'queued', 'Send now says it is kept, not that it failed');
  await tick();
  assert.equal(m.execs.length, 0, 'no turn on the session being left');
  assert.deepEqual(
    m.state.get('c1').queue.map((q: any) => q.id),
    [],
    'it left the controller queue for the outbox: one place',
  );
  m.finish('lands');
  await move;
  assert.deepEqual(m.got, { box: [], other: [UUID(7)] });
  assert.equal(m.execs.length, 0);
});

test('the phone and the Mac sending during one move: both kept, in order, each once (R2)', async (t) => {
  const m = moveWorld(t, 'box');
  const move = m.startMove();
  await tick();
  assert.equal(m.w.service.enqueue('c1', msg('phone', UUID(1)), null).action, 'queued');
  await m.w.service.send('c1', msg('mac', UUID(2)), 1);
  await m.c.send('c1', msg('scheduled', UUID(3)), null, true);
  assert.deepEqual(m.got, { box: [], other: [] });
  m.finish('lands');
  await move;
  assert.deepEqual(m.got.other, [UUID(1), UUID(2), UUID(3)]);
  assert.deepEqual(m.got.box, []);
});

test("another session's message during the move is kept like any other and starts here once, with its own id, when the move is refused (L4)", async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  const peer = { id: UUID(5), peer: { messageId: UUID(5), sourceChatId: 's' }, text: 'from s', attachments: [], opts: { human: false } };
  const receipt = await m.c.send('c1', peer, null, true);
  assert.equal(receipt.action, 'queued', 'the sender is told it is queued, not that it was refused');
  assert.equal(m.execs.length, 0);
  m.finish('refused');
  await move;
  assert.equal(m.w.local.sent.length, 1);
  const [, item] = m.w.local.sent[0];
  assert.deepEqual([item.id, item.peer?.messageId, item.text], [UUID(5), UUID(5), 'from s'], "the sender's record still matches");
});

test('a delivery that began at the old owner and ends "moved" after the owner changed still reaches the new one (R3)', async (t) => {
  const w = world(t, { epoch: 1 });
  w.remote('c1');
  const got: Record<string, string[]> = { box: [], other: [] };
  const hosts: Record<string, any> = {};
  for (const id of ['box', 'other']) hosts[id] = { ...w.host, send: async (_c: string, _i: any, o: any) => void got[id].push(o.key) };
  w.config.hostFor = (id: string) => hosts[id];
  let open!: () => void;
  let first = true;
  w.config.subscribed = () => (first ? ((first = false), new Promise<void>((r) => (open = r))) : Promise.resolve());
  const sending = w.service.send('c1', msg('hi', UUID(1)), 1);
  await tick();
  w.remote('c1', 'other', 2);
  const ended = w.service.rebase('c1');
  await tick();
  open();
  await Promise.all([sending, ended]);
  assert.deepEqual(got, { box: [], other: [UUID(1)] });
});

test('a move that takes very long keeps the chat held, naming the machine: nothing goes to the owner that is handing the chat over, and nothing is missing on the destination when it lands (no second timer)', async (t) => {
  for (const owner of ['local', 'box'] as const) {
    const m = moveWorld(t, owner);
    const move = m.startMove();
    await tick();
    await (owner === 'local' ? m.c.send('c1', msg('one', UUID(1)), 1, true) : m.w.service.send('c1', msg('one', UUID(1)), 1));
    // far longer than any limit this service ever had
    m.w.clock.advance(60 * 60_000);
    await tick();
    await (owner === 'local' ? m.c.send('c1', msg('two', UUID(2)), 1, true) : m.w.service.send('c1', msg('two', UUID(2)), 1));
    assert.equal(m.w.service.moving('c1'), true, 'still held');
    assert.deepEqual(m.got, { box: [], other: [] });
    assert.deepEqual(m.w.local.sent, [], 'nothing runs on the session being left');
    assert.equal(m.execs.length, 0);
    assert.deepEqual(
      m.w.queues.get('c1')?.map((q: any) => [q.waitingFor, q.movingTo]),
      [
        ['hostMoving', 'the new machine'],
        ['hostMoving', 'the new machine'],
      ],
    );
    m.finish('lands');
    await move;
    assert.deepEqual(m.got, { box: [], other: [UUID(1), UUID(2)] }, 'every message the user saw reaches the destination, in order');
    assert.deepEqual(m.w.local.sent, []);
  }
});

test('the app quit in the middle of a move: a restart sends what was kept to whoever owns the chat then, once (A: still here, B: it landed)', async (t) => {
  for (const landed of [false, true]) {
    const m = moveWorld(t, 'local');
    void m.startMove();
    await tick();
    await m.c.send('c1', msg('kept', UUID(1)), 1, true);
    // the process dies here: the outbox file is all that is left
    if (landed) m.w.remote('c1', 'other', 2, '/srv/app');
    const again = m.w.make();
    t.after(() => again.dispose());
    await again.resume();
    await again.resume();
    if (landed) assert.deepEqual(m.got, { box: [], other: [UUID(1)] });
    else
      assert.deepEqual(
        m.w.local.sent.map(([, item]: any) => item.text),
        ['kept'],
      );
    assert.deepEqual(
      m.w.outboxes[m.w.outboxes.length - 1].pending('c1').filter((e: any) => e.state === 'queued'),
      [],
    );
  }
});

test("a move that is refused releases a remote chat's messages to the machine it stayed on, once (R4)", async (t) => {
  const m = moveWorld(t, 'box');
  const move = m.startMove();
  await tick();
  await m.w.service.send('c1', msg('hi', UUID(1)), 1);
  m.finish('refused');
  await move.catch(() => undefined);
  assert.deepEqual(m.got, { box: [UUID(1)], other: [] });
});

test('a drain already running when the move starts does not send what is kept after it to the old machine (R5)', async (t) => {
  const m = moveWorld(t, 'box');
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const hosts: Record<string, any> = {
    box: {
      ...m.w.host,
      send: async (_c: string, _i: any, o: any) => {
        m.got.box.push(o.key);
        if (o.key === UUID(1)) await slow;
      },
    },
    other: { ...m.w.host, send: async (_c: string, _i: any, o: any) => void m.got.other.push(o.key) },
  };
  m.w.config.hostFor = (id: string) => hosts[id];
  const first = m.w.service.send('c1', msg('first', UUID(1)), 1);
  await tick();
  const move = m.startMove();
  await tick();
  await m.w.service.send('c1', msg('second', UUID(2)), 1);
  release();
  await first;
  assert.deepEqual(m.got.box, [UUID(1)], 'the second message is not sent to the machine that is handing the chat over');
  m.finish('lands');
  await move;
  assert.deepEqual(m.got.other, [UUID(2)]);
});

test('two releases of the same chat at once deliver a message here once (restart sweep and the end of the move)', async (t) => {
  const m = moveWorld(t, 'local');
  void m.startMove();
  await tick();
  await m.c.send('c1', msg('kept', UUID(1)), 1, true);
  m.finish('refused');
  await Promise.all([m.w.service.rebase('c1'), m.w.service.rebase('c1'), m.w.service.resume()]);
  await tick();
  assert.equal(m.w.local.sent.length, 1);
});

test('the app died after the controller took a message and before the ack: a restart sends nothing again on its own, the row says so, and Send now sends it once under its own id', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  await m.c.send('c1', msg('kept', UUID(1)), 1, true);
  // the controller takes it, and the process dies before the ack is written
  m.w.local.receipt = new Promise(() => undefined);
  m.finish('refused');
  void move;
  await tick();
  assert.deepEqual(
    m.w.local.sent.map(([, item]: any) => item.id),
    [UUID(1)],
    "taken once, under the message's own id",
  );
  m.w.local.receipt = { action: 'started' };
  const again = m.w.make();
  t.after(() => again.dispose());
  await again.resume();
  await again.resume();
  assert.equal(m.w.local.sent.length, 1, 'no second delivery on a restart');
  const row = m.w.queues.get('c1')?.[0];
  assert.deepEqual([row?.id, row?.waitingFor], [UUID(1), 'hostRefused']);
  assert.equal(row?.error, 'Delivery is still unconfirmed.');
  assert.equal((await again.sendNow('c1', UUID(1)))?.status, 'sent');
  assert.deepEqual(
    m.w.local.sent.map(([, item]: any) => item.id),
    [UUID(1), UUID(1)],
    'the person chose to send it again: the same id, so a receiver that knows ids can match it',
  );
  assert.deepEqual(m.w.outboxes[m.w.outboxes.length - 1].pending('c1'), []);
});

test('Send now on a message kept for a chat that runs here, during the move, keeps it: nothing is handed to the controller or acked (L5)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  await m.c.send('c1', msg('kept', UUID(1)), 1, true);
  const result = await m.w.service.sendNow('c1', UUID(1));
  assert.equal(result?.status, 'queued');
  assert.deepEqual(m.w.local.sent, []);
  assert.deepEqual(pending(m.w), [UUID(1)]);
  m.finish('lands');
  await move;
  assert.deepEqual(m.got.other, [UUID(1)]);
  assert.deepEqual(m.w.local.sent, []);
});

test('a message from another session sent through its delivery path during the move is kept, the sender is told it is queued, and it goes once (L6)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  const brief = { id: UUID(8), text: 'brief', attachments: [], opts: {}, sideSession: { id: 'x' } };
  const result = await m.c.deliverFamily('c1', brief);
  assert.deepEqual([result.started, result.queued], [false, true]);
  assert.equal(m.execs.length, 0);
  m.finish('refused');
  await move;
  assert.deepEqual(
    m.w.local.sent.map(([, item]: any) => item.id),
    [UUID(8)],
  );
});

test('a controller that does not take a message kept for a move leaves its row with the cause, and Send now sends it once (L7)', async (t) => {
  const m = moveWorld(t, 'local');
  m.w.local.receipt = { action: 'failed', error: 'The agent is not ready.' };
  const move = m.startMove();
  await tick();
  await m.c.send('c1', msg('kept', UUID(1)), 1, true);
  m.finish('refused');
  await move;
  const row = m.w.queues.get('c1')?.[0];
  assert.deepEqual([row?.waitingFor, row?.error], ['hostRefused', 'The agent is not ready.']);
  m.w.local.receipt = { action: 'started' };
  assert.equal((await m.w.service.sendNow('c1', UUID(1)))?.status, 'sent');
  assert.equal(m.w.local.sent.length, 2, 'one refused try, one that was taken');
  assert.deepEqual(pending(m.w), []);
});

test('a message kept while the held ones are being delivered here is delivered in the same sweep (R7)', async (t) => {
  const m = moveWorld(t, 'local');
  const move = m.startMove();
  await tick();
  await m.c.send('c1', msg('one', UUID(1)), 1, true);
  let late = false;
  m.w.local.receipt = {
    get action() {
      if (!late) {
        late = true;
        // kept while the sweep is running
        m.w.outboxes[0].add('c1', {
          key: UUID(2),
          epoch: 0,
          options: { item: { ...msg('two', UUID(2)), id: UUID(2), opts: {} }, held: true },
        });
      }
      return 'started';
    },
  };
  m.finish('refused');
  await move;
  assert.deepEqual(
    m.w.local.sent.map(([, item]: any) => item.id),
    [UUID(1), UUID(2)],
  );
  assert.deepEqual(pending(m.w), []);
});
