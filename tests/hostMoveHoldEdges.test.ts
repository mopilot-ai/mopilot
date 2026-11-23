// The edges of the Switch host hold (#5161): a send during a move that cannot be kept, a delivery that joins or is interrupted by a new move, an unreadable outbox, a dialog closed with nothing held, a Host that is off, and the controller's own routes while a chat moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { selectSegment, setup, tick } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { remoteRoutes } = require('../electron/host/wiring.cjs');
const { holdMove, planHandler, releasePlan } = require('../electron/host/moveSettle.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

/** A chat that runs on this Mac, wired to the remote send service the way main wires it. */
function localChat(t: any) {
  const w = world(t, { epoch: 1 });
  const f = setup();
  selectSegment(f.c, f.chats, 'c1', [['acp:fake', 'native']]);
  f.c.remote = remoteRoutes({ remoteSend: () => w.service });
  return { w, ...f };
}

test('main routes a held message to the remote send service, and to nobody while Host is off', () => {
  assert.equal(remoteRoutes({}).hold('c1', msg('x'), 1), null);
  const sent: unknown[] = [];
  const routes = remoteRoutes({ remoteSend: () => ({ hold: (...a: unknown[]) => (sent.push(a), { action: 'queued', id: 'k' }) }) });
  assert.deepEqual(routes.hold('c1', msg('x'), 7), { action: 'queued', id: 'k' });
  assert.equal((sent[0] as unknown[])[2], 7);
});

test('a send without a wait during the move gets its receipt at once; one that cannot be kept is refused with the cause, not dropped', async (t) => {
  const m = localChat(t);
  m.w.service.holdMove('c1');
  assert.deepEqual(m.c.send('c1', msg('one', UUID(1)), 1), { action: 'queued', id: UUID(1) });
  const refused = m.c.send('c1', { ...msg('two', UUID(2)), attachments: [{ kind: 'audio', name: 'a' }] }, 1);
  assert.equal(refused.action, 'failed');
  assert.match(refused.error, /images, files, folders and selected text/);
  assert.equal(m.execs.length, 0);
});

test('a Plan message for a chat that runs here is kept for the move, not refused as a machine would refuse it', async (t) => {
  const m = localChat(t);
  m.w.service.holdMove('c1');
  const receipt = await m.c.send('c1', { ...msg('plan it', UUID(1)), opts: { plan: true } }, 1, true);
  assert.equal(receipt.action, 'queued');
});

test('a start that cannot be kept for the move puts the message back in the queue with the cause; one already queued stays as it is', async () => {
  const f = setup();
  selectSegment(f.c, f.chats, 'c1', [['acp:fake', 'native']]);
  f.c.remote = {
    stop: () => null,
    owns: () => false,
    moving: () => true,
    hold: () => ({ action: 'failed', error: 'It could not be saved.' }),
  };
  const item = { id: UUID(1), text: 'x', attachments: [], opts: {} };
  const result = await f.c.startOrKeep('c1', item);
  assert.deepEqual([result.started, result.error], [false, 'It could not be saved.']);
  assert.deepEqual(
    f.state.get('c1').queue.map((q: any) => q.id),
    [UUID(1)],
  );
  await f.c.startOrKeep('c1', item);
  assert.equal(f.state.get('c1').queue.length, 1, 'not queued twice');
  assert.equal(f.execs.length, 0);
});

test("another session's message during a move that cannot be kept is told so, not started", async () => {
  const f = setup();
  selectSegment(f.c, f.chats, 'c1', [['acp:fake', 'native']]);
  f.c.remote = {
    stop: () => null,
    owns: () => false,
    moving: () => true,
    hold: () => ({ action: 'failed', error: 'It could not be saved.' }),
  };
  const result = await f.c.deliverFamily('c1', { id: UUID(8), text: 'brief', attachments: [], opts: {}, sideSession: { id: 'x' } });
  assert.deepEqual([result.started, result.error], [false, 'It could not be saved.']);
  assert.equal(f.execs.length, 0);
});

/** A chat that runs here with two messages kept for a move and a controller that takes its time. */
async function keptTwo(t: any) {
  const w = world(t, { epoch: 1 });
  w.service.holdMove('c1');
  w.service.hold('c1', msg('one', UUID(1)), 1);
  w.service.hold('c1', msg('two', UUID(2)), 1);
  let open!: (v: unknown) => void;
  w.local.receipt = new Promise((r) => (open = r));
  return { w, open: () => open({ action: 'started' }) };
}

test('two releases of the same chat at once join one delivery: each message is handed to the controller once', async (t) => {
  const k = await keptTwo(t);
  const ended = k.w.service.endMove('c1');
  await tick();
  const joined = k.w.service.rebase('c1');
  await tick();
  assert.equal(k.w.local.sent.length, 1, 'the first message is with the controller; the second release did not start another delivery');
  k.w.local.receipt = { action: 'started' };
  k.open();
  await Promise.all([ended, joined]);
  assert.deepEqual(
    k.w.local.sent.map(([, i]: any) => i.id),
    [UUID(1), UUID(2)],
  );
});

test('a new move that starts while the kept messages are being delivered stops the delivery: the rest wait for it', async (t) => {
  const k = await keptTwo(t);
  const ended = k.w.service.endMove('c1');
  await tick();
  k.w.service.holdMove('c1');
  k.w.local.receipt = { action: 'started' };
  k.open();
  await ended;
  assert.deepEqual(
    k.w.local.sent.map(([, i]: any) => i.id),
    [UUID(1)],
  );
  assert.deepEqual(
    k.w.outboxes[0].pending('c1').map((e: any) => e.key),
    [UUID(2)],
  );
});

test('an outbox that cannot be read does not stop the hold: the problem is reported and the chat is still held', async (t) => {
  const w = world(t, { epoch: 1 });
  fs.mkdirSync(w.outboxDir, { recursive: true });
  fs.writeFileSync(path.join(w.outboxDir, `${crypto.createHash('sha256').update('c1').digest('hex')}.json`), '{ not json');
  w.service.holdMove('c1');
  assert.equal(w.service.moving('c1'), true);
  assert.ok(w.reports.length > 0, 'reported');
});

test('a dialog that never held anything has nothing to release; a plan request without fields is refused by the plan, with nothing held', async () => {
  await releasePlan('nobody');
  const held: string[] = [];
  const service: any = { moving: () => false, holdMove: (c: string) => held.push(c), endMove: async () => undefined };
  const handler = planHandler({ remote: () => service, nameOf: () => null, plan: async () => null });
  assert.equal(await handler.call({}, {}), null);
  assert.equal(await handler.call({ sender: undefined }, { chatId: 7, targetHostId: 8 }), null);
  // Host off: nothing to hold and nothing to leak
  const off = planHandler({ remote: () => null, nameOf: () => null, plan: async () => null });
  assert.equal(await off.call({}, { chatId: 'c1', targetHostId: 'x' }), null);
  assert.deepEqual(held, [''], 'one hold for the chat, however many plans asked');
  // and a continue with Host off takes no hold
  await holdMove({ chatId: 'c1', remote: () => null }).end();
});

test('host:planRelease with a malformed chat id releases nothing and answers', async () => {
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live: {}, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }) }) as any,
      allowed: () => true,
      makeRemoteSend: (() => () => null) as any,
    },
  );
  assert.deepEqual(await handlers.get('host:planRelease')({}, undefined), { value: undefined });
});
