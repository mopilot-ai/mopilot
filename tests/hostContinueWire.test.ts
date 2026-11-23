// A chat continued from Host A to Host B and back over the real protocol and the real remote proxy (3.1 wiring): each Host runs createProtocol with its continue Host, the app's channel is createRemoteHost, only the sockets, the ACP runtime and the clock are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createProtocol, wireError } from '../host/src/protocol.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
import { FakeNet, hostWorld, tick, type FakeSocket } from './support/host-wire-kit.ts';
import { makeApp } from './support/hostContinueKit.ts';
import { makeHostProcess } from './support/hostProcessKit.ts';

const CHAT = 'claude:c1';
const quiet = { report: () => undefined };

/** Sockets whose far end is a Host process's protocol. */
class ProtocolNet extends FakeNet {
  conns = new Map<FakeSocket, any>();
  protocol: any;
  constructor(protocol: any) {
    super();
    this.protocol = protocol;
  }
  override onRequest(socket: FakeSocket, req: any) {
    if (this.mode !== 'host') return;
    if (req.method === 'ping') return socket.feed({ id: req.id, result: 'pong' });
    let conn = this.conns.get(socket);
    if (!conn) this.conns.set(socket, (conn = this.protocol.connection((m: object) => socket.feed(m))));
    conn.call(req.method, req.params).then(
      (result: unknown) => socket.feed({ id: req.id, result }),
      (e: unknown) => socket.feed({ id: req.id, ...wireError(e) }),
    );
  }
}

async function world(t: { after: (fn: () => void) => void }) {
  const w = hostWorld(t);
  const hosts = { A: makeHostProcess('A'), B: makeHostProcess('B') } as Record<string, ReturnType<typeof makeHostProcess>>;
  const app = makeApp({ channel: () => ({ call: async () => null }), down: new Set() } as any);
  app.ownership.set(CHAT, { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: '/work/a' });
  const proxies: Record<string, any> = {};
  const online = new Set(['A', 'B']);
  const connectTo = async (id: string, opts: object = {}) => {
    const tun = w.tunnel();
    const host = w.remote(tun, {
      id,
      connect: new ProtocolNet(hosts[id].protocol).connect,
      epochOf: (chatId: string) => app.ownership.get(chatId).epoch,
      movedOf: () => app.machine.movedFrom(id),
      onHello: (r: unknown) => void app.machine.sourceReturned(id, r),
      ...opts,
    });
    const up = host.connect();
    await tick();
    await up;
    proxies[id] = host;
    online.add(id);
    return host;
  };
  await connectTo('A');
  await connectTo('B');
  // the app's machine, over the proxies
  const { createRequire } = await import('node:module');
  const { createContinueMachine } = createRequire(import.meta.url)('../electron/host/continue.cjs');
  const merged: any[] = [];
  const tails: Record<string, any[]> = {};
  const machine = createContinueMachine({
    ownership: app.ownership,
    hostState: (id: string) => (online.has(id) ? 'online' : 'offline'),
    channel: (id: string) => ({ call: (m: string, p: object) => proxies[id].call(m, p) }),
    confirmLostHost: async () => true,
    mirrorRev: () => 7,
    newKey: (() => {
      let n = 0;
      return () => `wire-key-${String(++n).padStart(6, '0')}`;
    })(),
    fetchTail: async ({ hostId, chatId, fromRev }: any) => (tails[`${hostId}|${chatId}`] ?? []).filter((i) => i.rev > fromRev),
    mergeTail: async (a: any) => void merged.push(a),
    report: (p: string) => app.reports.push(p),
    sleep: async () => undefined,
  });
  // the proxies' hello callbacks and the app's side map now talk to this machine
  app.machine = machine;
  return { w, hosts, app, proxies, online, connectTo, machine, merged, tails };
}
const req = (over: object = {}) => ({
  chatId: CHAT,
  targetHostId: 'B',
  harness: 'acp:gemini',
  cwd: '/work/b',
  handoff: 'the conversation so far',
  ...over,
});
const code = (c: string) => (e: any) => e?.code === c;

