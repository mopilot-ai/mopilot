// #5161 against the REAL continue wiring: two Hosts running the real Host protocol (tests/support/hostProcessKit.ts), the app's real `host:codePlan` then `host:continue` handlers over the real continue machine (prepare, commit, release), the real outbox and remote send service, and the real ownership file. Messages arrive while the move is held open at each request; each Host's own record of what its agent was sent is the journal. A move whose destination stops answering ends by the request timeouts and releases the held messages to the owner the chat still has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
import { CHAT, connect, key, req, world } from './support/hostServiceKit.ts';
import { msg, UUID } from './support/host/remoteSendKit.ts';
import { tick } from './support/controller/fixture.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createRemoteSend } = require('../electron/host/remoteSend.cjs');
const { createOutbox } = require('../electron/host/outbox.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

type Id = 'B' | 'C';
/** What this Host's agent was sent with this word in it: the Host's own journal of inputs. */
const got = (w: any, id: Id, word: string) => w.hosts[id].sends.filter((s: any) => s.text.includes(word)).length;

/** The app on top of the kit's real Hosts, started with the chat on `from` (moved there the way the dialog moves it). */
async function app(t: any, from: Id) {
  const clock = installFakeClock(t, 1_000_000);
  const w = world();
  // each Host's connection can be held open at a request, or stop answering (its calls end after the session's own 15 s)
  const gates = new Map<string, Promise<void>>();
  const reached = new Set<string>();
  const stalled = new Set<string>();
  /** A Host that refuses the next messages sent to it (the Host's own words), as a Codex Host that lost the moved thread does. */
  const refusing = new Map<string, { message: string; code: string; fromHost?: boolean }>();
  for (const id of ['B', 'C'] as Id[]) {
    const proto = w.hosts[id].protocol;
    const original = proto.connection;
    proto.connection = (emit: any) => {
      const conn = original(emit);
      return {
        ...conn,
        call: async (method: string, params: any) => {
          if (stalled.has(id))
            await new Promise((_, no) => clock.setTimeout(() => no(Object.assign(new Error('The machine did not answer.'), {})), 15_000));
          reached.add(`${id}:${method}`);
          await gates.get(`${id}:${method}`);
          return conn.call(method, params);
        },
      };
    };
  }
  if (from === 'C') w.ownership.set(CHAT, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: '/mac/app' });
  await w.service.run(req({ targetHostId: from }));
  // the chat is alive on its Host: one message there
  const first = await connect(w.hosts[from]);
  await first.conn.call('chat.send', { chatId: CHAT, epoch: 1, key: key(), text: 'start' });
  const queues = new Map<string, any[]>();
  const clients = new Map<string, any>();
  const hostFor = (id: string) => {
    let host = clients.get(id);
    if (host) return host;
    host = {
      state: () => 'online',
      onState: () => () => undefined,
      connect: async () => undefined,
      send: async (chatId: string, item: any, o: any) => {
        if (refusing.has(id)) throw Object.assign(new Error(refusing.get(id)!.message), refusing.get(id));
        const { conn } = await connect(w.hosts[id as Id]);
        return conn.call('chat.send', { chatId, epoch: w.ownership.get(chatId).epoch, key: o.key, text: item.text });
      },
      permit: async () => undefined,
      stop: async () => undefined,
    };
    clients.set(id, host);
    return host;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-wire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const svc = createRemoteSend({
    outbox: createOutbox({ dir: path.join(dir, 'host-outbox'), report: () => undefined }),
    ownerOf: (chatId: string) => {
      w.ownership.refresh();
      const { hostId, epoch, folder } = w.ownership.get(chatId);
      return { hostId, epoch, folder };
    },
    hostFor,
    rowOf: () => ({ status: 'online', name: 'the new machine' }),
    state: () => ({ get: (c: string) => ({ queue: queues.get(c) ?? [] }), patch: (c: string, p: any) => void queues.set(c, p.queue) }),
    tray: queueItem,
    kindOf: () => 'acp:gemini',
    checkFolder: async () => ({}),
    report: () => undefined,
  });
  t.after(() => svc.dispose());
  const live: any = {
    hostContinue: (r: any) => w.service.run(r),
    hostCodePlan: (r: any) => w.service.codePlan(r),
    controller: { state: {} },
  };
  const handlers = new Map<string, any>();
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => '/nowhere' }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({ list: () => ({ machines: [], resolved: true }), row: () => ({ name: 'the new machine' }) }) as any,
      allowed: () => true,
      makeRemoteSend: (() => () => svc) as any,
    },
  );
  const call = (c: string, ...a: any[]) => handlers.get(c)({}, ...a);
  const until = async (id: string) => {
    await waitFor(() => reached.has(id), `the move reaching ${id}`);
  };
  return { w, svc, call, gates, reached, stalled, refusing, queues, clock, until };
}

