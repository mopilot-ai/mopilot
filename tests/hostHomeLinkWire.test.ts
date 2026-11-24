// MoMo's home against a REAL target Host protocol and gate over a socket standing in for the relay (host/src/momoTasks/*, host/src/homeGate.mjs, server.mjs, protocol.mjs): the owner allows the home's key, the home starts and follows a task, the target refuses what a home may not do, a stale home is refused for good, and removing the key mid-task stops the session and the connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createHomeKey } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { createHomeMachines } from '../host/src/momoTasks/homeMachines.mjs';
// @ts-ignore
import { createHomeClient } from '../host/src/momoTasks/homeClient.mjs';
// @ts-ignore
import { createRemoteMachine } from '../host/src/momoTasks/remoteMachine.mjs';
// @ts-ignore
import { homeGateFor } from '../host/src/homeGate.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

const { SealedJson } = createRequire(import.meta.url)('../electron/gateway/sealedFile.cjs');

process.env.MOPILOT_MOMO_HOST_LINK = '1';
/** The line protocol over a socket as a transport: replies matched by id, pushed events kept apart. */
const wire: string[] = [];
function socketTransport(socketPath: string) {
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  const waiting = new Map<number, (r: any) => void>();
  const listeners: ((e: any) => void)[] = [];
  const closers: (() => void)[] = [];
  let buffer = '';
  let id = 0;
  socket.on('data', (c) => {
    buffer += c;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (m.id != null && waiting.has(m.id)) (waiting.get(m.id) as any)(m);
      else listeners.forEach((fn) => fn(m));
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => closers.forEach((fn) => fn()));
  return {
    request: (method: string, params?: any) =>
      new Promise<any>((resolve, reject) => {
        const n = ++id;
        waiting.set(n, (r) => (r.error ? reject(Object.assign(new Error(r.error), { code: r.code })) : resolve(r.result)));
        wire.push(JSON.stringify({ method, params }));
        socket.write(`${JSON.stringify({ id: n, method, params })}\n`);
      }),
    onEvent: (fn: (e: any) => void) => (listeners.push(fn), () => undefined),
    onClose: (fn: () => void) => void closers.push(fn),
    close: () => socket.destroy(),
  };
}

async function world(t: any) {
  const stopped: string[] = [];
  const w = await servedHost(t, {
    homeGate: ({ pairing, paths, epochs }: any) =>
      homeGateFor({
        paths,
        pairing,
        sessions: { state: { has: () => false, get: () => ({}) } },
        policy: { modeOf: () => undefined },
        audit: { note: () => undefined },
        epochs,
        report: () => undefined,
      }),
  });
  await w.homeGate.sweep(() => true, w.protocol);
  w.runtime.host.cancel = (id: string) => void stopped.push(id);
  // the target's runtime opens a session and holds the mode it was started in
  w.runtime.prepare = async () => undefined;
  w.runtime.setMode = async () => undefined;
  const owner = await w.paired('owner', 'Mac');
  const dir = path.join(w.dir, 'home');
  const safe = { dir, safeStorage: createFileSafeStorage(path.join(dir, 'k')), now: () => 1 };
  const key = createHomeKey({ ...safe, homeId: () => 'home-a' });
  const machines = createHomeMachines(safe);
  const fingerprint = (
    await owner.conn.request('host.clientAdd', { publicKey: await key.publicKey(), kind: 'home', name: 'MoMo on Mac mini' })
  ).fingerprint;
  const machine = { id: 'm1', name: 'Studio', link: 'x', hostId: w.pairing.hostId() };
  await machines.set(machine);
  let lease = { homeId: 'home-a', leaseEpoch: 1 };
  const client = createHomeClient({
    identity: () => key.identity(),
    stamp: () => lease,
    dial: async () => socketTransport(w.paths.socketPath),
  });
  const kept = new Map<string, string>();
  const ended = new Map<string, any>();
  const emitted: any[] = [];
  const remote = createRemoteMachine({
    client,
    machines,
    keys: {
      get: (k: string) => kept.get(k) ?? null,
      set: async (k: string, c: string) => void kept.set(k, c),
      delete: async (k: string) => void kept.delete(k),
    },
    ends: { get: (c: string) => ended.get(c) ?? null, set: async (c: string, e: any) => void ended.set(c, e) },
    emit: async (m: string, c: string, e: any) => void emitted.push([m, c, e]),
    report: () => undefined,
  });
  t.after(() => client.close());
  return {
    dir,
    safe,
    w,
    owner,
    fingerprint,
    client,
    remote,
    port: remote.port(),
    stopped,
    emitted,
    setLease: (l: typeof lease) => void (lease = l),
    machine,
    machines,
  };
}
const REQ = {
  itemId: 'i1',
  machineId: 'm1',
  harness: 'claude',
  brief: 'read the repo',
  readOnly: true,
  key: 'i1:1',
  gateOrigin: 'task',
} as any;

test('the home starts a read-only task on another Host, which runs it in its own folder; a follow-up runs there too', async (t) => {
  const k = await world(t);
  const out = await k.port.start(REQ);
  assert.equal(out.ok, true, JSON.stringify(out));
  const first = k.w.sends[0];
  assert.equal(first.text, 'read the repo');
  assert.ok(first.cwd.startsWith(`${k.w.dir}-momo-tasks`), "the folder is the target's own");
  // a follow-up goes to the same session, in the same folder
  await k.client.call(k.machine, 'chat.send', { chatId: first.key, epoch: 1, key: 'key-00000077', text: 'and the tests', cwd: '/etc' });
  assert.equal(k.w.sends[1].cwd, first.cwd);
  assert.ok(await k.client.call(k.machine, 'host.status', {}));
  // the home's private key is in none of what crossed the wire, nor in the sealed file in the clear
  const sealedKey = new SealedJson({
    file: path.join(k.dir, 'home-key.json'),
    safeStorage: k.safe.safeStorage,
    shape: (v: any) => v,
    now: () => 1,
  }).read();
  assert.ok(sealedKey.privateKey);
  assert.equal(wire.join('').includes(sealedKey.privateKey), false);
  assert.equal(fs.readFileSync(path.join(k.dir, 'home-key.json'), 'utf8').includes(sealedKey.privateKey), false);
  // the session's end reaches the home as an event, read the same way as a local one
  k.w.runtime.host.emit('event', { kind: 'turnStart', key: first.key, turnId: 't2' });
  k.w.runtime.host.emit('event', {
    kind: 'update',
    key: first.key,
    turnId: 't2',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Result: read it.' } },
  });
  k.w.runtime.host.emit('event', { kind: 'turnEnd', key: first.key, turnId: 't2', stopReason: 'end_turn' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    k.emitted.map((e) => e[2].kind),
    ['finished'],
  );
});

test('the target refuses a home that asks for more: another chat, an approval answer, the client table, files', async (t) => {
  const k = await world(t);
  for (const [method, params] of [
    ['chat.send', { chatId: 'claude:not-mine', epoch: 1, key: 'key-00000001', text: 'x' }],
    ['chat.answer', { chatId: 'claude:not-mine', epoch: 1, key: 'key-00000002', requestId: 'r', optionId: 'o' }],
    ['host.clients', {}],
    ['host.clientAdd', { publicKey: 'x', kind: 'desktop' }],
    ['fs.list', {}],
  ] as const)
    await assert.rejects(
      k.client.call(k.machine, method, params as any),
      (e: any) => e.code === 'home_not_allowed' || e.code === 'machine_not_allowed',
      method,
    );
  // a start with Full access is refused whatever this machine's own default is
  await assert.rejects(
    k.client.call(k.machine, 'chat.start', {
      chatId: 'claude:x1',
      epoch: 1,
      key: 'key-00000003',
      text: 'x',
      harness: 'claude',
      permission: 'full-access',
    }),
    (e: any) => e.code === 'home_mode_refused',
  );
  assert.equal(k.w.sends.length, 0);
});

test('a home from an older lease is refused for good, also by a new connection', async (t) => {
  const k = await world(t);
  k.setLease({ homeId: 'home-b', leaseEpoch: 4 });
  await k.client.call(k.machine, 'host.status', {});
  await k.client.close();
  k.setLease({ homeId: 'home-a', leaseEpoch: 3 });
  await assert.rejects(k.client.call(k.machine, 'host.status', {}), (e: any) => e.code === 'home_lease_stale');
});

test("removing the home's key mid-task stops its session, cuts the connection, and the machine says MoMo is not allowed", async (t) => {
  const k = await world(t);
  assert.equal((await k.port.start(REQ)).ok, true);
  const chatId = k.w.sends[0].key;
  assert.deepEqual(await k.owner.conn.request('host.clientRemove', { fingerprint: k.fingerprint }), { removed: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(k.stopped, [chatId]);
  await k.client.close();
  await assert.rejects(k.client.call(k.machine, 'host.status', {}), (e: any) => e.code === 'machine_not_allowed');
  assert.deepEqual(await k.port.probe('m1', chatId), { state: 'gone' });
});