test('A to B and back: the target gets the handoff once, with the first message, in the new folder; the old owner refuses and says where the chat went', async (t) => {
  const s = await world(t);
  await s.proxies.A.send(CHAT, { text: 'first on A' });
  assert.equal(s.hosts.A.sends[0].text, 'first on A');

  const got = await s.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch, got.activated, got.released], ['B', 1, true, true]);
  assert.equal(s.app.ownership.get(CHAT).epoch, 1);
  // A is read-only and says who owns the chat; a stale writer at the old epoch learns the same
  await assert.rejects(
    s.proxies.A.send(CHAT, { text: 'late' }),
    (e: any) => e.code === 'chat_released' && e.details.targetHostId === 'B' && e.details.epoch === 1,
  );
  assert.equal(s.hosts.A.sends.length, 1);
  assert.equal(s.hosts.A.acp.chats.has(CHAT), false, 'the source let go of the chat');

  // B serves from its first message: the handoff goes in front of it once, in the folder the user picked
  await s.proxies.B.send(CHAT, { text: 'now on B' });
  await s.proxies.B.send(CHAT, { text: 'second on B' });
  assert.equal(s.hosts.B.sends[0].text, 'the conversation so far\n\nnow on B');
  assert.equal(s.hosts.B.sends[0].cwd, '/work/b');
  assert.equal(s.hosts.B.sends[1].text, 'second on B');

  const back = await s.machine.continueChat(req({ targetHostId: 'A', cwd: '/work/a', handoff: 'back to A' }));
  assert.deepEqual([back.hostId, back.epoch], ['A', 2]);
  await s.proxies.A.send(CHAT, { text: 'home again' });
  assert.equal(s.hosts.A.sends.at(-1).text, 'back to A\n\nhome again');
  await assert.rejects(s.proxies.B.send(CHAT, { text: 'too late' }), code('chat_released'));
});

test('a refusal from the target travels the wire with its code: no such agent, no such folder; the chat stays on A', async (t) => {
  const s = await world(t);
  await assert.rejects(s.machine.continueChat(req({ harness: 'codex' })), code('harness_not_configured'));
  await assert.rejects(s.machine.continueChat(req({ cwd: '/missing' })), code('not_found'));
  assert.equal(s.app.ownership.get(CHAT).ownerHostId, 'A');
  assert.equal(s.hosts.A.epochs.current(CHAT), 0);
  // a running turn on the source refuses the commit and the target drops its preparation
  s.hosts.A.acp.chats.set(CHAT, { prompting: {} });
  await assert.rejects(s.machine.continueChat(req()), code('turn_running'));
  assert.equal(s.app.ownership.get(CHAT).ownerHostId, 'A');
});

test('the source lost: the app continues on B alone; when A returns, its hello poisons A, the tail is merged read-only and the record closes', async (t) => {
  const s = await world(t);
  await s.proxies.A.send(CHAT, { text: 'first on A' });
  s.proxies.A.dispose();
  s.online.delete('A');
  const got = await s.machine.continueChat(req());
  assert.deepEqual([got.hostId, got.epoch, got.lostHost], ['B', 1, true]);
  await s.proxies.B.send(CHAT, { text: 'on B' });
  assert.equal(s.hosts.B.sends[0].text, 'the conversation so far\n\non B');

  s.tails[`A|${CHAT}`] = [{ rev: 6 }, { rev: 9 }];
  await s.connectTo('A');
  await tick();
  await tick();
  assert.equal(s.hosts.A.epochs.current(CHAT), 1);
  assert.deepEqual(
    s.merged.map((m) => m.items),
    [[{ rev: 9 }]],
  );
  assert.equal(s.app.ownership.get(CHAT).lostHost, undefined);
  await assert.rejects(
    s.connectTo('A').then((h) => h.send(CHAT, { text: 'old owner writes' })),
    code('chat_poisoned'),
  );
  assert.equal(s.hosts.A.sends.length, 1);
});

test('a Host without a continue Host refuses the methods as unsupported, and nothing it serves is gated', async (t) => {
  const w = hostWorld(t);
  const h = makeHostProcess('P');
  const bare = createProtocol({
    runtime: h.runtime,
    epochs: h.epochs,
    guard: createGuard({ epochs: h.epochs, ledger: createLedger(path.join(h.dir, 'l2'), quiet) }),
    status: () => ({}),
  });
  const host = w.remote(w.tunnel(), { connect: new ProtocolNet(bare).connect });
  const up = host.connect();
  await tick();
  await up;
  await assert.rejects(
    host.call('chat.prepareContinue', { chatId: CHAT, epoch: 1, key: 'prep-key-0001', harness: 'acp:gemini', cwd: '/w', handoff: 'x' }),
    code('unsupported'),
  );
  assert.deepEqual(await host.send(CHAT, { text: 'plain' }).then((r: any) => !!r.turnId), true);
});