const hold = () => {
  let open!: () => void;
  return { promise: new Promise<void>((r) => (open = r)), open };
};

for (const [from, to] of [
  ['B', 'C'],
  ['C', 'B'],
] as [Id, Id][])
  for (const at of ['prepareContinue', 'commitContinue'])
    test(`${from} -> ${to} through the real continue: messages sent while it waits at ${at} (Enter and the phone's enqueue) reach ${to} once and ${from} never`, async (t) => {
      const a = await app(t, from);
      const gate = hold();
      a.gates.set(`${at === 'prepareContinue' ? to : from}:chat.${at}`, gate.promise);
      // the app's real order: the dialog's plan, then the continue
      assert.deepEqual(await a.call('host:codePlan', { ...req({ targetHostId: to }) }), { value: null });
      const moving = a.call('host:continue', req({ targetHostId: to }));
      await a.until(`${at === 'prepareContinue' ? to : from}:chat.${at}`);
      const before = a.w.hosts[from].sends.length;
      assert.equal((await a.svc.send(CHAT, msg('enter-word', UUID(1)), 1)).action, 'queued');
      assert.equal(a.svc.enqueue(CHAT, msg('phone-word', UUID(2)), null).action, 'queued');
      for (let i = 0; i < 20; i++) await tick();
      assert.equal(a.w.hosts[from].sends.length, before, 'the Host the chat is leaving is sent nothing while the move is under way');
      assert.equal(got(a.w, to, 'enter-word') + got(a.w, to, 'phone-word'), 0);
      assert.deepEqual(
        a.queues.get(CHAT)?.map((q: any) => q.waitingFor),
        ['hostMoving', 'hostMoving'],
      );
      gate.open();
      const answer = await moving;
      assert.deepEqual(answer, { value: { hostId: to, epoch: 2 } });
      for (let i = 0; i < 40; i++) await tick();
      for (const word of ['enter-word', 'phone-word']) assert.deepEqual([got(a.w, to, word), got(a.w, from, word)], [1, 0], word);
    });

test('the destination stops answering: nothing is sent to the source while the move waits, it ends by the request timeout with the real cause, and each message then goes to the source once', async (t) => {
  const a = await app(t, 'B');
  a.stalled.add('C');
  assert.deepEqual(await a.call('host:codePlan', { ...req({ targetHostId: 'C' }) }), { value: null });
  const moving = a.call('host:continue', req({ targetHostId: 'C' }));
  for (let i = 0; i < 20; i++) await tick();
  await a.svc.send(CHAT, msg('enter-word', UUID(1)), 1);
  a.svc.enqueue(CHAT, msg('phone-word', UUID(2)), null);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(got(a.w, 'B', 'enter-word') + got(a.w, 'B', 'phone-word'), 0, 'the source is sent nothing while the move waits');
  a.clock.advance(15_000);
  const answer = await moving;
  assert.match(answer.error?.message ?? '', /did not answer/, 'the person is told why');
  assert.equal(a.w.ownership.get(CHAT).hostId, 'B', 'the chat did not move');
  for (let i = 0; i < 40; i++) await tick();
  for (const word of ['enter-word', 'phone-word']) assert.deepEqual([got(a.w, 'B', word), got(a.w, 'C', word)], [1, 0], word);
});

test('a message sent between the plan and the continue, and one sent once the continue runs, are held: the continue may come much later, and neither runs on the leaving Host', async (t) => {
  const a = await app(t, 'B');
  assert.deepEqual(await a.call('host:codePlan', { ...req({ targetHostId: 'C' }) }), { value: null });
  a.clock.advance(60 * 60_000);
  await tick();
  await a.svc.send(CHAT, msg('gap-word', UUID(2)), 1);
  assert.equal(got(a.w, 'B', 'gap-word'), 0, 'held between the plan and the continue');
  const gate = hold();
  a.gates.set('B:chat.commitContinue', gate.promise);
  const moving = a.call('host:continue', req({ targetHostId: 'C' }));
  await a.until('B:chat.commitContinue');
  const before = a.w.hosts.B.sends.length;
  await a.svc.send(CHAT, msg('late-word', UUID(1)), 1);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(a.w.hosts.B.sends.length, before, 'held while the move runs');
  gate.open();
  await moving;
  for (let i = 0; i < 40; i++) await tick();
  for (const word of ['late-word', 'gap-word']) assert.deepEqual([got(a.w, 'C', word), got(a.w, 'B', word)], [1, 0], word);
});

test(`the destination Host refuses the held message after the move (a Codex Host that lost the moved thread): it is not lost or dropped, the row keeps the Host's own words with Retry, and Retry sends it exactly once when the Host takes it`, async (t) => {
  const a = await app(t, 'B');
  a.refusing.set('C', { message: 'no rollout found for thread id f7f15bf8', code: 'thread_lost', fromHost: true });
  const gate = hold();
  a.gates.set('B:chat.commitContinue', gate.promise);
  const moving = a.call('host:continue', req({ targetHostId: 'C' }));
  await a.until('B:chat.commitContinue');
  await a.svc.send(CHAT, msg('enter-word', UUID(1)), 1);
  gate.open();
  await moving;
  for (let i = 0; i < 40; i++) await tick();
  const row = a.queues.get(CHAT)?.[0];
  assert.equal(row?.waitingFor, 'hostRefused');
  assert.match(row?.error ?? '', /no rollout found/);
  assert.deepEqual([got(a.w, 'C', 'enter-word'), got(a.w, 'B', 'enter-word')], [0, 0], 'nothing ran anywhere, and nothing was dropped');
  a.refusing.delete('C');
  assert.equal((await a.svc.sendNow(CHAT, UUID(1)))?.status, 'sent');
  for (let i = 0; i < 40; i++) await tick();
  assert.deepEqual([got(a.w, 'C', 'enter-word'), got(a.w, 'B', 'enter-word')], [1, 0]);
  assert.deepEqual(
    a.queues.get(CHAT)?.filter((q: any) => q.waitingFor),
    [],
  );
});

test('the destination stops answering after the move landed: the held message stays queued (nothing is dropped) and goes to the destination once when it answers again', async (t) => {
  const a = await app(t, 'B');
  const gate = hold();
  a.gates.set('B:chat.commitContinue', gate.promise);
  const moving = a.call('host:continue', req({ targetHostId: 'C' }));
  await a.until('B:chat.commitContinue');
  await a.svc.send(CHAT, msg('enter-word', UUID(1)), 1);
  a.refusing.set('C', { message: 'The host is unreachable: The host stopped answering.', code: 'host_unreachable' });
  gate.open();
  await moving;
  for (let i = 0; i < 40; i++) await tick();
  assert.deepEqual([got(a.w, 'C', 'enter-word'), got(a.w, 'B', 'enter-word')], [0, 0]);
  a.refusing.delete('C');
  await a.svc.resume();
  for (let i = 0; i < 40; i++) await tick();
  assert.equal(
    got(a.w, 'C', 'enter-word') + got(a.w, 'B', 'enter-word'),
    1,
    'delivered exactly once, to the destination if its refusal was lifted',
  );
});
